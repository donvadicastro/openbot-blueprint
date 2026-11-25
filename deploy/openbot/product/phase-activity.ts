import { ProductError, type ProductQuery } from "./access.js";
import { contentDigest, type JsonValue } from "./store.js";
import { requireReadyReports, requireReadyWorkspace } from "./readiness-gate.js";
import type { Blueprint, BusinessWorkflow } from "./contract/types.js";

export type PhaseRequest = { installationId: string; projectId: string; runId: string; planDigest: string;
  phase: string; occurrence: number; operationKey: string };

function validatePhaseRequest(request: PhaseRequest) {
  const invalid = () => new ProductError(409, "phase_unavailable", "The requested workflow phase cannot be verified.");
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      ![request.installationId, request.projectId, request.runId, request.phase].every(v => typeof v === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(v)) ||
      typeof request.planDigest !== 'string' || !/^[a-f0-9]{64}$/.test(request.planDigest) ||
      !Number.isSafeInteger(request.occurrence) || request.occurrence < 1 || request.operationKey !== `${request.runId}:${request.occurrence}`) throw invalid();
}

/** Resolve a worker request under locks before dispatching any specialist or effect. */
export async function resolvePhaseActivity(tx: ProductQuery, request: PhaseRequest) {
  const invalid = () => new ProductError(409, "phase_unavailable", "The requested workflow phase cannot be verified.");
  validatePhaseRequest(request);
  const [row] = await tx.unsafe<{
    state: string; currentPhase: string; runRevision: number; planDigest: string; plan: { workflow: BusinessWorkflow }; definition: Blueprint;
    occurrenceId: string; attempt: number; inputRevisions: { type: string; revisionId: string }[]; actionId: string; assignmentId: string; role: string; botId: string; actorId: string; channelId: string; requestText: string;
  }>(`select r.state,r.current_phase as "currentPhase",r.revision as "runRevision",r.plan_digest as "planDigest",r.plan,b.definition,
      o.id as "occurrenceId",at.attempt,at.input_revisions as "inputRevisions",o.action_key as "actionId",a.id as "assignmentId",a.role_key as role,a.native_bot_id as "botId",
      w.requested_by as "actorId",w.native_channel_id as "channelId",w.request as "requestText"
    from bp_workflow_runs r join bp_projects p on p.id=r.project_id
    join bp_blueprint_versions b on b.blueprint_key=p.blueprint_key and b.version=p.blueprint_version
    join bp_work_items w on w.project_id=r.project_id and w.id=r.work_item_id
    join bp_memberships m on m.project_id=p.id and m.user_id=w.requested_by
    join bp_conversations c on c.project_id=p.id and c.native_channel_id=w.native_channel_id
    join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=w.requested_by
    join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
    join bp_phase_occurrences o on o.project_id=r.project_id and o.run_id=r.id and o.phase_key=$4 and o.occurrence=$5 and o.operation_key=$6
    join bp_assignments a on a.project_id=o.project_id and a.id=o.assignment_id
    join bp_action_attempts at on at.project_id=o.project_id and at.run_id=o.run_id and at.occurrence_id=o.id
      and at.attempt=(select max(latest.attempt) from bp_action_attempts latest where latest.project_id=o.project_id and latest.run_id=o.run_id and latest.occurrence_id=o.id)
    join bp_dispatch_intents d on d.project_id=at.project_id and d.run_id=at.run_id and d.occurrence_id=at.occurrence_id and d.attempt=at.attempt and d.operation_key=o.operation_key
    where p.installation_id=$1 and p.id=$2 and r.id=$3 and p.state='Operational'
      and 'read'=any(m.permissions) and 'work'=any(m.permissions)
      and at.state in ('Pending','Running') and d.state='Dispatched'
    for share of r,p,b,w,m,c,cm,ch,o,a,at,d`, [request.installationId, request.projectId, request.runId, request.phase, request.occurrence, request.operationKey]);
  if (!row || row.state !== 'Running' || row.currentPhase !== request.phase || row.planDigest !== request.planDigest ||
      contentDigest(row.plan as unknown as JsonValue) !== row.planDigest) throw invalid();
  const business = row.definition?.business, phase = row.plan?.workflow?.phases?.find(item => item.id === request.phase);
  const action = business?.actions.find(item => item.id === row.actionId);
  const role = business?.roles.find(item => item.id === row.role);
  if (!business || !phase || phase.action !== row.actionId || !action || action.role !== row.role ||
      !role || role.agentId !== row.botId || !role.actions.includes(action.id)) throw invalid();
  const conflicts = await tx.unsafe(`select id from bp_memory_conflicts where project_id=$1 and assignment_id=$2 and state='Pending' for share`,
    [request.projectId, row.assignmentId]);
  if (conflicts.length) throw new ProductError(409, 'guidance_conflict_pending', 'The specialist has feedback that needs clarification before work continues.');
  await requireReadyReports(tx, request.projectId, business.roles);
  await requireReadyWorkspace(tx, { id: request.projectId, installationId: request.installationId }, business);
  if (!Array.isArray(row.inputRevisions) || row.inputRevisions.length !== action.inputTypes.length ||
      new Set(row.inputRevisions.map(input => input?.type)).size !== row.inputRevisions.length ||
      action.inputTypes.some(type => !row.inputRevisions.some(input => input?.type === type && typeof input.revisionId === 'string' && input.revisionId))) throw invalid();
  for (const input of row.inputRevisions) {
    const artifactType = business.artifactTypes.find(type => type.id === input.type);
    if (!artifactType || !(artifactType.owner === role.id || artifactType.producers.includes(role.id) || artifactType.consumers.includes(role.id))) throw invalid();
    const matches = await tx.unsafe<{ digest: string; payload: JsonValue }>(`select r.digest,r.payload from bp_artifacts a
      join bp_artifact_revisions r on r.project_id=a.project_id and r.artifact_id=a.id
      where a.project_id=$1 and a.type_key=$2 and r.id=$3 and a.status='supplied'
        and (a.allowed_user_ids is null or $4=any(a.allowed_user_ids))
        and not exists (select 1 from bp_artifact_revisions newer where newer.project_id=r.project_id and newer.artifact_id=r.artifact_id
          and (newer.created_at,newer.id)>(r.created_at,r.id)) for share of a,r`, [request.projectId, input.type, input.revisionId, row.actorId]);
    if (matches.length !== 1 || matches[0].digest !== contentDigest(matches[0].payload)) {
      throw new ProductError(409, 'workflow_input_stale', 'A required input is unavailable or has changed.');
    }
  }
  return { ...row, action, role };
}

