import { randomUUID } from 'node:crypto';
import { ProductError, type ProductQuery } from './access.js';
import { contentDigest, type JsonValue } from './store.js';
import type { PhaseRequest, resolvePhaseActivity } from './phase-activity.js';
import { requireReleaseInputs } from './release-preflight.js';

/** Persist the exact reviewed release inputs and its human decision together. */
export async function prepareReleaseDecision(tx: ProductQuery, request: PhaseRequest,
  phase: Awaited<ReturnType<typeof resolvePhaseActivity>>, resultDigest: string) {
  const binding = await requireReleaseInputs(tx, request);
  if (binding.target.length > 2000 || /[\r\n]/.test(binding.target)) throw new ProductError(409, 'release_target_invalid', 'The release target must be a single, bounded value.');
  const [existing] = await tx.unsafe<{ decisionId: string; question: string; state: string; evidence: JsonValue; resultDigest: string }>(`
    select d.id as "decisionId",d.question,d.state,p.evidence,b.result_digest as "resultDigest"
    from bp_phase_decision_bindings b join bp_workflow_decisions d on (d.project_id,d.run_id,d.id)=(b.project_id,b.run_id,b.decision_id)
    join bp_release_decision_bindings r on (r.project_id,r.run_id,r.decision_id)=(d.project_id,d.run_id,d.id)
    join bp_release_proposals p on (p.project_id,p.run_id,p.id)=(r.project_id,r.run_id,r.proposal_id)
    where b.project_id=$1 and b.run_id=$2 and b.occurrence_id=$3 and b.attempt=$4 for share of b,d,r,p`,
  [request.projectId,request.runId,phase.occurrenceId,phase.attempt]);
  if (existing) {
    if (existing.resultDigest !== resultDigest || contentDigest(existing.evidence) !== contentDigest(binding as unknown as JsonValue)) throw new ProductError(409, 'release_evidence_unavailable', 'The reviewed release inputs have changed.');
    if (existing.state !== 'Pending') throw new ProductError(409, 'release_decision_unavailable', 'The release decision has already been answered.');
    return { kind: 'wait' as const, decisionId: existing.decisionId, question: existing.question };
  }
  const [candidate] = await tx.unsafe<{ artifactId: string }>('select artifact_id as "artifactId" from bp_artifact_revisions where project_id=$1 and id=$2 for share', [request.projectId,binding.candidateRevision]);
  if (!candidate) throw new ProductError(409, 'release_evidence_unavailable', 'The release candidate is unavailable.');
  const proposalId = randomUUID(), decisionId = randomUUID();
  const question = `Approve release of candidate ${binding.candidateCommit} to ${binding.target}? Passing QA evidence: ${binding.qaEvidenceRevision}. Only the configured staging target can be deployed.`;
  await tx.unsafe(`insert into bp_release_proposals(project_id,run_id,id,candidate_artifact_id,candidate_revision_id,target,evidence,state)
    values($1,$2,$3,$4,$5,$6,$7::text::jsonb,'Pending')`, [request.projectId,request.runId,proposalId,candidate.artifactId,binding.candidateRevision,binding.target,JSON.stringify(binding)]);
  await tx.unsafe("insert into bp_workflow_decisions(project_id,run_id,id,question,state) values($1,$2,$3,$4,'Pending')", [request.projectId,request.runId,decisionId,question]);
  await tx.unsafe(`insert into bp_phase_decision_bindings(project_id,run_id,occurrence_id,attempt,decision_id,result_digest,choices)
    values($1,$2,$3,$4,$5,$6,$7::text::jsonb)`, [request.projectId,request.runId,phase.occurrenceId,phase.attempt,decisionId,resultDigest,JSON.stringify(['approve','reject'])]);
  await tx.unsafe('insert into bp_release_decision_bindings(project_id,run_id,decision_id,proposal_id) values($1,$2,$3,$4)', [request.projectId,request.runId,decisionId,proposalId]);
  return { kind: 'wait' as const, decisionId, question };
}
