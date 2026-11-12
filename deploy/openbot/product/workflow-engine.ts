import { ProductError } from './access.js';
import type { ProductModule } from './module.js';
import { contentDigest, type JsonValue } from './store.js';
import { workspaceCall } from './workspace.js';
import type { Blueprint } from './contract/types.js';

type PendingRun = {
  projectId: string; runId: string; occurrenceId: string; attempt: number; installationId: string;
  planDigest: string; plan: { workflow?: { startPhase?: unknown; phases?: unknown } }; definition: Blueprint;
};

/** Dispatch a durable initial intent. A failed or ambiguous call leaves it pending for safe retry. */
export async function dispatchPendingWorkflow(module: ProductModule) {
  const endpoint = process.env.WORKFLOW_ENGINE_URL, token = process.env.WORKFLOW_ENGINE_TOKEN;
  if (!endpoint || !token || token.length < 32) throw new ProductError(409, 'workflow_unconfigured', 'The workflow engine is not configured.');
  return module.database.begin(async transaction => {
    const [run] = await transaction.unsafe<PendingRun>(`
      select d.project_id as "projectId", d.run_id as "runId", d.occurrence_id as "occurrenceId",
        d.attempt, p.installation_id as "installationId", r.plan_digest as "planDigest", r.plan, b.definition
      from bp_dispatch_intents d
      join bp_workflow_runs r on r.project_id=d.project_id and r.id=d.run_id
      join bp_phase_occurrences o on o.project_id=d.project_id and o.run_id=d.run_id and o.id=d.occurrence_id
      join bp_projects p on p.id=d.project_id
      join bp_blueprint_versions b on b.blueprint_key=p.blueprint_key and b.version=p.blueprint_version
      join bp_work_items w on w.project_id=r.project_id and w.id=r.work_item_id
      join bp_memberships m on m.project_id=p.id and m.user_id=w.requested_by
      join bp_conversations c on c.project_id=p.id and c.native_channel_id=w.native_channel_id
      join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=w.requested_by
      join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
      where d.state='Pending' and d.attempt=1 and o.occurrence=1 and r.state='Pending'
        and p.state='Operational' and 'read'=any(m.permissions) and 'work'=any(m.permissions)
      order by d.created_at, d.project_id, d.run_id
      limit 1 for update of d skip locked
    `);
    if (!run) return false;
    // Hold the same project and membership locks used by archive and grant changes until dispatch completes.
    await transaction.unsafe(`select p.id from bp_projects p
      join bp_workflow_runs r on r.project_id=p.id and r.id=$2
      join bp_work_items w on w.project_id=r.project_id and w.id=r.work_item_id
      join bp_memberships m on m.project_id=p.id and m.user_id=w.requested_by
      join bp_conversations c on c.project_id=p.id and c.native_channel_id=w.native_channel_id
      join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=w.requested_by
      join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
      where p.id=$1 and p.state='Operational' and 'read'=any(m.permissions) and 'work'=any(m.permissions)
      for share of p,m,c,cm,ch`, [run.projectId, run.runId]).then(rows => {
      if (!rows.length) throw new ProductError(409, 'dispatch_denied', 'The project or request is no longer authorized.');
    });
    const business = run.definition?.business;
    if (!business) throw new ProductError(409, 'blueprint_unavailable', 'The project blueprint is unavailable.');
    const reports = await transaction.unsafe<{ roleKey: string; revision: number; reportedRevision: number; status: string }>(`
      select a.role_key as "roleKey",a.revision,r.assignment_revision as "reportedRevision",r.status
      from bp_assignments a join bp_readiness r on r.project_id=a.project_id and r.assignment_id=a.id
      where a.project_id=$1 for share of a,r
    `, [run.projectId]);
    if (reports.length !== business.roles.length || business.roles.some(role => !reports.some(report =>
      report.roleKey === role.id && report.revision === report.reportedRevision && report.status === 'Ready'))) {
      throw new ProductError(409, 'readiness_stale', 'The project team must complete current readiness checks before work starts.');
    }
    if (business.initialization.workspace.kind === 'vm') {
      const [vm] = await transaction.unsafe<{ providerId: string | null; state: string }>(
        'select provider_id as "providerId",state from bp_project_vms where project_id=$1 for share', [run.projectId],
      );
      if (!vm?.providerId || vm.state !== 'Ready') throw new ProductError(409, 'workspace_unavailable', 'The project workspace is unavailable.');
      const health = await workspaceCall('check', { installationId: run.installationId, projectId: run.projectId });
      if (!health.ready || !health.isolated || health.id !== vm.providerId) throw new ProductError(409, 'workspace_unavailable', 'The project workspace or its isolation is unavailable.');
    }
    if (!run.plan || typeof run.plan !== 'object' || contentDigest(run.plan as unknown as JsonValue) !== run.planDigest) {
      throw new ProductError(409, 'workflow_plan_invalid', 'The pinned workflow plan could not be verified.');
    }
    const workflow = run.plan.workflow;
    const phases = Array.isArray(workflow?.phases) ? workflow.phases : [];
    const phaseIds = phases.map(phase => phase && typeof phase === 'object' ? (phase as { id?: unknown }).id : undefined);
    if (typeof workflow?.startPhase !== 'string' || phaseIds.some(id => typeof id !== 'string') || !phaseIds.includes(workflow.startPhase)) {
      throw new ProductError(409, 'workflow_plan_invalid', 'The pinned workflow phases could not be verified.');
    }
    const response = await fetch(new URL('/start', endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ run: { installationId: run.installationId, projectId: run.projectId, runId: run.runId,
        planDigest: run.planDigest, initialPhase: workflow.startPhase, phaseIds } }),
    });
    if (!response.ok) throw new ProductError(409, 'workflow_unavailable', 'The workflow engine did not confirm dispatch.');
    const result = await response.json() as { workflowId?: unknown; existing?: unknown };
    if (typeof result.workflowId !== 'string' || typeof result.existing !== 'boolean') throw new ProductError(409, 'workflow_unavailable', 'The workflow engine returned an invalid response.');
    await transaction.unsafe("update bp_dispatch_intents set state='Dispatched',updated_at=now() where project_id=$1 and run_id=$2 and occurrence_id=$3 and attempt=$4 and state='Pending'", [run.projectId, run.runId, run.occurrenceId, run.attempt]);
    await transaction.unsafe("update bp_workflow_runs set state='Running',revision=revision+1,updated_at=now() where project_id=$1 and id=$2 and state='Pending'", [run.projectId, run.runId]);
    return true;
  });
}
