import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ProductActor } from "./access.js";
import { ProductError } from "./access.js";
import type { ProductModule } from "./module.js";
import { contentDigest } from "./store.js";
import { validateSchema, type Schema } from "./contract/schema.js";

type LegacyGroup = { id: string; name: string; source: string; conversations: { channelId: string }[] };

/** Import only associations independently verified against the old owner and source. */
export async function migrateLegacyProjects(module: ProductModule, actor: ProductActor, groups: LegacyGroup[],
  create: (input: { name: string }, key: string) => Promise<{ id: string }>, options: { manual?: boolean } = {}) {
  const installationId = await module.ensure(actor);
  for (const group of groups) {
    if (!group.id || !group.source || !Array.isArray(group.conversations)) continue;
    if (!options.manual) {
      const [selected] = await module.database.unsafe(`select 1 from bp_legacy_manual_selections where installation_id=$1 and owner_id=$2 and legacy_key=$3`, [installationId, actor.id, group.id]);
      if (selected) continue;
    }
    // Refuse the entire group before creating anything when an association is
    // shared, missing, or no longer matches the original owner's setup.
    for (const conversation of group.conversations) {
      const [verified] = await module.database.unsafe<{ id: string }>(`select c.id from blueprint_team_setup s
        join intelligence_channel_mappings m on m.thread_id=s.thread_id and m.user_id=s.user_id
        join channels c on c.id=m.channel_id and c.deleted_at is null
        join channel_memberships cm on cm.channel_id=c.id and cm.user_id=s.user_id
        where s.user_id=$1 and c.id=$2 and s.submission->'answers'->>'project'=$3
          and not exists (select 1 from channel_memberships other where other.channel_id=c.id and other.user_id<>$1)`,
        [actor.id, conversation.channelId, group.source]);
      if (!verified) throw new ProductError(409, "legacy_association_unverified", "A previous conversation association could not be verified.");
    }
    const key = `legacy:${createHash("sha256").update(group.id).digest("hex")}`;
    const project = await create({ name: group.name.trim().slice(0, 200) || "Imported project" }, key);
    const current = await module.store.getProject(actor, project.id);
    if (current.state === 'Archived') {
      if (options.manual) throw new ProductError(409, 'project_archived', 'The previously imported project is archived.');
      continue;
    }
    const definition = await module.definitionFor(current);
    await module.database.begin(async tx => {
      await tx.unsafe("select pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([installationId, actor.id, group.id])]);
      // Protect the absence of other members until the conversation binding
      // commits; a row lock alone cannot lock a membership that does not exist.
      if (group.conversations.length) await tx.unsafe('lock table channel_memberships in share mode');
      const [mapped] = await tx.unsafe<{ projectId: string }>(`select project_id as "projectId" from bp_legacy_project_groups
        where installation_id=$1 and owner_id=$2 and legacy_key=$3 for update`, [installationId, actor.id, group.id]);
      if (!options.manual) {
        const [selected] = await tx.unsafe(`select 1 from bp_legacy_manual_selections where installation_id=$1 and owner_id=$2 and legacy_key=$3`, [installationId, actor.id, group.id]);
        if (selected) return;
      }
      if (mapped && mapped.projectId !== project.id) throw new ProductError(409, "legacy_project_conflict", "The previous project association needs review.");
      const [lead] = await tx.unsafe<{ id: string }>(`select a.id from bp_assignments a join bp_projects p on p.id=a.project_id
        join bp_blueprint_versions b on b.blueprint_key=p.blueprint_key and b.version=p.blueprint_version
        where a.project_id=$1 and a.role_key=b.definition#>>'{business,teamLeadRole}' for share of a`, [project.id]);
      if (!lead) throw new ProductError(409, "team_lead_unavailable", "The imported project has no Team Lead assignment.");
      const sourceType = definition.business?.artifactTypes.find(item => item.id === "source-code");
      const source = { path: group.source };
      if (sourceType && posix.normalize(group.source) === group.source && (group.source === '/projects' || group.source.startsWith('/projects/')) &&
          !validateSchema(source, sourceType.schema as Schema).length) {
        const digest = contentDigest(source);
        const inserted = await tx.unsafe(`insert into bp_artifacts(project_id,id,type_key,source,status)
          values($1,'source-code','source-code',$2::text::jsonb,'supplied') on conflict do nothing returning id`, [project.id, JSON.stringify(source)]);
        if (inserted.length) await tx.unsafe(`insert into bp_artifact_revisions(project_id,artifact_id,id,digest,payload,created_by)
          values($1,'source-code',$2,$2,$3::text::jsonb,$4)`, [project.id, digest, JSON.stringify(source), actor.id]);
      }
      for (const conversation of group.conversations) {
        const [verified] = await tx.unsafe<{ id: string }>(`select c.id from blueprint_team_setup s
          join intelligence_channel_mappings m on m.thread_id=s.thread_id and m.user_id=s.user_id
          join channels c on c.id=m.channel_id and c.deleted_at is null
          join channel_memberships cm on cm.channel_id=c.id and cm.user_id=s.user_id
          where s.user_id=$1 and c.id=$2 and s.submission->'answers'->>'project'=$3
            and not exists (select 1 from channel_memberships other where other.channel_id=c.id and other.user_id<>$1)
          for share of s,m,c,cm`, [actor.id, conversation.channelId, group.source]);
        if (!verified) throw new ProductError(409, "legacy_association_unverified", "A previous conversation association could not be verified.");
        const [existing] = await tx.unsafe<{ projectId: string }>('select project_id as "projectId" from bp_conversations where native_channel_id=$1 for update', [conversation.channelId]);
        if (existing && existing.projectId !== project.id) throw new ProductError(409, "legacy_project_conflict", "A previous conversation belongs to another project.");
        if (!existing) await tx.unsafe('insert into bp_conversations(project_id,native_channel_id,team_lead_assignment_id) values($1,$2,$3)', [project.id, conversation.channelId, lead.id]);
      }
      if (!mapped) await tx.unsafe('insert into bp_legacy_project_groups(installation_id,owner_id,legacy_key,project_id) values($1,$2,$3,$4)', [installationId, actor.id, group.id, project.id]);
      if (options.manual) await tx.unsafe('insert into bp_legacy_manual_selections(installation_id,owner_id,legacy_key) values($1,$2,$3) on conflict do nothing', [installationId, actor.id, group.id]);
    });
  }
}
