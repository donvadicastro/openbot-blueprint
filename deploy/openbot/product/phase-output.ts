import { createHash } from "node:crypto";
import { ProductError, type ProductQuery } from "./access.js";
import { contentDigest, type JsonValue } from "./store.js";
import { validateSchema, type Schema } from "./contract/schema.js";
import { resolvePhaseActivity, type PhaseRequest } from "./phase-activity.js";
import { requireCandidateProvenance } from "./swe-candidate.js";
import { requireQaOutput } from "./swe-qa.js";
import { requireChangeBrief } from "./swe-brief.js";
import { requireDeploymentOutput } from "./release-effect.js";

/** Called by a trusted phase runner inside a transaction, never with bot-selected identities. */
export async function savePhaseOutput(tx: ProductQuery, request: PhaseRequest, typeKey: string, payload: Record<string, JsonValue>) {
  if (typeof typeKey !== 'string' || !typeKey || typeKey.length > 200 || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProductError(422, 'invalid_output', 'A typed output object is required.');
  }
  await tx.unsafe('select id from bp_workflow_runs where project_id=$1 and id=$2 for update', [request.projectId, request.runId]);
  const phase = await resolvePhaseActivity(tx, request);
  const [receipt] = await tx.unsafe<{ requestDigest: string; state: string }>(`select request_digest as "requestDigest",state
    from bp_phase_activity_receipts where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 for update`,
  [request.projectId, request.runId, phase.occurrenceId, phase.attempt]);
  if (!receipt || receipt.state !== 'Running' || receipt.requestDigest !== contentDigest(request as unknown as JsonValue)) {
    throw new ProductError(409, 'phase_unavailable', 'The active phase claim could not be verified.');
  }
  const artifact = phase.definition.business?.artifactTypes.find(item => item.id === typeKey);
  if (!artifact || !phase.action.outputTypes.includes(typeKey) || !artifact.producers.includes(phase.role.id)) {
    throw new ProductError(403, 'output_denied', 'This specialist cannot produce that output for this action.');
  }
  if (validateSchema(payload, artifact.schema as Schema).length) throw new ProductError(422, 'invalid_output', 'The output does not match the declared schema.');
  if (phase.definition.projectType === 'software-development' && typeKey === 'change-brief') requireChangeBrief(payload);
  if (phase.definition.projectType === 'software-development' && typeKey === 'candidate') {
    await requireCandidateProvenance(tx, request, phase, payload);
  }
  if (phase.definition.projectType === 'software-development' && (typeKey === 'test-plan' || typeKey === 'qa-evidence')) {
    await requireQaOutput(tx, request, phase, typeKey, payload);
  }
  if (phase.definition.projectType === 'software-development' && typeKey === 'deployment-evidence') await requireDeploymentOutput(tx, request, payload);
  const id = createHash('sha256').update(JSON.stringify([request.projectId, request.runId, phase.occurrenceId, typeKey])).digest('hex');
  const digest = contentDigest(payload);
  const revisionId = createHash('sha256').update(JSON.stringify([id, digest])).digest('hex');
  const [existing] = await tx.unsafe<{ id: string; digest: string }>(`select r.id,r.digest from bp_artifacts a
    join bp_artifact_revisions r on r.project_id=a.project_id and r.artifact_id=a.id
    where a.project_id=$1 and a.id=$2 for share of a,r`, [request.projectId, id]);
  if (existing) {
    if (existing.digest !== digest) throw new ProductError(409, 'output_conflict', 'This phase output was already recorded with different content.');
    return { artifactId: id, revisionId: existing.id, type: typeKey };
  }
  await tx.unsafe(`insert into bp_artifacts(project_id,id,type_key,owner_assignment_id,source,status)
    values($1,$2,$3,$4,'{}'::jsonb,'supplied')`, [request.projectId, id, typeKey, phase.assignmentId]);
  await tx.unsafe(`insert into bp_artifact_revisions(project_id,artifact_id,id,digest,payload,created_by)
    values($1,$2,$3,$4,$5::text::jsonb,$6)`, [request.projectId, id, revisionId, digest, JSON.stringify(payload), phase.actorId]);
  return { artifactId: id, revisionId, type: typeKey };
}
