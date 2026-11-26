import { ProductError, requireBotProject, type ProductActor, type ProductPermission, type ProductQuery } from "./access.js";

export type VerifiedNativeRun = { actorId: string; botId: string; runId?: string; threadId?: string; depth?: number;
  initiator?: { kind: string; id?: string }; handoff?: { key: string; owner: string } };

function sameInitiator(left: unknown, right: unknown) {
  const normalize = (value: unknown) => {
    if (value === undefined) return { kind: "person", id: undefined };
    if (value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (item.kind === "person" || item.kind === "deployment") return { kind: item.kind, id: undefined };
    if (!["routine", "responsibility", "memory", "handoff"].includes(item.kind as string) || typeof item.id !== "string" || !item.id) return null;
    return { kind: item.kind, id: item.id };
  };
  const a = normalize(left), b = normalize(right);
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

/**
 * Accept only the assertion already verified by OpenBot's native callback boundary.
 * The caller must hold this transaction through the governed action. Delegated
 * runs use the signed source thread and must hold their active native handoff lease.
 */
export async function requireNativeBotContext(database: ProductQuery, actor: ProductActor, run: VerifiedNativeRun,
  permission: ProductPermission = "read", trustedAssignmentId?: string) {
  if (!run || run.actorId !== actor.id || typeof run.botId !== "string" || !run.botId ||
      typeof run.threadId !== "string" || !run.threadId) {
    throw new ProductError(404, "project_not_found", "Project not found.");
  }
  const delegated = run.handoff !== undefined;
  if (delegated) {
    if (!run.handoff || typeof run.handoff.key !== "string" || !run.handoff.key ||
        typeof run.handoff.owner !== "string" || !run.handoff.owner ||
        !Number.isInteger(run.depth) || (run.depth ?? 0) < 0) {
      throw new ProductError(404, "project_not_found", "Project not found.");
    }
    const [claim] = await database.unsafe<{ payload: Record<string, unknown> }>(`
      select payload from work_items where kind='bot.message' and key=$1 and claimed_by=$2
        and finished_at is null and lease_until > now() for share
    `, [run.handoff.key, run.handoff.owner]);
    const work = claim?.payload;
    if (!work || typeof work !== "object" || Array.isArray(work) || work.toBotId !== run.botId ||
        work.actorId !== actor.id || work.threadId !== run.threadId || work.depth !== run.depth ||
        typeof work.fromBotId !== "string" || !work.fromBotId || typeof work.runId !== "string" || !work.runId || typeof work.task !== "string" ||
        !sameInitiator(work.initiator, run.initiator)) {
      throw new ProductError(404, "project_not_found", "Project not found.");
    }
  }
  const direct = await database.unsafe<{ channelId: string }>(`
    select m.channel_id as "channelId" from intelligence_channel_mappings m
    join channel_agents ca on ca.channel_id=m.channel_id and ($4::boolean or ca.agent_id=$3)
    join channel_memberships cm on cm.channel_id=m.channel_id and cm.user_id=$2
    join channels ch on ch.id=m.channel_id and ch.deleted_at is null
    where m.thread_id=$1 and m.user_id=$2
      and (select count(*) from channel_agents all_agents where all_agents.channel_id=m.channel_id)=1
    for share of m,ca,cm,ch
  `, [run.threadId, actor.id, run.botId, delegated]);
  const group = await database.unsafe<{ channelId: string }>(`
    select t.channel_id as "channelId" from group_bot_threads t
    join channel_agents ca on ca.channel_id=t.channel_id and ca.agent_id=t.agent_id
    join channel_memberships cm on cm.channel_id=t.channel_id and cm.user_id=$2
    join channels ch on ch.id=t.channel_id and ch.deleted_at is null
    where t.thread_id=$1 and t.owner_user_id=$2 and ($4::boolean or t.agent_id=$3) for share of t,ca,cm,ch
  `, [run.threadId, actor.id, run.botId, delegated]);
  const channels = new Set([...direct, ...group].map(row => row.channelId));
  if (channels.size !== 1) throw new ProductError(404, "project_not_found", "Project not found.");
  const channelId = [...channels][0];
  const binding = await requireBotProject(database, actor, channelId, run.botId, permission, trustedAssignmentId);
  return { ...binding, channelId };
}
