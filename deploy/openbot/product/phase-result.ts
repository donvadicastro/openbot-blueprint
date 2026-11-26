import { createHash } from "node:crypto";
import { ProductError, type ProductQuery } from "./access.js";
import { validateActionResult, type ActionResult } from "./actions.js";
import { contentDigest, roleMayReadArtifact, type JsonValue } from "./store.js";
import { resolvePhaseActivity, type PhaseRequest } from "./phase-activity.js";
import type { ProductModule } from "./module.js";
import { verifyCandidateHead } from "./swe-candidate.js";

/** Accept only a result from a trusted runner; this function does not advance the workflow. */
export async function recordPhaseResult(tx: ProductQuery, request: PhaseRequest, result: ActionResult, module?: ProductModule) {
  await tx.unsafe('select id from bp_workflow_runs where project_id=$1 and id=$2 for update', [request.projectId, request.runId]);
  const phase = await resolvePhaseActivity(tx, request);
  const [receipt] = await tx.unsafe<{ requestDigest: string; state: string }>(`select request_digest as "requestDigest",state
    from bp_phase_activity_receipts where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 for update`,
  [request.projectId, request.runId, phase.occurrenceId, phase.attempt]);
  if (!receipt || receipt.state !== 'Running' || receipt.requestDigest !== contentDigest(request as unknown as JsonValue)) {
    throw new ProductError(409, 'phase_unavailable', 'The active phase claim could not be verified.');
  }
  if (!result || !Array.isArray(result.outputs) || result.outputs.length > 100 || !result.evidence ||
      typeof result.evidence !== 'object' || Array.isArray(result.evidence) || Object.keys(result.evidence).length > 100) {
    throw new ProductError(422, 'invalid_action_result', 'A bounded structured action result is required.');
  }
  const refs = [...new Set([...result.outputs.map(item => item?.revisionId), ...Object.values(result.evidence)])];
  if (refs.some(ref => typeof ref !== 'string' || !ref || ref.length > 200)) {
    throw new ProductError(422, 'invalid_action_result', 'The result contains an invalid evidence reference.');
  }
  const revisions = await tx.unsafe<{ id: string; artifactId: string; type: string; digest: string; payload: Record<string, JsonValue> }>(`
    select r.id,a.id as "artifactId",a.type_key as type,r.digest,r.payload
    from bp_artifacts a join bp_artifact_revisions r on r.project_id=a.project_id and r.artifact_id=a.id
    where a.project_id=$1 and r.id in (select jsonb_array_elements_text($2::text::jsonb)) and a.status='supplied'
      and (a.allowed_user_ids is null or $3=any(a.allowed_user_ids)) for share of a,r`,
  [request.projectId, JSON.stringify(refs), phase.actorId]);
  const authorized = new Map<string, string>(), evidence = new Set<string>();
  for (const revision of revisions) {
    const type = phase.definition.business?.artifactTypes.find(item => item.id === revision.type);
    if (!roleMayReadArtifact(type, phase.role.id) || revision.digest !== contentDigest(revision.payload)) continue;
    // A revision ID must resolve uniquely within the project, even if two
    // artifacts happen to contain the same data.
    if (revisions.filter(item => item.id === revision.id).length !== 1) continue;
    evidence.add(revision.id);
    const expectedArtifact = createHash('sha256').update(JSON.stringify([request.projectId, request.runId, phase.occurrenceId, revision.type])).digest('hex');
    if (revision.artifactId === expectedArtifact && type?.producers.includes(phase.role.id)) authorized.set(revision.id, revision.type);
  }
  if (new Set(result.outputs.map(item => item?.type)).size !== result.outputs.length) {
    throw new ProductError(422, 'invalid_action_result', 'Each output type must identify one revision.');
  }
  validateActionResult(phase.action, { projectId: request.projectId, runId: request.runId, occurrenceId: phase.occurrenceId,
    assignmentId: phase.assignmentId, actionId: phase.actionId, attempt: phase.attempt, runRevision: phase.runRevision }, result, authorized, evidence);
  if (phase.definition.projectType === 'software-development' && result.outputs.some(output => output.type === 'candidate')) {
    const candidate = revisions.find(item => item.type === 'candidate' && result.outputs.some(output => output.type === 'candidate' && output.revisionId === item.id));
    if (!module || !candidate) throw new ProductError(409, 'candidate_unverified', 'The candidate workspace cannot be verified.');
    await verifyCandidateHead(module, tx, request, phase, candidate.payload);
  }
  const digest = contentDigest(result as unknown as JsonValue);
  const [existing] = await tx.unsafe<{ digest: string }>(`select result_digest as digest from bp_phase_results
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 for share`,
  [request.projectId, request.runId, phase.occurrenceId, phase.attempt]);
  if (existing) {
    if (existing.digest !== digest) throw new ProductError(409, 'result_conflict', 'A different result was already accepted for this attempt.');
    return { accepted: true, replayed: true };
  }
  await tx.unsafe(`insert into bp_phase_results(project_id,run_id,occurrence_id,attempt,result_digest,result)
    values($1,$2,$3,$4,$5,$6::text::jsonb)`,
  [request.projectId, request.runId, phase.occurrenceId, phase.attempt, digest, JSON.stringify(result)]);
  return { accepted: true, replayed: false };
}
