import { createHash } from 'node:crypto';
import { ProductError, type ProductQuery } from './access.js';
import { contentDigest, type JsonValue } from './store.js';
import { resolvePhaseActivity, type PhaseRequest } from './phase-activity.js';

/** Start one new attempt of the same occurrence after an authorized clarification. */
export async function startClarifiedAttempt(tx: ProductQuery, request: PhaseRequest, decision: { id: string; value: unknown }) {
  await tx.unsafe('select id from bp_workflow_runs where project_id=$1 and id=$2 for update', [request.projectId, request.runId]);
  const [row] = await tx.unsafe<{ attempt: number; occurrenceId: string; state: string; answer: unknown; resultDigest: string; result: JsonValue; question: string }>(`
    select c.attempt,c.occurrence_id as "occurrenceId",d.state,d.answer,c.result_digest as "resultDigest",x.result,d.question
    from bp_phase_clarifications c join bp_workflow_decisions d on (d.project_id,d.run_id,d.id)=(c.project_id,c.run_id,c.decision_id)
    join bp_phase_occurrences o on (o.project_id,o.run_id,o.id)=(c.project_id,c.run_id,c.occurrence_id)
    join bp_phase_results x on (x.project_id,x.run_id,x.occurrence_id,x.attempt)=(c.project_id,c.run_id,c.occurrence_id,c.attempt)
    join bp_action_attempts original on (original.project_id,original.run_id,original.occurrence_id,original.attempt)=(c.project_id,c.run_id,c.occurrence_id,c.attempt)
    join bp_workflow_runs r on (r.project_id,r.id)=(c.project_id,c.run_id)
    join bp_work_items w on (w.project_id,w.id)=(r.project_id,r.work_item_id)
    join bp_memberships m on m.project_id=r.project_id and m.user_id=d.answered_by
    join bp_conversations conv on conv.project_id=w.project_id and conv.native_channel_id=w.native_channel_id
    join channel_memberships cm on cm.channel_id=conv.native_channel_id and cm.user_id=d.answered_by
    join channels ch on ch.id=conv.native_channel_id and ch.deleted_at is null
    where c.project_id=$1 and c.run_id=$2 and o.phase_key=$3 and o.occurrence=$4 and o.operation_key=$5 and d.id=$6
      and 'read'=any(m.permissions) and 'work'=any(m.permissions)
      and not exists (select 1 from jsonb_array_elements(original.input_revisions) ref
        where not exists (select 1 from bp_artifact_revisions ar join bp_artifacts artifact on artifact.project_id=ar.project_id and artifact.id=ar.artifact_id
          where ar.project_id=c.project_id and ar.id=ref->>'revisionId' and artifact.type_key=ref->>'type' and artifact.status='supplied'
            and (artifact.allowed_user_ids is null or d.answered_by=any(artifact.allowed_user_ids))))
      for share of c,d,o,x,original,r,w,m,conv,cm,ch`,
  [request.projectId,request.runId,request.phase,request.occurrence,request.operationKey,decision.id]);
  if (!row || row.state !== 'Answered' || typeof decision.value !== 'string' || row.answer !== decision.value || contentDigest(row.result) !== row.resultDigest) {
    throw new ProductError(409, 'workflow_decision_unavailable', 'The authorized clarification could not be verified.');
  }
  const phase = await resolvePhaseActivity(tx, request);
  const [existing] = await tx.unsafe<{ attempt: number }>(`select attempt from bp_attempt_clarifications
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and decision_id=$4 for share`, [request.projectId,request.runId,row.occurrenceId,decision.id]);
  if (existing) {
    if (phase.occurrenceId !== row.occurrenceId || phase.attempt < existing.attempt) throw new ProductError(409, 'workflow_decision_unavailable', 'The clarification is no longer current.');
    return { attempt: existing.attempt, replayed: true };
  }
  const result = row.result as { status?: unknown; question?: unknown; runRevision?: unknown };
  if (phase.occurrenceId !== row.occurrenceId || phase.attempt !== row.attempt || result.status !== 'needs-input' ||
      typeof result.question !== 'string' || result.question.trim() !== row.question || result.runRevision !== phase.runRevision || row.attempt >= 10000) {
    throw new ProductError(409, 'workflow_decision_unavailable', 'The clarification is no longer current.');
  }
  const [receipt] = await tx.unsafe<{ state: string; digest: string }>(`select state,request_digest as digest from bp_phase_activity_receipts
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 for update`, [request.projectId,request.runId,row.occurrenceId,row.attempt]);
  if (!receipt || receipt.state !== 'Running' || receipt.digest !== contentDigest(request as unknown as JsonValue)) throw new ProductError(409, 'phase_unavailable', 'The original phase claim could not be verified.');
  const ids = phase.action.outputTypes.map(type => createHash('sha256').update(JSON.stringify([request.projectId,request.runId,row.occurrenceId,type])).digest('hex'));
  const [effect] = await tx.unsafe('select 1 from bp_phase_workspace_grants where project_id=$1 and run_id=$2 and occurrence_id=$3 limit 1', [request.projectId,request.runId,row.occurrenceId]);
  const [output] = await tx.unsafe('select 1 from bp_artifacts where project_id=$1 and id in (select jsonb_array_elements_text($2::text::jsonb)) limit 1', [request.projectId,JSON.stringify(ids)]);
  if (effect || output) throw new ProductError(409, 'clarification_after_effect', 'The previous action must be reconciled before it can be continued.');
  const nextAttempt = row.attempt + 1;
  await tx.unsafe(`update bp_action_attempts set state='Completed',reason='Clarification received',finished_at=now()
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4`, [request.projectId,request.runId,row.occurrenceId,row.attempt]);
  await tx.unsafe(`update bp_dispatch_intents set state='Completed',updated_at=now() where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4`, [request.projectId,request.runId,row.occurrenceId,row.attempt]);
  await tx.unsafe(`update bp_phase_activity_receipts set state='Completed',outcome=$5::text::jsonb,completed_at=now()
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 and state='Running'`, [request.projectId,request.runId,row.occurrenceId,row.attempt,JSON.stringify({ kind: 'wait', decisionId: decision.id, question: row.question })]);
  await tx.unsafe(`insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state,input_revisions)
    values($1,$2,$3,$4,'Pending',$5::text::jsonb)`, [request.projectId,request.runId,row.occurrenceId,nextAttempt,JSON.stringify(phase.inputRevisions)]);
  await tx.unsafe(`insert into bp_dispatch_intents(project_id,run_id,occurrence_id,attempt,operation_key,state)
    values($1,$2,$3,$4,$5,'Dispatched')`, [request.projectId,request.runId,row.occurrenceId,nextAttempt,request.operationKey]);
  await tx.unsafe(`insert into bp_attempt_clarifications(project_id,run_id,occurrence_id,attempt,decision_id) values($1,$2,$3,$4,$5)`, [request.projectId,request.runId,row.occurrenceId,nextAttempt,decision.id]);
  return { attempt: nextAttempt, replayed: false };
}

