import { ProductError, type ProductActor } from "./access.js";
import type { ProductModule } from "./module.js";
import { requireNativeWorkspaceAction } from "./native-action.js";
import type { VerifiedNativeRun } from "./native-context.js";
import { authorizedWorkspaceActionInTransaction } from "./workspace-actions.js";

type Input = { name: string; args: Record<string, unknown>; actorId: string; botId: string; run: VerifiedNativeRun };
const refusal = "Refused. No authorized active workspace action is available for this bot turn.";

/** Only a verified native run with a dispatcher-created active phase can use this path. */
export async function callNativeWorkspaceTool(module: ProductModule, actor: ProductActor, input: Input) {
  if (input.name !== "project_workspace_run" && input.name !== "project_workspace_reconcile") return null;
  const running = input.name === "project_workspace_run";
  if (actor.id !== input.actorId || input.run?.actorId !== input.actorId || input.run?.botId !== input.botId ||
      !input.args || typeof input.args !== "object" || Array.isArray(input.args) ||
      (running ? Object.keys(input.args).some(key => key !== "argv") || !Array.isArray(input.args.argv) ||
        input.args.argv.length < 1 || input.args.argv.length > 128 || !input.args.argv[0] ||
        input.args.argv.some(value => typeof value !== "string" || value.includes("\0") || value.length > 8192)
        : Object.keys(input.args).length > 0)) return { text: refusal, isError: true };
  try {
    const result = await module.database.begin(async transaction => {
      const binding = await requireNativeWorkspaceAction(transaction, actor, input.run);
      return authorizedWorkspaceActionInTransaction(module, transaction, {
        actor, projectId: binding.project.id, channelId: binding.channelId, assignmentId: binding.assignmentId,
        nativeBotId: input.botId, actionId: binding.actionId, tool: binding.tool, operationKey: binding.operationKey,
      }, running ? input.args.argv as string[] : undefined);
    });
    return { text: JSON.stringify(result), isError: false };
  } catch (error) {
    if (error instanceof ProductError) {
      const explain = ["approval_gate_unavailable", "readiness_stale", "workspace_unavailable", "workspace_isolation_unverified", "workspace_source_unavailable"].includes(error.code);
      return { text: explain ? `Refused. ${error.message}` : refusal, isError: true };
    }
    throw error;
  }
}

/** Offer the tools only while a trusted dispatcher binding is active; recheck on every call. */
export async function nativeWorkspaceTools<T, U>(module: ProductModule, actor: ProductActor, run: VerifiedNativeRun,
  emptyParameters: T, runParameters: U, stillAllowed: () => Promise<boolean>) {
  const allowed = async () => { try { return await stillAllowed(); } catch { return false; } };
  if (!await allowed()) return [];
  try { await module.database.begin(transaction => requireNativeWorkspaceAction(transaction, actor, run)); }
  catch { return []; }
  const invoke = async (name: string, args: unknown) => {
    if (!await allowed()) return refusal;
    const result = await callNativeWorkspaceTool(module, actor, {
      name, args: args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : { invalid: true },
      actorId: run.actorId, botId: run.botId, run,
    });
    return result?.text ?? refusal;
  };
  return [
    { name: "project_workspace_run", ref: "project/project_workspace_run", description: "Run the active authorized action in this project's isolated workspace. Arguments form a command and its parameters.", parameters: runParameters,
      execute: (args: unknown) => invoke("project_workspace_run", args) },
    { name: "project_workspace_reconcile", ref: "project/project_workspace_reconcile", description: "Check the result of this active workspace action after an interrupted response.", parameters: emptyParameters,
      execute: (args: unknown) => invoke("project_workspace_reconcile", args) },
  ];
}
