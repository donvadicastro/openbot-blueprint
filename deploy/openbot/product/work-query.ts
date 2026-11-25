import { ProductError, requireProject, type ProductActor } from './access.js';
import type { ProductModule } from './module.js';

/** List only work whose originating conversation is visible to this actor. */
export async function listWorkItems(module: ProductModule, actor: ProductActor, projectId: string) {
  return module.database.begin(async tx => {
    await requireProject(tx, actor, projectId, 'read');
    return tx.unsafe<{ id: string; request: string; conversationId: string; createdAt: string }>(`
      select w.id,w.request,w.native_channel_id as "conversationId",w.created_at as "createdAt"
      from bp_work_items w join bp_conversations c on c.project_id=w.project_id and c.native_channel_id=w.native_channel_id
      join channel_memberships m on m.channel_id=c.native_channel_id and m.user_id=$2
      join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
      where w.project_id=$1 order by w.created_at desc,w.id desc limit 100 for share of w,c,m,ch`, [projectId,actor.id]);
  });
}

/** Read workflow progress only through its originating, currently accessible conversation. */
export async function readWorkItem(module: ProductModule, actor: ProductActor, projectId: string, workItemId: string) {
  if (typeof workItemId !== 'string' || !workItemId || workItemId.length > 200) throw new ProductError(404, 'work_item_not_found', 'Work item not found.');
  return module.database.begin(async tx => {
    const project = await requireProject(tx, actor, projectId, 'read');
    const [work] = await tx.unsafe<{ id: string; conversationId: string; request: string; createdAt: string; isRequester: boolean }>(`
      select w.id,w.native_channel_id as "conversationId",w.request,w.created_at as "createdAt",(w.requested_by=$3) as "isRequester"
      from bp_work_items w join bp_conversations c on c.project_id=w.project_id and c.native_channel_id=w.native_channel_id
      join channel_memberships m on m.channel_id=c.native_channel_id and m.user_id=$3
      join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
      where w.project_id=$1 and w.id=$2 for share of w,c,m,ch`, [projectId, workItemId, actor.id]);
    if (!work) throw new ProductError(404, 'work_item_not_found', 'Work item not found.');
    const runs = await tx.unsafe<{ id: string; workflow: string | null; state: string; currentPhase: string; revision: number; createdAt: string; updatedAt: string }>(`
      select id,workflow_key as workflow,state,current_phase as "currentPhase",revision,created_at as "createdAt",updated_at as "updatedAt"
      from bp_workflow_runs where project_id=$1 and work_item_id=$2 order by created_at,id for share`, [projectId, workItemId]);
    const result = [];
    for (const run of runs) {
      const attempts = await tx.unsafe(`select o.id as "occurrenceId",o.phase_key as phase,o.occurrence,o.action_key as action,
        o.assignment_id as "assignmentId",a.attempt,coalesce(retry.attempt_number,1) as "retryNumber",a.state,
        case when exists (select 1 from bp_workflow_runs owner_run join bp_work_items owner_item
            on (owner_item.project_id,owner_item.id)=(owner_run.project_id,owner_run.work_item_id)
            where owner_run.project_id=a.project_id and owner_run.id=a.run_id and owner_item.requested_by=$3)
          and not exists (select 1 from jsonb_array_elements(a.input_revisions || a.output_revisions) ref
          where not exists (select 1 from bp_artifact_revisions ar join bp_artifacts artifact on (artifact.project_id,artifact.id)=(ar.project_id,ar.artifact_id)
            where ar.project_id=a.project_id and ar.id=ref->>'revisionId' and artifact.type_key=ref->>'type' and artifact.status='supplied'
              and (artifact.allowed_user_ids is null or $3=any(artifact.allowed_user_ids)))) then a.reason else null end as reason,
        a.started_at as "startedAt",a.finished_at as "finishedAt",
        d.state as dispatch,coalesce((select jsonb_agg(jsonb_build_object('code',rejected.code,'createdAt',rejected.created_at) order by rejected.created_at)
          from bp_phase_result_rejections rejected where rejected.project_id=a.project_id and rejected.run_id=a.run_id
            and rejected.occurrence_id=a.occurrence_id and rejected.attempt=a.attempt),'[]'::jsonb) as rejections,
        exists(select 1 from bp_memory_conflicts x
          join bp_memory_revisions original on (original.project_id,original.assignment_id,original.entry_id,original.revision)=(x.project_id,x.assignment_id,x.entry_id,x.base_revision)
          join bp_conversations oldc on oldc.project_id=x.project_id and oldc.native_channel_id=original.feedback_source->>'conversationId'
          join channel_memberships oldm on oldm.channel_id=oldc.native_channel_id and oldm.user_id=$3
          join channels oldch on oldch.id=oldc.native_channel_id and oldch.deleted_at is null
          join bp_conversations newc on newc.project_id=x.project_id and newc.native_channel_id=x.feedback_source->>'conversationId'
          join channel_memberships newm on newm.channel_id=newc.native_channel_id and newm.user_id=$3
          join channels newch on newch.id=newc.native_channel_id and newch.deleted_at is null
          where x.project_id=o.project_id and x.assignment_id=o.assignment_id and x.state='Pending') as "feedbackClarification"
        from bp_phase_occurrences o
        join bp_action_attempts a on a.project_id=o.project_id and a.run_id=o.run_id and a.occurrence_id=o.id
        left join bp_phase_retry_lineage retry on (retry.project_id,retry.run_id,retry.occurrence_id)=(o.project_id,o.run_id,o.id)
        left join bp_dispatch_intents d on d.project_id=a.project_id and d.run_id=a.run_id and d.occurrence_id=a.occurrence_id and d.attempt=a.attempt
        where o.project_id=$1 and o.run_id=$2 order by o.created_at,o.occurrence,a.attempt for share of o,a`, [projectId, run.id, actor.id]);
      const decisions = await tx.unsafe(`select d.id,d.state,d.question,b.choices,
          case when b.decision_id is not null then 'choice' else 'clarification' end as kind,
          (release.decision_id is not null) as approval,
          exists(select 1 from bp_memberships member where member.project_id=d.project_id and member.user_id=$3
            and (case when release.decision_id is not null then 'approve' else 'work' end)=any(member.permissions)) as "canAnswer",
          d.created_at as "createdAt",d.answered_at as "answeredAt",i.state as "deliveryState" from bp_workflow_decisions d
        left join bp_phase_decision_bindings b on (b.project_id,b.run_id,b.decision_id)=(d.project_id,d.run_id,d.id)
        left join bp_phase_clarifications clar on (clar.project_id,clar.run_id,clar.decision_id)=(d.project_id,d.run_id,d.id)
        left join bp_release_decision_bindings release on (release.project_id,release.run_id,release.decision_id)=(d.project_id,d.run_id,d.id)
        join bp_action_attempts a on a.project_id=d.project_id and a.run_id=d.run_id and a.occurrence_id=coalesce(b.occurrence_id,clar.occurrence_id) and a.attempt=coalesce(b.attempt,clar.attempt)
        join bp_phase_results x on (x.project_id,x.run_id,x.occurrence_id,x.attempt)=(a.project_id,a.run_id,a.occurrence_id,a.attempt)
        left join bp_decision_signal_intents i on (i.project_id,i.run_id,i.decision_id)=(d.project_id,d.run_id,d.id)
        where d.project_id=$1 and d.run_id=$2 and ((b.decision_id is not null) <> (clar.decision_id is not null))
          and not exists (select 1 from jsonb_array_elements(a.input_revisions || (x.result->'outputs')) ref
            where not exists (select 1 from bp_artifact_revisions ar join bp_artifacts artifact on artifact.project_id=ar.project_id and artifact.id=ar.artifact_id
              where ar.project_id=d.project_id and ar.id=ref->>'revisionId' and artifact.type_key=ref->>'type' and artifact.status='supplied'
                and (artifact.allowed_user_ids is null or $3=any(artifact.allowed_user_ids))))
          and (release.decision_id is null or exists (select 1 from bp_release_proposals proposal
            where (proposal.project_id,proposal.run_id,proposal.id)=(release.project_id,release.run_id,release.proposal_id)
              and not exists (select 1 from (values ('candidateRevision','candidate'),('qaEvidenceRevision','qa-evidence'),
                ('briefRevision','change-brief'),('planRevision','test-plan'),('runbookRevision','release-runbook'),('targetRevision','release-target')) refs(field,type)
                where not exists (select 1 from bp_artifact_revisions ar join bp_artifacts artifact on (artifact.project_id,artifact.id)=(ar.project_id,ar.artifact_id)
                  where ar.project_id=proposal.project_id and ar.id=proposal.evidence->>refs.field and artifact.type_key=refs.type and artifact.status='supplied'
                    and (artifact.allowed_user_ids is null or $3=any(artifact.allowed_user_ids))))))
        order by d.created_at,d.id for share of d,a,x`, [projectId, run.id, actor.id]);
      const qaProgress = await tx.unsafe(`select e.scenario_id as "scenarioId",e.status,e.observed,e.reason,e.evidence_id as "evidenceId",
          scenario.value->'steps' as steps,scenario.value->>'expected' as expected,
          (select report_revision.payload->>'verdict' from bp_phase_results accepted,
            jsonb_array_elements(accepted.result->'outputs') output
            join bp_artifact_revisions report_revision on report_revision.project_id=e.project_id and report_revision.id=output->>'revisionId'
            join bp_artifacts report on (report.project_id,report.id)=(report_revision.project_id,report_revision.artifact_id)
            where accepted.project_id=e.project_id and accepted.run_id=e.run_id and accepted.occurrence_id=e.occurrence_id and accepted.attempt=e.attempt
              and accepted.result->>'status'='succeeded'
              and output->>'type'='qa-evidence' and report.type_key='qa-evidence' and report.status='supplied'
              and report_revision.payload->>'planRevision'=e.plan_revision and report_revision.payload->>'candidateRevision'=e.candidate_revision
              and (report.allowed_user_ids is null or $3=any(report.allowed_user_ids)) limit 1) as "reportVerdict",
          e.created_at as "updatedAt",o.phase_key as phase,o.id as "occurrenceId",e.attempt,
          jsonb_array_length(plan.payload->'scenarios') as total,
          (exists(select 1 from bp_artifact_revisions newer where newer.project_id=candidate.project_id and newer.artifact_id=candidate.artifact_id and (newer.created_at,newer.id)>(candidate.created_at,candidate.id)) or
           exists(select 1 from bp_artifact_revisions newer where newer.project_id=plan.project_id and newer.artifact_id=plan.artifact_id and (newer.created_at,newer.id)>(plan.created_at,plan.id)) or
           exists(select 1 from bp_artifact_revisions newer where newer.project_id=brief.project_id and newer.artifact_id=brief.artifact_id and (newer.created_at,newer.id)>(brief.created_at,brief.id))) as stale
        from bp_qa_scenario_events e
        join bp_phase_occurrences o on (o.project_id,o.run_id,o.id)=(e.project_id,e.run_id,e.occurrence_id)
        join bp_artifact_revisions candidate on candidate.project_id=e.project_id and candidate.id=e.candidate_revision
        join bp_artifacts ca on ca.project_id=candidate.project_id and ca.id=candidate.artifact_id and ca.type_key='candidate'
        join bp_artifact_revisions plan on plan.project_id=e.project_id and plan.id=e.plan_revision
        join bp_artifacts pa on pa.project_id=plan.project_id and pa.id=plan.artifact_id and pa.type_key='test-plan'
        join lateral (select item.value from jsonb_array_elements(plan.payload->'scenarios') item where item.value->>'id'=e.scenario_id limit 1) scenario on true
        join bp_artifact_revisions brief on brief.project_id=e.project_id and brief.id=plan.payload->>'briefRevision'
        join bp_artifacts ba on ba.project_id=brief.project_id and ba.id=brief.artifact_id and ba.type_key='change-brief'
        where e.project_id=$1 and e.run_id=$2
          and ca.status='supplied' and pa.status='supplied' and ba.status='supplied'
          and (ca.allowed_user_ids is null or $3=any(ca.allowed_user_ids))
          and (pa.allowed_user_ids is null or $3=any(pa.allowed_user_ids))
          and (ba.allowed_user_ids is null or $3=any(ba.allowed_user_ids))
          and not exists (select 1 from bp_artifacts report join bp_artifact_revisions report_revision
            on report_revision.project_id=report.project_id and report_revision.artifact_id=report.id
            where report.project_id=e.project_id and report.type_key='qa-evidence'
              and report_revision.payload->>'planRevision'=e.plan_revision
              and (report.status<>'supplied' or (report.allowed_user_ids is not null and not ($3=any(report.allowed_user_ids)))))
          and not exists (select 1 from bp_qa_scenario_events newer where newer.project_id=e.project_id and newer.run_id=e.run_id
            and newer.occurrence_id=e.occurrence_id and newer.attempt=e.attempt and newer.scenario_id=e.scenario_id and newer.sequence>e.sequence)
        order by o.created_at,e.scenario_id for share of e,o,candidate,ca,plan,pa,brief,ba`, [projectId,run.id,actor.id]);
      result.push({ ...run, canRecover: work.isRequester && project.permissions.includes('work') && project.state === 'Operational' && run.state === 'Running', attempts, decisions, qaProgress });
    }
    return { ...work, runs: result };
  });
}
