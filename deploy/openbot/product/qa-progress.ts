import { createHash } from 'node:crypto';
import { ProductError, type ProductQuery } from './access.js';
import { contentDigest, type JsonValue } from './store.js';
import { resolvePhaseActivity, type PhaseRequest } from './phase-activity.js';
import { requireQaOutput } from './swe-qa.js';

type Status = 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'not-run';
type Progress = { planRevision: string; scenarioId: string; status: Status; observed?: string; reason?: string; evidenceId?: string };
const final = new Set<Status>(['passed', 'failed', 'blocked', 'not-run']);

/** Validate one monotonic, idempotent scenario transition. */
export function nextQaScenarioStatus(previous: Status | undefined, next: Status) {
  if (!['queued','running','passed','failed','blocked','not-run'].includes(next)) return false;
  if (!previous) return next === 'queued';
  if (previous === next) return true;
  if (final.has(previous)) return false;
  return previous === 'queued' ? ['running','blocked','not-run'].includes(next) : final.has(next);
}

/** The server, not the bot, determines the project, phase, candidate and assignment. */
export async function recordQaProgress(tx: ProductQuery, request: PhaseRequest, input: Progress) {
  const invalid = () => new ProductError(422, 'invalid_qa_progress', 'Provide a valid scenario update for the current test plan.');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['planRevision','scenarioId','status','observed','reason','evidenceId'].includes(key)) ||
      typeof input.planRevision !== 'string' || !input.planRevision || input.planRevision.length > 200 ||
      typeof input.scenarioId !== 'string' || !input.scenarioId.trim() || input.scenarioId.length > 200 ||
      typeof input.status !== 'string' || !['queued','running','passed','failed','blocked','not-run'].includes(input.status) ||
      [input.observed,input.reason,input.evidenceId].some(value => value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 4000)) ||
      (typeof input.evidenceId === 'string' && input.evidenceId.length > 200)) throw invalid();
  await tx.unsafe('select id from bp_workflow_runs where project_id=$1 and id=$2 for update', [request.projectId, request.runId]);
  const phase = await resolvePhaseActivity(tx, request);
  const [receipt] = await tx.unsafe<{ state: string; digest: string }>(`select state,request_digest as digest from bp_phase_activity_receipts
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 for update`, [request.projectId,request.runId,phase.occurrenceId,phase.attempt]);
  if (phase.definition.projectType !== 'software-development' || !phase.action.outputTypes.includes('qa-evidence') ||
      !receipt || receipt.state !== 'Running' || receipt.digest !== contentDigest(request as unknown as JsonValue)) throw invalid();
  const candidate = phase.inputRevisions.find(item => item.type === 'candidate');
  const planId = createHash('sha256').update(JSON.stringify([request.projectId,request.runId,phase.occurrenceId,'test-plan'])).digest('hex');
  const [plan] = await tx.unsafe<{ digest: string; payload: Record<string, JsonValue> }>(`select r.digest,r.payload from bp_artifacts a
    join bp_artifact_revisions r on r.project_id=a.project_id and r.artifact_id=a.id
    where a.project_id=$1 and a.id=$2 and r.id=$3 and a.status='supplied' and (a.allowed_user_ids is null or $4=any(a.allowed_user_ids))
      and not exists (select 1 from bp_artifact_revisions newer where newer.project_id=r.project_id and newer.artifact_id=r.artifact_id
        and (newer.created_at,newer.id)>(r.created_at,r.id)) for share of a,r`,
  [request.projectId,planId,input.planRevision,phase.actorId]);
  if (!candidate || !plan || contentDigest(plan.payload) !== plan.digest || plan.payload.candidateRevision !== candidate.revisionId ||
      !Array.isArray(plan.payload.scenarios) || !plan.payload.scenarios.some(item => !!item && typeof item === 'object' && !Array.isArray(item) && item.id === input.scenarioId)) throw invalid();
  await requireQaOutput(tx, request, phase, 'test-plan', plan.payload);
  if (input.status !== 'queued') {
    const [queued] = await tx.unsafe<{ count: number }>(`select count(*)::int as count from bp_qa_scenario_events
      where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 and plan_revision=$5 and status='queued'`,
    [request.projectId,request.runId,phase.occurrenceId,phase.attempt,input.planRevision]);
    if (queued?.count !== plan.payload.scenarios.length) throw new ProductError(409, 'qa_progress_incomplete', 'Queue every planned scenario before recording execution.');
  }
  if (input.status === 'passed' || input.status === 'failed') {
    if (!input.observed || !input.evidenceId || input.reason !== undefined) throw invalid();
    const [candidateRecord] = await tx.unsafe<{ payload: Record<string, JsonValue>; digest: string }>(`select r.payload,r.digest from bp_artifacts a
      join bp_artifact_revisions r on r.project_id=a.project_id and r.artifact_id=a.id
      where a.project_id=$1 and a.type_key='candidate' and a.status='supplied' and r.id=$2
        and (a.allowed_user_ids is null or $3=any(a.allowed_user_ids)) for share of a,r`, [request.projectId,candidate.revisionId,phase.actorId]);
    const [evidence] = await tx.unsafe<{ exitCode: number; stdout: string; stderr: string; digest: string; qaRevision: string | null }>(`select exit_code as "exitCode",stdout,stderr,digest,qa_revision as "qaRevision" from bp_phase_workspace_evidence
      where project_id=$1 and run_id=$2 and occurrence_id=$3 and tool_key='test-runner' and evidence_id=$4 for share`,
    [request.projectId,request.runId,phase.occurrenceId,input.evidenceId]);
    if (!candidateRecord || contentDigest(candidateRecord.payload) !== candidateRecord.digest || typeof candidateRecord.payload.revision !== 'string' || !/^[a-f0-9]{40,64}$/.test(candidateRecord.payload.revision) ||
        !evidence || evidence.qaRevision !== candidateRecord.payload.revision ||
        evidence.digest !== contentDigest({ exitCode: evidence.exitCode, stdout: evidence.stdout, stderr: evidence.stderr, qaRevision: evidence.qaRevision }) ||
        !(evidence.stdout + '\n' + evidence.stderr).includes(input.observed)) throw invalid();
  } else if (input.status === 'blocked' || input.status === 'not-run') {
    if (!input.reason || input.observed !== undefined || input.evidenceId !== undefined) throw invalid();
  } else if (input.observed !== undefined || input.reason !== undefined || input.evidenceId !== undefined) throw invalid();
  const [previous] = await tx.unsafe<{ sequence: number; status: Status; planRevision: string; candidateRevision: string; observed: string | null; reason: string | null; evidenceId: string | null }>(`
    select sequence,status,plan_revision as "planRevision",candidate_revision as "candidateRevision",observed,reason,evidence_id as "evidenceId"
    from bp_qa_scenario_events where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 and scenario_id=$5
    order by sequence desc limit 1 for share`, [request.projectId,request.runId,phase.occurrenceId,phase.attempt,input.scenarioId]);
  if (!nextQaScenarioStatus(previous?.status, input.status) || (previous && (previous.planRevision !== input.planRevision || previous.candidateRevision !== candidate.revisionId))) throw invalid();
  if (previous?.status === input.status) {
    if (previous.observed !== (input.observed ?? null) || previous.reason !== (input.reason ?? null) || previous.evidenceId !== (input.evidenceId ?? null)) throw new ProductError(409, 'qa_progress_conflict', 'This scenario update was already recorded with different details.');
    return { scenarioId: input.scenarioId, status: input.status, sequence: previous.sequence };
  }
  const sequence = (previous?.sequence ?? 0) + 1;
  await tx.unsafe(`insert into bp_qa_scenario_events(project_id,run_id,occurrence_id,attempt,scenario_id,sequence,plan_revision,candidate_revision,status,observed,reason,evidence_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [request.projectId,request.runId,phase.occurrenceId,phase.attempt,input.scenarioId,sequence,input.planRevision,candidate.revisionId,input.status,input.observed ?? null,input.reason ?? null,input.evidenceId ?? null]);
  return { scenarioId: input.scenarioId, status: input.status, sequence };
}