/** Claim an active attempt once. The caller must commit before invoking the bot. */
export async function claimPhaseActivity(tx: ProductQuery, request: PhaseRequest) {
  validatePhaseRequest(request);
  await tx.unsafe('select id from bp_workflow_runs where project_id=$1 and id=$2 for update', [request.projectId, request.runId]);
  const phase = await resolvePhaseActivity(tx, request);
  const digest = contentDigest(request as unknown as JsonValue);
  const [receipt] = await tx.unsafe<{ requestDigest: string; state: string; outcome: unknown }>(`
    select request_digest as "requestDigest",state,outcome from bp_phase_activity_receipts
    where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 for update`,
  [request.projectId, request.runId, phase.occurrenceId, phase.attempt]);
  if (receipt) {
    if (receipt.requestDigest !== digest) throw new ProductError(409, "phase_conflict", "The phase attempt is already bound to another request.");
    if (receipt.state === 'Completed') return { status: 'completed' as const, outcome: receipt.outcome };
    return { status: 'uncertain' as const };
  }
  await tx.unsafe(`insert into bp_phase_activity_receipts(project_id,run_id,occurrence_id,attempt,request_digest,state)
    values($1,$2,$3,$4,$5,'Running')`, [request.projectId, request.runId, phase.occurrenceId, phase.attempt, digest]);
  await tx.unsafe(`update bp_action_attempts set state='Running' where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 and state='Pending'`,
    [request.projectId, request.runId, phase.occurrenceId, phase.attempt]);
  return { status: 'claimed' as const, phase };
}

/** Read a durable receipt without repeating a bot or effect after a lost reply. */
export async function reconcilePhaseActivity(tx: ProductQuery, request: PhaseRequest) {
  validatePhaseRequest(request);
  const [receipt] = await tx.unsafe<{ requestDigest: string; state: string; outcome: unknown; planDigest: string; plan: JsonValue }>(`
    select x.request_digest as "requestDigest",x.state,x.outcome,r.plan_digest as "planDigest",r.plan
    from bp_workflow_runs r join bp_projects p on p.id=r.project_id
    join bp_work_items w on w.project_id=r.project_id and w.id=r.work_item_id
    join bp_memberships m on m.project_id=p.id and m.user_id=w.requested_by
    join bp_conversations c on c.project_id=p.id and c.native_channel_id=w.native_channel_id
    join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=w.requested_by
    join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
    join bp_phase_occurrences o on o.project_id=r.project_id and o.run_id=r.id and o.phase_key=$4 and o.occurrence=$5 and o.operation_key=$6
    join bp_phase_activity_receipts x on x.project_id=o.project_id and x.run_id=o.run_id and x.occurrence_id=o.id
      and x.attempt=(select max(latest.attempt) from bp_action_attempts latest where latest.project_id=o.project_id and latest.run_id=o.run_id and latest.occurrence_id=o.id)
    where p.installation_id=$1 and p.id=$2 and r.id=$3 and p.state='Operational'
      and 'read'=any(m.permissions) and 'work'=any(m.permissions)
    order by x.attempt desc limit 1 for share of r,p,w,m,c,cm,ch,o,x`,
  [request.installationId, request.projectId, request.runId, request.phase, request.occurrence, request.operationKey]);
  if (!receipt) {
    // Only an active, authorized attempt can be reported as not started.
    await resolvePhaseActivity(tx, request);
    return { kind: 'not-started' as const };
  }
  if (receipt.planDigest !== request.planDigest || contentDigest(receipt.plan) !== receipt.planDigest ||
      receipt.requestDigest !== contentDigest(request as unknown as JsonValue)) {
    throw new ProductError(409, "phase_conflict", "The phase attempt is already bound to another request.");
  }
  if (receipt.state === 'Completed') return { kind: 'completed' as const, outcome: receipt.outcome };
  return { kind: 'uncertain' as const, reason: 'The specialist result has not been confirmed.' };
}
