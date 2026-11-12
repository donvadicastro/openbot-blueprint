import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import type { SetupForm } from "./setup-form";
import { validateSetup } from "./setup-form";

type CompletedSetup = { answers: Record<string, string> };

export function projectFromSource(source: string) {
  const github = /^https:\/\/github\.com\/(.+?)\/?$/i.exec(source);
  const name = github ? github[1].replace(/\.git$/i, "") : source.replace(/[\\/]+$/, "");
  const key = github ? `github:${name.toLowerCase()}` : `folder:${name}`;
  return { id: createHash("sha256").update(key).digest("hex"), name };
}

export async function createSetupStore(database: Database, form: SetupForm) {
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext('blueprint-team-setup'))`);
    await transaction.execute(sql`
      create table if not exists blueprint_team_setup (
        thread_id text primary key,
        user_id text not null references users(id) on delete cascade,
        submission jsonb not null
      )
    `);
    await transaction.execute(sql`
      create table if not exists blueprint_projects (
        user_id text not null references users(id) on delete cascade,
        id text not null,
        source text not null,
        primary key (user_id, id)
      )
    `);
  });

  const revision = createHash("sha256").update(JSON.stringify(form)).digest("hex").slice(0, 16);

  async function get(userId: string, threadId: string) {
    const [row] = await database.execute<{ submission: CompletedSetup }>(sql`
      select submission from blueprint_team_setup where user_id = ${userId} and thread_id = ${threadId}
        and submission->>'revision' = ${revision}
    `);
    return row?.submission;
  }

  return {
    form,
    revision,
    get,
    async addProject(userId: string, source: string) {
      const project = projectFromSource(source);
      await database.execute(sql`
        insert into blueprint_projects (user_id, id, source) values (${userId}, ${project.id}, ${source})
        on conflict (user_id, id) do nothing
      `);
      return project;
    },
    async listProjects(userId: string) {
      const rows = await database.execute<{
        source: string; channelId: string; title: string;
      }>(sql`
        select s.submission->'answers'->>'project' as source,
          c.id as "channelId", coalesce(nullif(c.summary, ''), c.name) as title
        from blueprint_team_setup s
        join intelligence_channel_mappings m on m.thread_id = s.thread_id and m.user_id = s.user_id
        join channels c on c.id = m.channel_id
        join channel_memberships cm on cm.channel_id = c.id and cm.user_id = s.user_id
        where s.user_id = ${userId} and c.deleted_at is null
          and jsonb_typeof(s.submission->'answers'->'project') = 'string'
        order by coalesce(c.last_message_at, c.created_at) desc, c.id
      `);
      const projects = new Map<string, {
        id: string; name: string; source: string; conversations: { channelId: string; title: string }[];
      }>();
      const saved = await database.execute<{ source: string }>(sql`
        select source from blueprint_projects where user_id = ${userId} order by source
      `);
      for (const { source } of saved) {
        const project = projectFromSource(source);
        projects.set(project.id, { ...project, source, conversations: [] });
      }
      for (const { source, channelId, title } of rows) {
        const project = projectFromSource(source);
        const existing = projects.get(project.id);
        if (existing) existing.conversations.push({ channelId, title });
        else projects.set(project.id, { ...project, source, conversations: [{ channelId, title }] });
      }
      return [...projects.values()];
    },
    async finish(userId: string, threadId: string, input: unknown, executor: Pick<Database, "execute"> = database) {
      const validated = validateSetup(form, input);
      if (!validated.value) return validated;
      const [row] = await executor.execute<{ submission: CompletedSetup }>(sql`
        insert into blueprint_team_setup (thread_id, user_id, submission)
        values (${threadId}, ${userId}, ${JSON.stringify({ ...validated.value, revision })}::text::jsonb)
        on conflict (thread_id) do nothing returning submission
      `);
      const value = row?.submission ?? await get(userId, threadId);
      return value ? { value } : { error: "Couldn’t save your setup." };
    },
  };
}

export type SetupStore = Awaited<ReturnType<typeof createSetupStore>>;
