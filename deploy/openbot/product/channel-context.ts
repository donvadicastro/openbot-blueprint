import type { ProductActor } from "./access.js";
import type { ProductModule } from "./module.js";

/** A native channel is shown as a project only to a member of both resources. */
export async function businessChannelContext(module: ProductModule, actor: ProductActor, channelId: string) {
  const [project] = await module.database.unsafe<{ id: string; name: string; isTeamLead: boolean }>(`
    select p.id,p.name,exists(select 1 from bp_assignments a join channel_agents ca on ca.channel_id=c.native_channel_id and ca.agent_id=a.native_bot_id
      where a.project_id=c.project_id and a.id=c.team_lead_assignment_id) as "isTeamLead" from bp_conversations c
    join bp_projects p on p.id=c.project_id
    join bp_memberships pm on pm.project_id=p.id and pm.user_id=$2 and 'read'=any(pm.permissions)
    join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=$2
    join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
    where c.native_channel_id=$1`, [channelId, actor.id]);
  return project ?? null;
}
