import { ProductError, requireProject, type ProductActor } from './access.js';
import type { ProductModule } from './module.js';
import { readWorkItem } from './work-query.js';
import { contentDigest, roleMayReadArtifact, type JsonValue } from './store.js';

/** Build a fresh, viewer-specific state; never accept a projection from a client. */
export async function readChatProjection(module: ProductModule, actor: ProductActor, projectId: string,
  workItemId: string, runId: string, viewId: string) {
  const project = await requireProject(module.database, actor, projectId, 'read');
  const definition = await module.definitionFor(project);
  const view = definition.business?.views.find(item => item.id === viewId);
  if (!view) throw new ProductError(404, 'chat_view_not_found', 'Chat view not found.');
  const work = await readWorkItem(module, actor, projectId, workItemId);
  const run = work.runs.find(item => item.id === runId);
  if (!run) throw new ProductError(404, 'chat_view_not_found', 'Chat view not found.');
  const allowedTypes = view.recordTypes.filter(type => roleMayReadArtifact(definition.business?.artifactTypes.find(item => item.id === type), view.role));
  const fields = [...new Set([...view.summaryFields, ...view.detailFields])];
  // Only records used or produced by this run can appear. Every referenced
  // input/output of the associated attempt must also be visible to the viewer.
  const rows = await module.database.unsafe<{ type: string; revisionId: string; digest: string; payload: Record<string, JsonValue>; stale: boolean }>(`
    select distinct a.type_key as type,r.id as "revisionId",r.digest,r.payload,
      exists(select 1 from bp_artifact_revisions newer where newer.project_id=r.project_id and newer.artifact_id=r.artifact_id
        and (newer.created_at,newer.id)>(r.created_at,r.id)) as stale
    from bp_artifacts a join bp_artifact_revisions r on (r.project_id,r.artifact_id)=(a.project_id,a.id)
    join bp_workflow_runs run on run.project_id=a.project_id and run.id=$3
    join bp_work_items w on (w.project_id,w.id)=(run.project_id,run.work_item_id) and w.id=$2
    join bp_memberships m on m.project_id=run.project_id and m.user_id=$4 and 'read'=any(m.permissions)
    join bp_conversations c on c.project_id=w.project_id and c.native_channel_id=w.native_channel_id
    join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=$4
    join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
    where a.project_id=$1 and a.type_key in (select jsonb_array_elements_text($5::text::jsonb)) and a.status='supplied'
      and (a.allowed_user_ids is null or $4=any(a.allowed_user_ids))
      and exists (select 1 from bp_action_attempts attempt
        left join bp_phase_results result on (result.project_id,result.run_id,result.occurrence_id,result.attempt)=(attempt.project_id,attempt.run_id,attempt.occurrence_id,attempt.attempt)
        where attempt.project_id=run.project_id and attempt.run_id=run.id
          and exists (select 1 from jsonb_array_elements(attempt.input_revisions || coalesce(result.result->'outputs','[]'::jsonb)) ref
            where ref->>'revisionId'=r.id and ref->>'type'=a.type_key)
          and not exists (select 1 from jsonb_array_elements(attempt.input_revisions || coalesce(result.result->'outputs','[]'::jsonb)) ref
            where not exists (select 1 from bp_artifact_revisions ar join bp_artifacts artifact on (artifact.project_id,artifact.id)=(ar.project_id,ar.artifact_id)
              where ar.project_id=attempt.project_id and ar.id=ref->>'revisionId' and artifact.type_key=ref->>'type' and artifact.status='supplied'
                and (artifact.allowed_user_ids is null or $4=any(artifact.allowed_user_ids))))
          and not exists (select 1 from jsonb_array_elements(attempt.input_revisions || coalesce(result.result->'outputs','[]'::jsonb)) ref
            join bp_artifact_revisions qa on qa.project_id=attempt.project_id and qa.id=ref->>'revisionId' and ref->>'type'='qa-evidence'
            cross join (values ('briefRevision','change-brief'),('planRevision','test-plan')) dependency(field,type)
            where not exists (select 1 from bp_artifact_revisions ar join bp_artifacts artifact on (artifact.project_id,artifact.id)=(ar.project_id,ar.artifact_id)
              where ar.project_id=attempt.project_id and ar.id=qa.payload->>dependency.field and artifact.type_key=dependency.type and artifact.status='supplied'
                and (artifact.allowed_user_ids is null or $4=any(artifact.allowed_user_ids)))))
    order by a.type_key,r.id limit 100`, [projectId,workItemId,runId,actor.id,JSON.stringify(allowedTypes)]);
  const records = rows.filter(row => row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) && contentDigest(row.payload) === row.digest).map(row => ({ type: row.type, revisionId: row.revisionId, stale: row.stale,
    fields: Object.fromEntries(fields.filter(field => Object.prototype.hasOwnProperty.call(row.payload, field)).map(field => [field, row.payload[field]])) }));
  // QA progress is filtered by candidate, brief, plan and report access in readWorkItem.
  const qaProgress = view.role === 'qa' && view.recordTypes.includes('qa-evidence') ? run.qaProgress : [];
  return { projectId, conversationId: work.conversationId, workItemId, runId, viewId,
    role: view.role, state: run.state, phase: run.currentPhase, revision: run.revision, records, qaProgress };
}

/** A whole-value JSON Patch avoids retaining data removed by authorization changes. */
export function chatStateEvent(previous: unknown | undefined, current: unknown) {
  if (previous === undefined) return { type: 'STATE_SNAPSHOT' as const, snapshot: current };
  if (JSON.stringify(previous) === JSON.stringify(current)) return undefined;
  return { type: 'STATE_DELTA' as const, delta: [{ op: 'replace' as const, path: '', value: current }] };
}
