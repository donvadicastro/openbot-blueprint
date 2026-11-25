import { createHash } from "node:crypto";
import { ProductError, requireBotProject, requireOperational, requireProject, type ProductActor, type ProductQuery } from "./access.js";
import type { ProductModule } from "./module.js";
import { workspaceCall } from "./workspace.js";
import { requireReadyReports } from "./readiness-gate.js";

export type WorkspaceActionContext = {
  actor: ProductActor; projectId: string; assignmentId: string; nativeBotId: string;
  actionId: string; tool: string; operationKey: string; channelId?: string; qaRevision?: string;
};

/** Only call from a native authenticated bot turn; do not accept its identity or tool from user input. */
export async function authorizedWorkspaceAction(module: ProductModule, context: WorkspaceActionContext, argv?: string[]) {
  return module.database.begin(transaction => authorizedWorkspaceActionInTransaction(module, transaction, context, argv));
}

/** The transaction must remain open through the provider call and its authorization locks. */
export async function authorizedWorkspaceActionInTransaction(module: ProductModule, transaction: ProductQuery, context: WorkspaceActionContext, argv?: string[]) {
  if (typeof context.operationKey !== "string" || !/^[a-zA-Z0-9._:-]{1,200}$/.test(context.operationKey)) {
    throw new ProductError(422, "invalid_operation", "A valid operation key is required.");
  }
  if (context.channelId) {
    const binding = await requireBotProject(transaction, context.actor, context.channelId, context.nativeBotId, "work", context.assignmentId);
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
  const action = definition.business?.actions.find(item => item.id === context.actionId);
  if (!role || role.agentId !== assignment.nativeBotId || !role.actions.includes(context.actionId)
    || !action || action.role !== role.id || !agent?.tools.includes(context.tool) || !["workspace-edit", "test-runner"].includes(context.tool)) {
    throw new ProductError(403, "tool_denied", "This project role cannot use that tool for this action.");
  }
  if (context.qaRevision !== undefined && (context.tool !== 'test-runner' || definition.projectType !== 'software-development' ||
      !action.outputTypes.includes('qa-evidence') || !/^[a-f0-9]{40,64}$/.test(context.qaRevision))) {
    throw new ProductError(403, 'tool_denied', 'This action cannot run a protected QA candidate.');
  }
  if (definition.projectType === 'software-development' && action.outputTypes.includes('qa-evidence') && !context.qaRevision) {
    throw new ProductError(409, 'qa_candidate_required', 'QA must run through the protected candidate workspace.');
  }
  // Approval-protected effects must use the dedicated release gate. Until that
  // gate verifies the exact candidate and target, a shell cannot dispatch them.
  if (action.approvalRequired) throw new ProductError(409, "approval_gate_unavailable", "This action requires the release approval gate.");
  if (!definition.business) throw new ProductError(409, "blueprint_unavailable", "The project blueprint is unavailable.");
  await requireReadyReports(transaction, project.id, definition.business.roles);
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
  if (context.qaRevision && health.qaSandbox !== 'git-readonly-v1') {
    throw new ProductError(409, 'qa_sandbox_unavailable', 'The workspace provider does not support the protected QA sandbox.');
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
  return workspaceCall(argv ? "run" : "reconcile", { ...binding, operationKey,
    ...(argv ? { argv, ...(context.qaRevision ? { qa: { revision: context.qaRevision } } : {}) } : {}) });
}

/** Bind a native bot callback to its authenticated conversation and recheck it at dispatch. */
export async function conversationWorkspaceAction(module: ProductModule, context: {
  actor: ProductActor; channelId: string; nativeBotId: string;
  actionId: string; tool: string; operationKey: string;
}, argv?: string[]) {
  const binding = await requireBotProject(module.database, context.actor, context.channelId, context.nativeBotId, "work");
  return authorizedWorkspaceAction(module, { ...context, projectId: binding.project.id, assignmentId: binding.assignmentId }, argv);
}
