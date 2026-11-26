import { ProductError, requirePermission, requireProject, type ProductActor } from './access.js';
import type { ProductModule } from './module.js';
import { recordReleaseApproval } from './release-approval.js';

/** Commit an authorized answer and durable signal intent together. */
export async function answerWorkflowDecision(module: ProductModule, actor: ProductActor, projectId: string,
  workItemId: string, runId: string, decisionId: string, value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new ProductError(422, 'invalid_decision', 'Provide an answer to the decision.');
  return module.database.begin(async tx => {
    const project = await requireProject(tx, actor, projectId, 'read');
    if (project.state !== 'Operational') throw new ProductError(409, 'project_not_operational', 'The project must be Operational to answer.');
    // Match the phase transition lock order before locking its decision.
    await tx.unsafe('select id from bp_workflow_runs where project_id=$1 and id=$2 for update', [projectId, runId]);
    const [row] = await tx.unsafe<{ state: string; answer: unknown; answeredBy: string | null; choices: unknown; kind: string; release: boolean }>(`
      select d.state,d.answer,d.answered_by as "answeredBy",b.choices,(release.decision_id is not null) as release,
        case when b.decision_id is not null and clar.decision_id is null then 'choice'
             when clar.decision_id is not null and b.decision_id is null then 'clarification' else 'invalid' end as kind
      from bp_workflow_decisions d
      left join bp_phase_decision_bindings b on (b.project_id,b.run_id,b.decision_id)=(d.project_id,d.run_id,d.id)
      left join bp_phase_clarifications clar on (clar.project_id,clar.run_id,clar.decision_id)=(d.project_id,d.run_id,d.id)
      left join bp_release_decision_bindings release on (release.project_id,release.run_id,release.decision_id)=(d.project_id,d.run_id,d.id)
      join bp_action_attempts a on a.project_id=d.project_id and a.run_id=d.run_id and a.occurrence_id=coalesce(b.occurrence_id,clar.occurrence_id) and a.attempt=coalesce(b.attempt,clar.attempt)
      join bp_phase_results x on (x.project_id,x.run_id,x.occurrence_id,x.attempt)=(a.project_id,a.run_id,a.occurrence_id,a.attempt)
      join bp_workflow_runs r on (r.project_id,r.id)=(d.project_id,d.run_id)
      join bp_work_items w on (w.project_id,w.id)=(r.project_id,r.work_item_id)
      join bp_conversations c on c.project_id=w.project_id and c.native_channel_id=w.native_channel_id
      join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=$5
      join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
      where d.project_id=$1 and w.id=$2 and r.id=$3 and d.id=$4
        and not exists (select 1 from jsonb_array_elements(a.input_revisions || (x.result->'outputs')) ref
          where not exists (select 1 from bp_artifact_revisions ar join bp_artifacts artifact on artifact.project_id=ar.project_id and artifact.id=ar.artifact_id
            where ar.project_id=d.project_id and ar.id=ref->>'revisionId' and artifact.type_key=ref->>'type' and artifact.status='supplied'
              and (artifact.allowed_user_ids is null or $5=any(artifact.allowed_user_ids))))
        and (release.decision_id is null or exists (select 1 from bp_release_proposals proposal
          where (proposal.project_id,proposal.run_id,proposal.id)=(release.project_id,release.run_id,release.proposal_id)
            and not exists (select 1 from (values ('candidateRevision','candidate'),('qaEvidenceRevision','qa-evidence'),
              ('briefRevision','change-brief'),('planRevision','test-plan'),('runbookRevision','release-runbook'),('targetRevision','release-target')) refs(field,type)
              where not exists (select 1 from bp_artifact_revisions ar join bp_artifacts artifact on (artifact.project_id,artifact.id)=(ar.project_id,ar.artifact_id)
                where ar.project_id=proposal.project_id and ar.id=proposal.evidence->>refs.field and artifact.type_key=refs.type and artifact.status='supplied'
                  and (artifact.allowed_user_ids is null or $5=any(artifact.allowed_user_ids))))))
      for update of d for share of a,x,r,w,c,cm,ch`,
    [projectId,workItemId,runId,decisionId,actor.id]);
    if (!row) throw new ProductError(404, 'decision_not_found', 'Decision not found.');
    requirePermission(project, row.release ? 'approve' : 'work');
    if (row.kind === 'invalid' || (row.kind === 'choice' && (!Array.isArray(row.choices) || !row.choices.includes(value)))) throw new ProductError(422, 'invalid_decision', 'Choose one of the available options.');
    if (row.state === 'Answered') {
      if (row.answer !== value || row.answeredBy !== actor.id) throw new ProductError(409, 'decision_conflict', 'The decision has already been answered.');
      return { decisionId, state: 'Answered' as const };
    }
    if (row.state !== 'Pending') throw new ProductError(409, 'decision_unavailable', 'The decision is no longer pending.');
    if (row.release) await recordReleaseApproval(tx, actor, projectId, runId, decisionId, value);
    await tx.unsafe(`update bp_workflow_decisions set state='Answered',answer=$4::text::jsonb,answered_by=$5,answered_at=now()
      where project_id=$1 and run_id=$2 and id=$3`, [projectId,runId,decisionId,JSON.stringify(value),actor.id]);
    await tx.unsafe(`insert into bp_decision_signal_intents(project_id,run_id,decision_id) values($1,$2,$3)`, [projectId,runId,decisionId]);
    return { decisionId, state: 'Answered' as const };
  });
}

