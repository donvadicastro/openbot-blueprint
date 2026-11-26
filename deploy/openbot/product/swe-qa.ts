import { createHash } from 'node:crypto';
import { ProductError, type ProductQuery } from './access.js';
import { contentDigest, type JsonValue } from './store.js';
import { validateQaReport } from './qa.js';
import type { PhaseRequest } from './phase-activity.js';

type Context = { actorId: string; occurrenceId: string; attempt: number; inputRevisions: { type: string; revisionId: string }[] };

/** Validate QA records against the exact candidate, brief, plan and provider evidence. */
export async function requireQaOutput(tx: ProductQuery, request: PhaseRequest, phase: Context,
  type: 'test-plan' | 'qa-evidence', payload: Record<string, JsonValue>) {
  const invalid = (message = 'QA output must match the assigned candidate, scenarios and workspace evidence.') => new ProductError(409, 'qa_evidence_unverified', message);
  const candidate = phase.inputRevisions.find(item => item.type === 'candidate');
  const brief = phase.inputRevisions.find(item => item.type === 'change-brief');
  if (!candidate || !brief || payload.candidateRevision !== candidate.revisionId || payload.briefRevision !== brief.revisionId) {
    throw invalid('Use the candidate and change-brief input revision IDs for candidateRevision and briefRevision; candidateRevision is not the Git commit.');
  }
  const [briefRecord] = await tx.unsafe<{ payload: Record<string, JsonValue>; digest: string }>(`
    select r.payload,r.digest from bp_artifacts a join bp_artifact_revisions r on r.project_id=a.project_id and r.artifact_id=a.id
    where a.project_id=$1 and a.type_key='change-brief' and a.status='supplied' and r.id=$2 and (a.allowed_user_ids is null or $3=any(a.allowed_user_ids))
    for share of a,r`, [request.projectId, brief.revisionId, phase.actorId]);
  if (!briefRecord || contentDigest(briefRecord.payload) !== briefRecord.digest) throw invalid();
  const scenarios = briefRecord.payload.scenarios;
  const isScenario = (item: JsonValue): item is Record<string, JsonValue> & { id: string; expected: string } =>
    !!item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' && !!item.id && typeof item.expected === 'string' && !!item.expected;
  if (!Array.isArray(scenarios) || !scenarios.length || !scenarios.every(isScenario) ||
      new Set(scenarios.map(item => item.id)).size !== scenarios.length) throw invalid();
  if (type === 'test-plan') {
    const plan = payload.scenarios;
    if (!Array.isArray(plan) || plan.length !== scenarios.length || new Set(plan.map(item => (item as any)?.id)).size !== scenarios.length ||
        scenarios.some(expected => !plan.some(item => !!item && typeof item === 'object' && !Array.isArray(item) && item.id === expected.id && item.expected === expected.expected))) {
      throw invalid('The test plan must include each brief scenario exactly once with its unchanged ID and expected outcome.');
    }
    return;
  }
  const planId = createHash('sha256').update(JSON.stringify([request.projectId, request.runId, phase.occurrenceId, 'test-plan'])).digest('hex');
  const [plan] = await tx.unsafe<{ id: string; digest: string; payload: Record<string, JsonValue> }>(`select r.id,r.digest,r.payload
    from bp_artifacts a join bp_artifact_revisions r on r.project_id=a.project_id and r.artifact_id=a.id
    where a.project_id=$1 and a.id=$2 and r.id=$3 and a.status='supplied' and (a.allowed_user_ids is null or $4=any(a.allowed_user_ids))
      and not exists (select 1 from bp_artifact_revisions newer where newer.project_id=r.project_id and newer.artifact_id=r.artifact_id
        and (newer.created_at,newer.id)>(r.created_at,r.id)) for share of a,r`,
  [request.projectId, planId, payload.planRevision, phase.actorId]);
  if (!plan || contentDigest(plan.payload) !== plan.digest) throw invalid();
  const [candidateRecord] = await tx.unsafe<{ payload: Record<string, JsonValue>; digest: string }>(`select r.payload,r.digest from bp_artifacts a
    join bp_artifact_revisions r on r.project_id=a.project_id and r.artifact_id=a.id
    where a.project_id=$1 and a.type_key='candidate' and a.status='supplied' and r.id=$2
      and (a.allowed_user_ids is null or $3=any(a.allowed_user_ids)) for share of a,r`, [request.projectId,candidate.revisionId,phase.actorId]);
  if (!candidateRecord || contentDigest(candidateRecord.payload) !== candidateRecord.digest || typeof candidateRecord.payload.revision !== 'string' || !/^[a-f0-9]{40,64}$/.test(candidateRecord.payload.revision)) throw invalid();
  const [evidence] = await tx.unsafe<{ id: string; exitCode: number; stdout: string; stderr: string; qaRevision: string | null; digest: string }>(`
    select evidence_id as id,exit_code as "exitCode",stdout,stderr,qa_revision as "qaRevision",digest from bp_phase_workspace_evidence
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and tool_key='test-runner' for share`,
  [request.projectId, request.runId, phase.occurrenceId]);
  if (evidence && (evidence.qaRevision !== candidateRecord.payload.revision ||
      evidence.digest !== contentDigest({ exitCode: evidence.exitCode, stdout: evidence.stdout, stderr: evidence.stderr, qaRevision: evidence.qaRevision }))) throw invalid();
  const results = payload.results;
  if (!Array.isArray(results)) throw invalid();
  const completed = results.filter(item => item && typeof item === 'object' && !Array.isArray(item) && (item.status === 'passed' || item.status === 'failed'));
  if (completed.length && (!evidence || completed.some(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.observed !== 'string' || !item.observed.trim() ||
        !Array.isArray(item.evidence) || !item.evidence.includes(evidence.id)) return true;
    return !(evidence.stdout + '\n' + evidence.stderr).includes(item.observed);
  }))) throw invalid();
  if (payload.verdict === 'passed' && evidence?.exitCode !== 0) throw invalid();
  const progress = await tx.unsafe<{ scenarioId: string; status: string; planRevision: string; candidateRevision: string; observed: string | null; reason: string | null; evidenceId: string | null }>(`
    select e.scenario_id as "scenarioId",e.status,e.plan_revision as "planRevision",e.candidate_revision as "candidateRevision",e.observed,e.reason,e.evidence_id as "evidenceId"
    from bp_qa_scenario_events e where e.project_id=$1 and e.run_id=$2 and e.occurrence_id=$3 and e.attempt=$4
      and not exists (select 1 from bp_qa_scenario_events newer where newer.project_id=e.project_id and newer.run_id=e.run_id
        and newer.occurrence_id=e.occurrence_id and newer.attempt=e.attempt and newer.scenario_id=e.scenario_id and newer.sequence>e.sequence)
    order by e.scenario_id for share of e`, [request.projectId,request.runId,phase.occurrenceId,phase.attempt]);
  if (progress.length !== results.length || results.some(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
    const current = progress.find(event => event.scenarioId === item.id);
    return !current || current.status !== item.status || current.planRevision !== payload.planRevision || current.candidateRevision !== candidate.revisionId ||
      (current.observed ?? undefined) !== item.observed || (current.reason ?? undefined) !== item.reason ||
      (current.evidenceId !== null && (!Array.isArray(item.evidence) || !item.evidence.includes(current.evidenceId)));
  })) throw invalid();
  try {
    validateQaReport(plan.payload as any, plan.id, scenarios.map(item => item.id as string), payload as any, new Set(evidence ? [evidence.id] : []));
  } catch { throw invalid(); }
}
