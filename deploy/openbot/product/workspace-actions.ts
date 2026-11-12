import { createHash } from "node:crypto";
import { ProductError, requireBotProject, requireOperational, requireProject, type ProductActor } from "./access.js";
import type { ProductModule } from "./module.js";
import { workspaceCall } from "./workspace.js";

/** Only call from a native authenticated bot turn; do not accept its identity or tool from user input. */
export async function authorizedWorkspaceAction(module: ProductModule, context: {
  actor: ProductActor; projectId: string; assignmentId: string; nativeBotId: string;
  actionId: string; tool: string; operationKey: string; channelId?: string;
}, argv?: string[]) {
  if (typeof context.operationKey !== "string" || !/^[a-zA-Z0-9._:-]{1,200}$/.test(context.operationKey)) {
    throw new ProductError(422, "invalid_operation", "A valid operation key is required.");
  }
  return module.database.begin(async transaction => {
  if (context.channelId) {
    const binding = await requireBotProject(transaction, context.actor, context.channelId, context.nativeBotId, "work");
    if (binding.project.id !== context.projectId || binding.assignmentId !== context.assignmentId) {
      throw new ProductError(404, "project_not_found", "Project not found.");
    }
  }
  const project = await requireProject(transaction, context.actor, context.projectId, "work");
  requireOperational(project);
  const [assignment] = await transaction.unsafe<{ roleKey: string; nativeBotId: string }>(
    'select role_key as "roleKey", native_bot_id as "nativeBotId" from bp_assignments where project_id=$1 and id=$2 for share',
    [project.id, context.assignmentId],
  );
  if (!assignment || assignment.nativeBotId !== context.nativeBotId) {
    throw new ProductError(403, "assignment_denied", "This bot is not assigned to the project.");
  }
  const definition = await module.definitionFor(project);
  const role = definition.business?.roles.find(item => item.id === assignment.roleKey);
  const agent = definition.agents.find(item => item.id === assignment.nativeBotId);
  if (!role || role.agentId !== assignment.nativeBotId || !role.actions.includes(context.actionId)
    || !agent?.tools.includes(context.tool) || !["workspace-edit", "test-runner"].includes(context.tool)) {
    throw new ProductError(403, "tool_denied", "This project role cannot use that tool for this action.");
  }
  const reports = await transaction.unsafe<{ roleKey: string; revision: number; reportedRevision: number; status: string }>(`
    select a.role_key as "roleKey",a.revision,r.assignment_revision as "reportedRevision",r.status
    from bp_assignments a join bp_readiness r on r.project_id=a.project_id and r.assignment_id=a.id
    where a.project_id=$1 for share of a,r`, [project.id]);
  if (!definition.business || reports.length !== definition.business.roles.length || definition.business.roles.some(item =>
    !reports.some(report => report.roleKey === item.id && report.revision === report.reportedRevision && report.status === "Ready"))) {
    throw new ProductError(409, "readiness_stale", "The project team must complete current readiness checks before work starts.");
  }
  const [vm] = await transaction.unsafe<{ providerId: string | null; sourceRevision: string | null; state: string }>(
    'select provider_id as "providerId", source_revision as "sourceRevision", state from bp_project_vms where project_id=$1 for share', [project.id],
  );
  if (!vm?.providerId || vm.state !== "Ready") {
    throw new ProductError(409, "workspace_unavailable", "The project workspace is unavailable.");
  }
  const binding = { installationId: project.installationId, projectId: project.id };
  const health = await workspaceCall("check", binding);
  if (health.id === vm.providerId && health.status === "IsolationUnverified") {
    throw new ProductError(409, "workspace_isolation_unverified", "The project workspace network isolation has not been verified.");
  }
  if (!health.ready || health.id !== vm.providerId) {
    throw new ProductError(409, "workspace_unavailable", "The project workspace is unavailable.");
  }
  if (health.isolated !== true) {
    throw new ProductError(409, "workspace_isolation_unverified", "The project workspace network isolation has not been verified.");
  }
  if (definition.business.artifactTypes.some(item => item.id === "source-code")) {
    const [source] = await transaction.unsafe<{ id: string }>(`select id from bp_artifacts
      where project_id=$1 and type_key='source-code' and status='supplied'
        and (allowed_user_ids is null or $2=any(allowed_user_ids)) for share`, [project.id, context.actor.id]);
    if (!source || !vm.sourceRevision) throw new ProductError(409, "workspace_source_unavailable", "The project source is unavailable to this user.");
    const state = await workspaceCall("source", binding);
    if (!state.hasProject || state.revision !== vm.sourceRevision) throw new ProductError(409, "workspace_source_unavailable", "The workspace source revision is not current.");
  }
  // A caller must not be able to retrieve another assignment's operation output
  // by guessing its operation key. Keep the derived key stable for retries.
  const operationKey = createHash("sha256").update(JSON.stringify([
    project.id, context.assignmentId, context.actionId, context.tool, context.operationKey,
  ])).digest("hex");
  return workspaceCall(argv ? "run" : "reconcile", { ...binding, operationKey, ...(argv ? { argv } : {}) });
  });
}

/** Bind a native bot callback to its authenticated conversation and recheck it at dispatch. */
export async function conversationWorkspaceAction(module: ProductModule, context: {
  actor: ProductActor; channelId: string; nativeBotId: string;
  actionId: string; tool: string; operationKey: string;
}, argv?: string[]) {
  const binding = await requireBotProject(module.database, context.actor, context.channelId, context.nativeBotId, "work");
  return authorizedWorkspaceAction(module, { ...context, projectId: binding.project.id, assignmentId: binding.assignmentId }, argv);
}