/** Retryable delivery of a previously committed answer, never a model-selected address. */
export async function dispatchPendingDecision(module: ProductModule) {
  const endpoint = process.env.WORKFLOW_ENGINE_URL, token = process.env.WORKFLOW_ENGINE_TOKEN;
  if (!endpoint || !token || token.length < 32) throw new ProductError(409, 'workflow_unconfigured', 'The workflow engine is not configured.');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new ProductError(409, 'workflow_unconfigured', 'The workflow engine address is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ProductError(409, 'workflow_unconfigured', 'The workflow engine address is invalid.');
  let attempted: { projectId: string; runId: string; decisionId: string } | undefined;
  try {
    return await module.database.begin(async tx => {
      const [row] = await tx.unsafe<{ projectId: string; runId: string; decisionId: string; installationId: string; answer: string; receiptState: string }>(`
        select i.project_id as "projectId",i.run_id as "runId",i.decision_id as "decisionId",p.installation_id as "installationId",d.answer,x.state as "receiptState"
        from bp_decision_signal_intents i join bp_workflow_decisions d on (d.project_id,d.run_id,d.id)=(i.project_id,i.run_id,i.decision_id)
        left join bp_phase_decision_bindings b on (b.project_id,b.run_id,b.decision_id)=(i.project_id,i.run_id,i.decision_id)
        left join bp_phase_clarifications clar on (clar.project_id,clar.run_id,clar.decision_id)=(i.project_id,i.run_id,i.decision_id)
        left join bp_release_decision_bindings release on (release.project_id,release.run_id,release.decision_id)=(i.project_id,i.run_id,i.decision_id)
        join bp_phase_activity_receipts x on x.project_id=i.project_id and x.run_id=i.run_id
          and x.occurrence_id=coalesce(b.occurrence_id,clar.occurrence_id) and x.attempt=coalesce(b.attempt,clar.attempt)
        join bp_workflow_runs r on (r.project_id,r.id)=(i.project_id,i.run_id)
        join bp_work_items w on (w.project_id,w.id)=(r.project_id,r.work_item_id)
        join bp_projects p on p.id=r.project_id
        join bp_memberships m on m.project_id=p.id and m.user_id=d.answered_by
        join bp_conversations c on c.project_id=w.project_id and c.native_channel_id=w.native_channel_id
        join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=d.answered_by
        join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
        where i.state='Pending' and i.next_attempt_at<=now() and d.state='Answered' and p.state='Operational'
          and ((b.decision_id is not null) <> (clar.decision_id is not null))
          and 'read'=any(m.permissions) and (case when release.decision_id is not null then 'approve' else 'work' end)=any(m.permissions)
        order by i.created_at,i.project_id,i.run_id limit 1 for update of i skip locked for share of d,r,w,p,m,c,cm,ch`);
      if (!row) return false;
      attempted = row;
      if (row.receiptState !== 'Completed') {
        const response = await fetch(new URL('/decision', url), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ run: { installationId: row.installationId, projectId: row.projectId, runId: row.runId }, decisionId: row.decisionId, value: row.answer }) });
        const result = await response.json().catch(() => null) as { accepted?: unknown } | null;
        if (!response.ok || result?.accepted !== true) throw new ProductError(409, 'workflow_unavailable', 'The workflow engine did not confirm the decision.');
      }
      await tx.unsafe(`update bp_decision_signal_intents set state='Sent',sent_at=now() where project_id=$1 and run_id=$2 and decision_id=$3 and state='Pending'`, [row.projectId,row.runId,row.decisionId]);
      return true;
    });
  } catch (error) {
    if (attempted) await module.database.unsafe(`update bp_decision_signal_intents set failures=failures+1,next_attempt_at=now()+interval '30 seconds'
      where project_id=$1 and run_id=$2 and decision_id=$3 and state='Pending'`, [attempted.projectId,attempted.runId,attempted.decisionId]);
    throw error;
  }
}
