import { createHash } from "node:crypto";
import { ProductError, type ProductActor, type ProductQuery } from "./access.js";
import type { ProductModule } from "./module.js";
import { requireNativeBotContext, type VerifiedNativeRun } from "./native-context.js";
import { saveWorkflowSelection } from "./workflow-routing.js";

type Callback = { name: string; args: Record<string, unknown>; botId: string; actorId: string; run: VerifiedNativeRun };
const refusal = "Refused. The Team Lead cannot prepare this workflow in the current conversation.";

/** A signed Team Lead turn can prepare one plan; dispatch remains a separate operation. */
export async function callNativeWorkflowTool(module: ProductModule, actor: ProductActor, input: Callback) {
  if (input.name !== "project_prepare_workflow") return null;
  const run = input.run;
  if (!run || run.handoff || run.actorId !== actor.id || input.actorId !== actor.id || input.botId !== run.botId ||
      typeof run.runId !== "string" || !run.runId || run.runId.length > 200 ||
      !input.args || typeof input.args !== "object" || Array.isArray(input.args) ||
      Object.keys(input.args).some(key => !["request", "interpretation"].includes(key)) ||
      typeof input.args.request !== "string" || !input.args.interpretation || typeof input.args.interpretation !== "object" || Array.isArray(input.args.interpretation)) {
    return { text: refusal, isError: true };
  }
  try {
    async function resolve(tx: ProductQuery) {
      const context = await requireNativeBotContext(tx, actor, run, "work");
      const [binding] = await tx.unsafe<{ role: string; leadRole: string }>(`select a.role_key as role,
        b.definition#>>'{business,teamLeadRole}' as "leadRole" from bp_assignments a
        join bp_projects p on p.id=a.project_id
        join bp_blueprint_versions b on b.blueprint_key=p.blueprint_key and b.version=p.blueprint_version
        where a.project_id=$1 and a.id=$2 and a.native_bot_id=$3 for share of a,p,b`,
      [context.project.id, context.assignmentId, run.botId]);
      if (!binding || binding.role !== binding.leadRole) throw new ProductError(403, "project_permission_denied", refusal);
      return context;
    }
    const context = await module.database.begin(resolve);
    const key = "native-workflow:" + createHash("sha256").update(JSON.stringify([run.actorId, run.botId, run.runId])).digest("hex");
    const result = await saveWorkflowSelection(module, actor, context.project.id, {
      channelId: context.channelId, request: input.args.request,
      interpretation: input.args.interpretation as Parameters<typeof saveWorkflowSelection>[3]["interpretation"],
    }, key, module.schema, async tx => {
      const current = await resolve(tx);
      if (current.project.id !== context.project.id || current.channelId !== context.channelId || current.assignmentId !== context.assignmentId) {
        throw new ProductError(409, "project_binding_changed", refusal);
      }
    });
    return { text: JSON.stringify({ ...result, ...(result.status === "saved" ? { execution: "pending", message: "The plan is saved but has not started." } : {}) }), isError: false };
  } catch (error) {
    if (error instanceof ProductError) return { text: error.status === 422 || error.status === 409 ? error.message : refusal, isError: true };
    throw error;
  }
}
