import { createHash, randomUUID } from 'node:crypto';
import { ProductError, type ProductQuery } from './access.js';
import type { ActionResult } from './actions.js';
import type { PhaseRequest, resolvePhaseActivity } from './phase-activity.js';

/** Retry or stop only a turn that has not reserved an effect or produced output. */
export async function settleIncompletePhase(tx: ProductQuery, request: PhaseRequest, result: ActionResult,
  phase: Awaited<ReturnType<typeof resolvePhaseActivity>>) {
  const policy = phase.action.retry;
  if (!policy || !Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 10000 ||
      !Number.isSafeInteger(policy.delaySeconds) || policy.delaySeconds < 0 || policy.delaySeconds > 31536000) {
    throw new ProductError(409, 'workflow_plan_invalid', 'The specialist retry policy is unavailable or invalid.');
  }
  const outputIds = phase.action.outputTypes.map(type => createHash('sha256').update(JSON.stringify([request.projectId,request.runId,phase.occurrenceId,type])).digest('hex'));
  const [effect] = await tx.unsafe(`select 1 from bp_phase_workspace_grants where project_id=$1 and run_id=$2 and occurrence_id=$3 limit 1`, [request.projectId,request.runId,phase.occurrenceId]);
  const [output] = await tx.unsafe(`select 1 from bp_artifacts where project_id=$1 and id in (select jsonb_array_elements_text($2::text::jsonb)) limit 1`, [request.projectId,JSON.stringify(outputIds)]);
  if (effect || output || result.outputs.length) throw new ProductError(409, 'retry_reconciliation_required', 'The specialist reserved an action or produced output; reconcile it before continuing.');
  const [lineage] = await tx.unsafe<{ root: string; attemptNumber: number }>(`select root_occurrence_id as root,attempt_number as "attemptNumber" from bp_phase_retry_lineage
    where project_id=$1 and run_id=$2 and occurrence_id=$3 for share`, [request.projectId,request.runId,phase.occurrenceId]);
  const attemptNumber = lineage?.attemptNumber ?? 1;
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > policy.maxAttempts) throw new ProductError(409, 'workflow_plan_invalid', 'The specialist retry history is invalid.');
  let outcome: { kind: 'advance'; nextPhase: string; delaySeconds?: number } | { kind: 'blocked'; reason: string };
  if (result.status === 'blocked') {
    outcome = { kind: 'blocked', reason: result.reason?.trim() || 'The specialist is blocked.' };
  } else if (attemptNumber >= policy.maxAttempts) {
    outcome = { kind: 'blocked', reason: `The specialist failed after ${attemptNumber} attempt${attemptNumber === 1 ? '' : 's'}.` };
  } else {
    const occurrenceId = randomUUID(), occurrence = request.occurrence + 1, operationKey = `${request.runId}:${occurrence}`;
    await tx.unsafe(`insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key)
      values($1,$2,$3,$4,$5,$6,$7,$8)`, [request.projectId,request.runId,occurrenceId,request.phase,occurrence,phase.actionId,phase.assignmentId,operationKey]);
    await tx.unsafe(`insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state,input_revisions)
      values($1,$2,$3,1,'Pending',$4::text::jsonb)`, [request.projectId,request.runId,occurrenceId,JSON.stringify(phase.inputRevisions)]);
    await tx.unsafe(`insert into bp_dispatch_intents(project_id,run_id,occurrence_id,attempt,operation_key,state)
      values($1,$2,$3,1,$4,'Dispatched')`, [request.projectId,request.runId,occurrenceId,operationKey]);
    await tx.unsafe(`insert into bp_phase_retry_lineage(project_id,run_id,occurrence_id,root_occurrence_id,parent_occurrence_id,attempt_number)
      values($1,$2,$3,$4,$5,$6)`, [request.projectId,request.runId,occurrenceId,lineage?.root ?? phase.occurrenceId,phase.occurrenceId,attemptNumber + 1]);
    await tx.unsafe(`insert into bp_workflow_transitions(project_id,run_id,sequence,from_phase,to_phase,reason,evidence)
      values($1,$2,$3,$4,$4,'Safe specialist retry',$5::text::jsonb)`, [request.projectId,request.runId,request.occurrence,request.phase,JSON.stringify(result.evidence)]);
    outcome = { kind: 'advance', nextPhase: request.phase, ...(policy.delaySeconds ? { delaySeconds: policy.delaySeconds } : {}) };
  }
  await tx.unsafe(`update bp_action_attempts set state='Completed',reason=$5,finished_at=now()
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4`, [request.projectId,request.runId,phase.occurrenceId,phase.attempt,result.reason?.trim() || (result.status === 'blocked' ? 'Specialist blocked' : 'Specialist failed')]);
  await tx.unsafe(`update bp_dispatch_intents set state='Completed',updated_at=now()
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4`, [request.projectId,request.runId,phase.occurrenceId,phase.attempt]);
  await tx.unsafe(`update bp_workflow_runs set state=$3,revision=revision+1,updated_at=now() where project_id=$1 and id=$2`,
    [request.projectId,request.runId,outcome.kind === 'blocked' ? 'Blocked' : 'Running']);
  await tx.unsafe(`update bp_phase_activity_receipts set state='Completed',outcome=$5::text::jsonb,completed_at=now()
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 and state='Running'`,
  [request.projectId,request.runId,phase.occurrenceId,phase.attempt,JSON.stringify(outcome)]);
  return outcome;
}