/** Supply only answers whose people still have access to the original conversation. */
export async function readClarifications(tx: ProductQuery, request: PhaseRequest, occurrenceId: string, attempt: number) {
  const [expected] = await tx.unsafe<{ count: number }>(`select count(*)::int as count from bp_attempt_clarifications
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt<=$4`, [request.projectId,request.runId,occurrenceId,attempt]);
  const rows = await tx.unsafe<{ question: string; answer: string }>(`select d.question,d.answer from bp_attempt_clarifications a
    join bp_workflow_decisions d on (d.project_id,d.run_id,d.id)=(a.project_id,a.run_id,a.decision_id)
    join bp_phase_clarifications source on (source.project_id,source.run_id,source.decision_id)=(a.project_id,a.run_id,a.decision_id)
    join bp_action_attempts original on (original.project_id,original.run_id,original.occurrence_id,original.attempt)=(source.project_id,source.run_id,source.occurrence_id,source.attempt)
    join bp_workflow_runs r on (r.project_id,r.id)=(a.project_id,a.run_id)
    join bp_work_items w on (w.project_id,w.id)=(r.project_id,r.work_item_id)
    join bp_memberships m on m.project_id=r.project_id and m.user_id=d.answered_by
    join bp_conversations c on c.project_id=w.project_id and c.native_channel_id=w.native_channel_id
    join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=d.answered_by
    join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
    where a.project_id=$1 and a.run_id=$2 and a.occurrence_id=$3 and a.attempt<=$4 and d.state='Answered'
      and 'read'=any(m.permissions) and 'work'=any(m.permissions)
      and not exists (select 1 from jsonb_array_elements(original.input_revisions) ref
        where not exists (select 1 from bp_artifact_revisions ar join bp_artifacts artifact on artifact.project_id=ar.project_id and artifact.id=ar.artifact_id
          where ar.project_id=a.project_id and ar.id=ref->>'revisionId' and artifact.type_key=ref->>'type' and artifact.status='supplied'
            and (artifact.allowed_user_ids is null or d.answered_by=any(artifact.allowed_user_ids))))
      order by a.attempt for share of a,d,source,original,r,w,m,c,cm,ch`,
  [request.projectId,request.runId,occurrenceId,attempt]);
  if (rows.length !== expected.count || rows.some(row => typeof row.answer !== 'string')) throw new ProductError(409, 'workflow_decision_unavailable', 'A clarification is no longer available to this project.');
  if (JSON.stringify(rows).length > 64000) throw new ProductError(409, 'clarification_context_too_large', 'The clarification history is too large for this specialist turn.');
  return rows;
}
