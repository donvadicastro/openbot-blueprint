import { ProductError, type ProductQuery } from './access.js';
import { resolvePhaseActivity, type PhaseRequest } from './phase-activity.js';
import { contentDigest, type JsonValue } from './store.js';
import { requireQaOutput } from './swe-qa.js';

/** Revalidate release inputs against the exact accepted QA attempt and current source. */
export async function requireReleaseInputs(tx: ProductQuery, request: PhaseRequest) {
  const phase = await resolvePhaseActivity(tx, request);
  const invalid = () => new ProductError(409, 'release_evidence_unavailable', 'The current candidate, passing QA evidence and release inputs must be verified before release preparation.');
  if (phase.definition.projectType !== 'software-development' || !['prepare-release', 'deploy'].includes(phase.actionId)) throw invalid();
  const types = ['candidate', 'qa-evidence', 'release-runbook', 'release-target'];
  const refs = new Map(phase.inputRevisions.map(item => [item.type, item.revisionId]));
  if (types.some(type => !refs.get(type))) throw invalid();
  const records = await tx.unsafe<{ type: string; id: string; digest: string; payload: Record<string, JsonValue> }>(`
    select a.type_key as type,r.id,r.digest,r.payload from bp_artifacts a
    join bp_artifact_revisions r on (r.project_id,r.artifact_id)=(a.project_id,a.id)
    where a.project_id=$1 and r.id in (select jsonb_array_elements_text($2::text::jsonb)) and a.status='supplied'
      and (a.allowed_user_ids is null or $3=any(a.allowed_user_ids)) for share of a,r`,
  [request.projectId,JSON.stringify(types.map(type => refs.get(type))),phase.actorId]);
  if (records.length !== types.length || records.some(row => !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload) || contentDigest(row.payload) !== row.digest)) throw invalid();
  const get = (type: string) => records.find(row => row.type === type && row.id === refs.get(type));
  const candidate = get('candidate'), report = get('qa-evidence'), runbook = get('release-runbook'), target = get('release-target');
  if (!candidate || !report || !runbook || !target || typeof candidate.payload.revision !== 'string' || !/^[a-f0-9]{40,64}$/.test(candidate.payload.revision) ||
      typeof candidate.payload.sourceRevision !== 'string' || typeof candidate.payload.briefRevision !== 'string' ||
      report.payload.verdict !== 'passed' || report.payload.passPercentage !== 100 || report.payload.candidateRevision !== candidate.id ||
      report.payload.briefRevision !== candidate.payload.briefRevision || typeof report.payload.planRevision !== 'string' ||
      typeof runbook.payload.procedure !== 'string' || !runbook.payload.procedure.trim() ||
      typeof target.payload.url !== 'string' || !target.payload.url.trim()) throw invalid();
  const [vm] = await tx.unsafe<{ sourceRevision: string | null }>(`select source_revision as "sourceRevision" from bp_project_vms
    where project_id=$1 and state='Ready' for share`, [request.projectId]);
  if (!vm?.sourceRevision || vm.sourceRevision !== candidate.payload.sourceRevision) throw invalid();
  const [brief] = await tx.unsafe<{ id: string; digest: string; payload: JsonValue }>(`select r.id,r.digest,r.payload from bp_artifacts a
    join bp_artifact_revisions r on (r.project_id,r.artifact_id)=(a.project_id,a.id)
    where a.project_id=$1 and a.type_key='change-brief' and r.id=$2 and a.status='supplied'
      and (a.allowed_user_ids is null or $3=any(a.allowed_user_ids))
      and not exists (select 1 from bp_artifact_revisions newer where newer.project_id=r.project_id and newer.artifact_id=r.artifact_id
        and (newer.created_at,newer.id)>(r.created_at,r.id)) for share of a,r`, [request.projectId,candidate.payload.briefRevision,phase.actorId]);
  if (!brief || contentDigest(brief.payload) !== brief.digest) throw invalid();
  const accepted = await tx.unsafe<{ occurrenceId: string; attempt: number; inputRevisions: { type: string; revisionId: string }[]; result: JsonValue; digest: string }>(`
    select o.id as "occurrenceId",a.attempt,a.input_revisions as "inputRevisions",result.result,result.result_digest as digest
    from bp_phase_results result join bp_phase_occurrences o on (o.project_id,o.run_id,o.id)=(result.project_id,result.run_id,result.occurrence_id)
    join bp_action_attempts a on (a.project_id,a.run_id,a.occurrence_id,a.attempt)=(result.project_id,result.run_id,result.occurrence_id,result.attempt)
    where result.project_id=$1 and result.run_id=$2 and o.action_key='verify' and result.result->>'status'='succeeded'
      and exists (select 1 from jsonb_array_elements(result.result->'outputs') output
        where output->>'type'='qa-evidence' and output->>'revisionId'=$3) for share of result,o,a`, [request.projectId,request.runId,report.id]);
  if (accepted.length !== 1 || contentDigest(accepted[0].result) !== accepted[0].digest) throw invalid();
  try { await requireQaOutput(tx, request, { actorId: phase.actorId, ...accepted[0] }, 'qa-evidence', report.payload); }
  catch { throw invalid(); }
  return { candidateRevision: candidate.id, candidateCommit: candidate.payload.revision, sourceRevision: vm.sourceRevision,
    briefRevision: brief.id, planRevision: report.payload.planRevision, qaEvidenceRevision: report.id,
    runbookRevision: runbook.id, targetRevision: target.id, target: target.payload.url };
}
