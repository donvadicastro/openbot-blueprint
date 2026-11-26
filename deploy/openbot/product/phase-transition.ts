import { createHash, randomUUID } from "node:crypto";
import { ProductError, type ProductQuery } from "./access.js";
import { selectActionTransition, type ActionResult } from "./actions.js";
import { contentDigest, type JsonValue } from "./store.js";
import { reconcilePhaseActivity, resolvePhaseActivity, type PhaseRequest } from "./phase-activity.js";
import { resolveWorkflowInputs } from "./workflow-inputs.js";
import { settleIncompletePhase } from "./phase-retry.js";
import { prepareReleaseDecision } from "./release-proposal.js";
import { requireReleaseInputs } from "./release-preflight.js";

/** Apply an already validated result under the workflow lock; no external effect is dispatched here. */
export async function applyPhaseResult(tx: ProductQuery, request: PhaseRequest, result: ActionResult, decision?: { id: string; value: unknown }) {
  await tx.unsafe('select id from bp_workflow_runs where project_id=$1 and id=$2 for update', [request.projectId, request.runId]);
  const receipt = await reconcilePhaseActivity(tx, request);
  if (receipt.kind === 'not-started') throw new ProductError(409, 'phase_unavailable', 'The phase has not been claimed.');
  const [saved] = await tx.unsafe<{ digest: string }>(`select x.result_digest as digest from bp_phase_results x
    join bp_phase_occurrences o on o.project_id=x.project_id and o.run_id=x.run_id and o.id=x.occurrence_id
    where x.project_id=$1 and x.run_id=$2 and o.phase_key=$3 and o.occurrence=$4 and o.operation_key=$5
      and x.attempt=(select max(a.attempt) from bp_action_attempts a where a.project_id=o.project_id and a.run_id=o.run_id and a.occurrence_id=o.id)
    for share of x`, [request.projectId, request.runId, request.phase, request.occurrence, request.operationKey]);
  if (!saved || saved.digest !== contentDigest(result as unknown as JsonValue)) throw new ProductError(409, 'result_unavailable', 'The validated phase result is unavailable.');
  if (receipt.kind === 'completed') return receipt.outcome;
  const phase = await resolvePhaseActivity(tx, request);
  if (result.runRevision !== phase.runRevision || result.occurrenceId !== phase.occurrenceId || result.attempt !== phase.attempt) {
    throw new ProductError(409, 'stale_action_result', 'The phase result is no longer current.');
  }
  if (result.status === 'needs-input') {
    if (decision || typeof result.question !== 'string' || !result.question.trim() || result.question.length > 4000 || result.outputs.length || Object.keys(result.evidence).length) {
      throw new ProductError(422, 'invalid_action_result', 'A clarification needs one question before any completed output or effect.');
    }
    const outputIds = phase.action.outputTypes.map(type => createHash('sha256').update(JSON.stringify([request.projectId,request.runId,phase.occurrenceId,type])).digest('hex'));
    const [effect] = await tx.unsafe(`select 1 from bp_phase_workspace_grants where project_id=$1 and run_id=$2 and occurrence_id=$3 limit 1`, [request.projectId,request.runId,phase.occurrenceId]);
    const [output] = await tx.unsafe(`select 1 from bp_artifacts where project_id=$1 and id in (select jsonb_array_elements_text($2::text::jsonb)) limit 1`, [request.projectId,JSON.stringify(outputIds)]);
    if (effect || output) throw new ProductError(409, 'clarification_after_effect', 'The specialist must reconcile its earlier output or workspace action before asking for clarification.');
    const [existing] = await tx.unsafe<{ id: string; question: string }>(`select d.id,d.question from bp_phase_clarifications c
      join bp_workflow_decisions d on (d.project_id,d.run_id,d.id)=(c.project_id,c.run_id,c.decision_id)
      where c.project_id=$1 and c.run_id=$2 and c.occurrence_id=$3 and c.attempt=$4 for share of c,d`, [request.projectId,request.runId,phase.occurrenceId,phase.attempt]);
    if (existing) return { kind: 'wait' as const, decisionId: existing.id, question: existing.question };
    const id = randomUUID(), question = result.question.trim();
    await tx.unsafe("insert into bp_workflow_decisions(project_id,run_id,id,question,state) values($1,$2,$3,$4,'Pending')", [request.projectId,request.runId,id,question]);
    await tx.unsafe(`insert into bp_phase_clarifications(project_id,run_id,occurrence_id,attempt,decision_id,result_digest)
      values($1,$2,$3,$4,$5,$6)`, [request.projectId,request.runId,phase.occurrenceId,phase.attempt,id,saved.digest]);
    return { kind: 'wait' as const, decisionId: id, question };
  }
  const revisions = result.outputs.map(output => output.revisionId);
  const rows = await tx.unsafe<{ type: string; payload: Record<string, unknown>; digest: string }>(`
    select a.type_key as type,r.payload,r.digest from bp_artifacts a join bp_artifact_revisions r on r.project_id=a.project_id and r.artifact_id=a.id
    where a.project_id=$1 and r.id in (select jsonb_array_elements_text($2::text::jsonb))
      and a.status='supplied' and (a.allowed_user_ids is null or $3=any(a.allowed_user_ids))
      and not exists (select 1 from bp_artifact_revisions newer where newer.project_id=r.project_id and newer.artifact_id=r.artifact_id
        and (newer.created_at,newer.id)>(r.created_at,r.id)) for share of a,r`,
  [request.projectId, JSON.stringify(revisions), phase.actorId]);
  if (rows.length !== revisions.length || rows.some(row => contentDigest(row.payload as JsonValue) !== row.digest)) throw new ProductError(409, 'result_unavailable', 'The result revisions are no longer available.');
  const records = new Map(rows.map(row => [row.type, row.payload]));
  if (phase.definition.projectType === 'software-development' && phase.actionId === 'prepare-release' && result.status === 'succeeded' && !decision) {
    return prepareReleaseDecision(tx, request, phase, saved.digest);
  }
  if (['failed', 'blocked'].includes(result.status) && !decision && !phase.plan.workflow.transitions.some(item => item.from === request.phase && item.when.status === result.status)) {
    return settleIncompletePhase(tx, request, result, phase);
  }
  let decisionValue: string | undefined;
  let releaseApproved = false;
  if (decision) {
    const [binding] = await tx.unsafe<{ state: string; answer: unknown; resultDigest: string; proposalId: string | null }>(`select d.state,d.answer,b.result_digest as "resultDigest",release.proposal_id as "proposalId"
      from bp_phase_decision_bindings b join bp_workflow_decisions d on (d.project_id,d.run_id,d.id)=(b.project_id,b.run_id,b.decision_id)
      left join bp_release_decision_bindings release on (release.project_id,release.run_id,release.decision_id)=(b.project_id,b.run_id,b.decision_id)
      join bp_action_attempts original on (original.project_id,original.run_id,original.occurrence_id,original.attempt)=(b.project_id,b.run_id,b.occurrence_id,b.attempt)
      join bp_phase_results x on (x.project_id,x.run_id,x.occurrence_id,x.attempt)=(b.project_id,b.run_id,b.occurrence_id,b.attempt)
      join bp_workflow_runs r on (r.project_id,r.id)=(d.project_id,d.run_id)
      join bp_work_items w on (w.project_id,w.id)=(r.project_id,r.work_item_id)
      join bp_memberships m on m.project_id=r.project_id and m.user_id=d.answered_by
      join bp_conversations c on c.project_id=w.project_id and c.native_channel_id=w.native_channel_id
      join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=d.answered_by
      join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
      where b.project_id=$1 and b.run_id=$2 and b.occurrence_id=$3 and b.attempt=$4 and b.decision_id=$5
        and 'read'=any(m.permissions) and (case when release.decision_id is not null then 'approve' else 'work' end)=any(m.permissions)
        and not exists (select 1 from jsonb_array_elements(original.input_revisions || (x.result->'outputs')) ref
          where not exists (select 1 from bp_artifact_revisions ar join bp_artifacts artifact on artifact.project_id=ar.project_id and artifact.id=ar.artifact_id
            where ar.project_id=b.project_id and ar.id=ref->>'revisionId' and artifact.type_key=ref->>'type' and artifact.status='supplied'
              and (artifact.allowed_user_ids is null or d.answered_by=any(artifact.allowed_user_ids))))
        and (release.decision_id is null or exists (select 1 from bp_release_proposals proposal
          where (proposal.project_id,proposal.run_id,proposal.id)=(release.project_id,release.run_id,release.proposal_id)
            and not exists (select 1 from (values ('candidateRevision','candidate'),('qaEvidenceRevision','qa-evidence'),
              ('briefRevision','change-brief'),('planRevision','test-plan'),('runbookRevision','release-runbook'),('targetRevision','release-target')) refs(field,type)
              where not exists (select 1 from bp_artifact_revisions ar join bp_artifacts artifact on (artifact.project_id,artifact.id)=(ar.project_id,ar.artifact_id)
                where ar.project_id=proposal.project_id and ar.id=proposal.evidence->>refs.field and artifact.type_key=refs.type and artifact.status='supplied'
                  and (artifact.allowed_user_ids is null or d.answered_by=any(artifact.allowed_user_ids))))))
        for share of b,d,original,x,r,w,m,c,cm,ch`,
    [request.projectId, request.runId, phase.occurrenceId, phase.attempt, decision.id]);
    if (!binding || binding.state !== 'Answered' || binding.resultDigest !== saved.digest || typeof decision.value !== 'string' || binding.answer !== decision.value) {
      throw new ProductError(409, 'workflow_decision_unavailable', 'The authorized decision could not be verified.');
    }
    decisionValue = decision.value;
    if (binding.proposalId) {
      if (phase.definition.projectType !== 'software-development' || phase.actionId !== 'prepare-release' || !['approve','reject'].includes(decisionValue)) throw new ProductError(409, 'release_decision_unavailable', 'The release decision is invalid.');
      const current = await requireReleaseInputs(tx, request);
      const [approval] = await tx.unsafe<{ state: string; evidence: JsonValue; candidateRevision: string; target: string; decision: string }>(`
        select p.state,p.evidence,p.candidate_revision_id as "candidateRevision",p.target,a.decision
        from bp_release_proposals p join bp_release_approvals a on (a.project_id,a.run_id,a.proposal_id)=(p.project_id,p.run_id,p.id)
        join bp_workflow_decisions d on (d.project_id,d.run_id,d.id)=(a.project_id,a.run_id,a.id) and d.answered_by=a.approver_id
        where p.project_id=$1 and p.run_id=$2 and p.id=$3 and a.id=$4 for share of p,a,d`, [request.projectId,request.runId,binding.proposalId,decision.id]);
      if (!approval || contentDigest(approval.evidence) !== contentDigest(current as unknown as JsonValue) || approval.candidateRevision !== current.candidateRevision || approval.target !== current.target ||
          approval.state !== (decisionValue === 'approve' ? 'Approved' : 'Rejected') || approval.decision !== approval.state) throw new ProductError(409, 'release_evidence_unavailable', 'The release approval or its evidence is unavailable.');
      if (decisionValue === 'reject') {
        const outcome = { kind: 'blocked' as const, reason: 'The release was rejected by the approver.' };
        await tx.unsafe(`update bp_action_attempts set state='Completed',reason=$5,finished_at=now() where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4`, [request.projectId,request.runId,phase.occurrenceId,phase.attempt,outcome.reason]);
        await tx.unsafe(`update bp_dispatch_intents set state='Completed',updated_at=now() where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4`, [request.projectId,request.runId,phase.occurrenceId,phase.attempt]);
        await tx.unsafe("update bp_workflow_runs set state='Blocked',revision=revision+1,updated_at=now() where project_id=$1 and id=$2", [request.projectId,request.runId]);
        await tx.unsafe(`update bp_phase_activity_receipts set state='Completed',outcome=$5::text::jsonb,completed_at=now() where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 and state='Running'`, [request.projectId,request.runId,phase.occurrenceId,phase.attempt,JSON.stringify(outcome)]);
        return outcome;
      }
      releaseApproved = true;
    }
  }
  const next = selectActionTransition(phase.plan.workflow, request.phase, result.status, records, decisionValue);
  if (!next && !decision) {
    const choices = [...new Set(phase.plan.workflow.transitions.filter(item => item.from === request.phase && item.when.status === result.status && typeof item.when.decision === 'string')
      .map(item => item.when.decision!).filter(value => selectActionTransition(phase.plan.workflow, request.phase, result.status, records, value)))];
    if (choices.length) {
      const [existing] = await tx.unsafe<{ id: string; question: string }>(`select d.id,d.question from bp_phase_decision_bindings b
        join bp_workflow_decisions d on (d.project_id,d.run_id,d.id)=(b.project_id,b.run_id,b.decision_id)
        where b.project_id=$1 and b.run_id=$2 and b.occurrence_id=$3 and b.attempt=$4 for share of b,d`, [request.projectId, request.runId, phase.occurrenceId, phase.attempt]);
      if (existing) return { kind: 'wait' as const, decisionId: existing.id, question: existing.question };
      const id = randomUUID(), question = `Choose how to continue: ${choices.join(', ')}.`;
      await tx.unsafe(`insert into bp_workflow_decisions(project_id,run_id,id,question,state) values($1,$2,$3,$4,'Pending')`, [request.projectId, request.runId, id, question]);
      await tx.unsafe(`insert into bp_phase_decision_bindings(project_id,run_id,occurrence_id,attempt,decision_id,result_digest,choices)
        values($1,$2,$3,$4,$5,$6,$7::text::jsonb)`, [request.projectId, request.runId, phase.occurrenceId, phase.attempt, id, saved.digest, JSON.stringify(choices)]);
      return { kind: 'wait' as const, decisionId: id, question };
    }
  }
  if (!next) throw new ProductError(409, 'workflow_decision_required', 'The workflow needs a decision or a supported next phase before it can continue.');
  const nextPhase = phase.plan.workflow.phases.find(item => item.id === next);
  if (!nextPhase) throw new ProductError(409, 'workflow_plan_invalid', 'The next phase is unavailable.');
  let outcome: { kind: 'complete'; result: string } | { kind: 'advance'; nextPhase: string };
  if (nextPhase.terminal) {
    outcome = { kind: 'complete', result: `Workflow reached ${next}.` };
  } else {
    const business = phase.definition.business!;
    const action = business.actions.find(item => item.id === nextPhase.action);
    const role = business.roles.find(item => item.id === action?.role);
    if (!action || !role) throw new ProductError(409, 'workflow_plan_invalid', 'The next specialist is unavailable.');
    if (action.approvalRequired && !(releaseApproved && phase.actionId === 'prepare-release' && action.id === 'deploy')) throw new ProductError(409, 'approval_gate_unavailable', 'The next action requires an approval gate.');
    const [assignment] = await tx.unsafe<{ id: string }>(`select id from bp_assignments
      where project_id=$1 and role_key=$2 and native_bot_id=$3 for share`, [request.projectId, role.id, role.agentId]);
    if (!assignment) throw new ProductError(409, 'assignment_unavailable', 'The next specialist is not available.');
    const inputs = await resolveWorkflowInputs(tx, request.projectId, request.runId, phase.actorId, business, role.id, action);
    const occurrenceId = randomUUID(), occurrence = request.occurrence + 1, operationKey = `${request.runId}:${occurrence}`;
    await tx.unsafe(`insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key)
      values($1,$2,$3,$4,$5,$6,$7,$8)`, [request.projectId, request.runId, occurrenceId, next, occurrence, action.id, assignment.id, operationKey]);
    await tx.unsafe(`insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state,input_revisions)
      values($1,$2,$3,1,'Pending',$4::text::jsonb)`, [request.projectId, request.runId, occurrenceId, JSON.stringify(inputs)]);
    await tx.unsafe(`insert into bp_dispatch_intents(project_id,run_id,occurrence_id,attempt,operation_key,state)
      values($1,$2,$3,1,$4,'Dispatched')`, [request.projectId, request.runId, occurrenceId, operationKey]);
    outcome = { kind: 'advance', nextPhase: next };
  }
  await tx.unsafe(`insert into bp_workflow_transitions(project_id,run_id,sequence,from_phase,to_phase,evidence)
    values($1,$2,$3,$4,$5,$6::text::jsonb)`, [request.projectId, request.runId, request.occurrence, request.phase, next, JSON.stringify(result.evidence)]);
  await tx.unsafe(`update bp_action_attempts set state='Completed',output_revisions=$5::text::jsonb,finished_at=now()
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4`, [request.projectId, request.runId, phase.occurrenceId, phase.attempt, JSON.stringify(result.outputs)]);
  await tx.unsafe(`update bp_dispatch_intents set state='Completed',updated_at=now() where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4`, [request.projectId, request.runId, phase.occurrenceId, phase.attempt]);
  await tx.unsafe(`update bp_workflow_runs set state=$3,current_phase=$4,revision=revision+1,updated_at=now() where project_id=$1 and id=$2`, [request.projectId, request.runId, nextPhase.terminal ? 'Completed' : 'Running', next]);
  await tx.unsafe(`update bp_phase_activity_receipts set state='Completed',outcome=$5::text::jsonb,completed_at=now()
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 and state='Running'`, [request.projectId, request.runId, phase.occurrenceId, phase.attempt, JSON.stringify(outcome)]);
  return outcome;
}
