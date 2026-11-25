import { ProductError, requireOperational, type ProductActor } from "./access.js";
import type { ProductModule } from "./module.js";
import { requireNativeBotContext, type VerifiedNativeRun } from "./native-context.js";
import { requireReadyReports, requireReadyWorkspace } from "./readiness-gate.js";

const refusal = { text: "Refused. Complete the project team's current readiness checks before delegating work.", isError: true as const };
const workflowUnavailable = { text: "Refused. Project workflow delegation is not available yet.", isError: true as const };

/** Leave nonproject conversations to OpenBot; fail closed for project work on any uncertainty. */
export async function guardProjectDelegation(module: ProductModule, actor: ProductActor, run: VerifiedNativeRun) {
  if (!run.threadId) return null; // Native coordination independently refuses a missing thread.
  try {
    return await module.database.begin(async tx => {
      const direct = await tx.unsafe<{ projectId: string }>(`
        select c.project_id as "projectId" from intelligence_channel_mappings m
        join bp_conversations c on c.native_channel_id=m.channel_id
        where m.thread_id=$1 and m.user_id=$2 for share of m,c`, [run.threadId, actor.id]);
      const group = await tx.unsafe<{ projectId: string }>(`
        select c.project_id as "projectId" from group_bot_threads t
        join bp_conversations c on c.native_channel_id=t.channel_id
        where t.thread_id=$1 and t.owner_user_id=$2 for share of t,c`, [run.threadId, actor.id]);
      const projects = new Set([...direct, ...group].map(item => item.projectId));
      if (!projects.size) return null;
      if (projects.size !== 1) return refusal;
      const { project } = await requireNativeBotContext(tx, actor, run, "work");
      if (!projects.has(project.id)) return refusal;
      requireOperational(project);
      const [version] = await tx.unsafe<{ definition: { business?: {
        roles: { id: string }[]; initialization: { workspace: { kind: string } };
      } } }>('select definition from bp_blueprint_versions where blueprint_key=$1 and version=$2', [project.blueprintKey, project.blueprintVersion]);
      const business = version?.definition.business;
      if (!business) return refusal;
      await requireReadyReports(tx, project.id, business.roles);
      await requireReadyWorkspace(tx, project, business);
      // Raw bot-to-bot messages cannot prove a typed workflow handoff. Keep
      // project delegation closed until the workflow dispatcher enforces it.
      return workflowUnavailable;
    });
  } catch (error) {
    if (!(error instanceof ProductError)) console.error("Project delegation could not be verified.");
    return refusal;
  }
}
