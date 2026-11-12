import { randomUUID } from "node:crypto";
import { ProductError, requireProject } from "./access.js";
import type { ProductModule } from "./module.js";
import type { ReadinessProbe } from "./readiness.js";
import { workspaceCall } from "./workspace.js";

/** A fixed read-only probe, scoped to the authenticated owner and assigned bot. */
export async function verifyReadinessWorkspace(module: ProductModule, input: Parameters<ReadinessProbe>[0]) {
  const actor = { id: input.actorId, role: "user" as const };
  const project = await requireProject(module.database, actor, input.projectId, "manage");
  if (project.state === "Archived") throw new ProductError(409, "project_archived", "This project is archived.");
  const [assignment] = await module.database.unsafe<{ roleKey: string; nativeBotId: string }>(
    'select role_key as "roleKey", native_bot_id as "nativeBotId" from bp_assignments where project_id=$1 and id=$2',
    [project.id, input.assignmentId],
  );
  const definition = await module.definitionFor(project);
  const role = definition.business?.roles.find(item => item.id === assignment?.roleKey);
  const agent = definition.agents.find(item => item.id === assignment?.nativeBotId);
  const sourceType = definition.business?.artifactTypes.find(item => item.id === "source-code");
  if (!assignment || assignment.nativeBotId !== input.nativeBotId || role?.id !== input.roleKey
    || role.agentId !== input.nativeBotId || !agent?.tools.includes("repository-read")
    || !sourceType || (sourceType.owner !== role.id && !sourceType.consumers.includes(role.id) && !sourceType.producers.includes(role.id))) {
    throw new ProductError(403, "tool_denied", "This bot cannot inspect the project workspace.");
  }
  const [vm] = await module.database.unsafe<{ providerId: string; sourceRevision: string; state: string }>(
    'select provider_id as "providerId", source_revision as "sourceRevision", state from bp_project_vms where project_id=$1', [project.id],
  );
  const [source] = await module.database.unsafe<{ id: string }>(
    "select id from bp_artifacts where project_id=$1 and type_key='source-code' and status='supplied' and (allowed_user_ids is null or $2 = any(allowed_user_ids))",
    [project.id, actor.id],
  );
  if (!vm?.providerId || !vm.sourceRevision || vm.state !== "Ready" || !source) {
    return { verified: false, evidence: "The project workspace or source is unavailable." };
  }
  const binding = { installationId: project.installationId, projectId: project.id };
  const health = await workspaceCall("check", binding);
  if (!health.ready || !health.isolated || health.id !== vm.providerId) return { verified: false, evidence: "The project VM or its network isolation is unavailable." };
  const sourceState = await workspaceCall("source", binding);
  if (sourceState.revision !== vm.sourceRevision || !sourceState.hasProject) return { verified: false, evidence: "The project source revision does not match its workspace." };
  const result = await workspaceCall("run", { ...binding, operationKey: `readiness:${randomUUID()}`,
    argv: ["sh", "-c", 'unreadable=$(find . -path ./.git -prune -o -type f ! -readable -print -quit -o -type d ! -readable -print -quit -o -type d ! -executable -print -quit) || exit 1; test -z "$unreadable"'] });
  const verified = result.status === "completed" && result.exitCode === 0;
  return { verified, evidence: verified ? `Verified readable project source at revision ${vm.sourceRevision}.` : "The project source could not be verified in the assigned VM." };
}
