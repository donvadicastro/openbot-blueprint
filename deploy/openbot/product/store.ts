import { createHash, randomUUID } from "node:crypto";
import { ProductError, requireBotProject, requireProject, requirePublisher } from "./access.js";
import type { ProductActor, ProductPermission, ProductQuery, Project } from "./access.js";

export interface ProductDatabase extends ProductQuery {
  begin<T>(callback: (transaction: ProductQuery) => Promise<T>): Promise<T>;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Installation = {
  id: string;
  environmentId: string;
  blueprintKey: string;
  composeProject: string;
  appUrl: string;
};
export type BlueprintVersion = { key: string; version: string; digest: string; definition: Record<string, JsonValue> };
export type ArtifactRevision = {
  id: string;
  artifactId: string;
  typeKey: string;
  source: Record<string, JsonValue>;
  status: string;
  digest: string;
  payload: Record<string, JsonValue>;
  evidence: Record<string, JsonValue>;
};
export type ArtifactRoleGrant = { id: string; owner: string; producers: string[]; consumers: string[] };

export function roleMayReadArtifact(type: ArtifactRoleGrant | undefined, role: string) {
  return !!type && (type.owner === role || (Array.isArray(type.producers) && type.producers.includes(role)) ||
    (Array.isArray(type.consumers) && type.consumers.includes(role)));
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentDigest(value: JsonValue) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function mutationKey(key: string) {
  if (typeof key !== "string" || key.length < 1 || key.length > 200) {
    throw new ProductError(422, "invalid_idempotency_key", "An idempotency key of 1 to 200 characters is required.");
  }
}

function replay<T>(row: { digest: string; response: T } | undefined, digest: string) {
  if (row && row.digest !== digest) {
    throw new ProductError(409, "idempotency_conflict", "The idempotency key was already used with another payload.");
  }
  return row;
}

/** Internal: the caller must authorize and lock the project and assignment first. */
export async function resolveAssignedArtifact(transaction: ProductQuery, actor: ProductActor, project: Project,
  assignmentId: string, nativeBotId: string, artifactId: string, revisionId?: string): Promise<ArtifactRevision> {
  const [revision] = await transaction.unsafe<ArtifactRevision & { roleKey: string; definition: {
    business?: { artifactTypes?: ArtifactRoleGrant[] };
  } }>(`
    select r.id, a.id as "artifactId", a.type_key as "typeKey", a.source, a.status,
      r.digest, r.payload, r.evidence, s.role_key as "roleKey", b.definition
    from bp_artifacts a
    join bp_artifact_revisions r on r.project_id=a.project_id and r.artifact_id=a.id
    join bp_assignments s on s.project_id=a.project_id and s.id=$3 and s.native_bot_id=$4
    join bp_blueprint_versions b on b.blueprint_key=$6 and b.version=$7
    where a.project_id=$1 and a.id=$2 and (a.allowed_user_ids is null or $5=any(a.allowed_user_ids))
      and ($8::text is null or r.id=$8)
    order by r.created_at desc,r.id desc limit 1 for share of a,s
  `, [project.id, artifactId, assignmentId, nativeBotId, actor.id, project.blueprintKey, project.blueprintVersion, revisionId ?? null]);
  const type = revision?.definition?.business?.artifactTypes?.find(item => item.id === revision.typeKey);
  if (!revision || !roleMayReadArtifact(type, revision.roleKey)) {
    throw new ProductError(404, "artifact_not_found", "Artifact not found.");
  }
  const { roleKey: _roleKey, definition: _definition, ...visible } = revision;
  return visible;
}

export function createProductStore(database: ProductDatabase) {
  return {
    database,
    async ensureInstallation(actor: ProductActor, input: Omit<Installation, "id">): Promise<Installation> {
      requirePublisher(actor);
      return database.begin(async transaction => {
        const lock = JSON.stringify([input.environmentId, input.blueprintKey]);
        await transaction.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lock]);
        const [existing] = await transaction.unsafe<Installation>(`
          select id, environment_id as "environmentId", blueprint_key as "blueprintKey",
            compose_project as "composeProject", app_url as "appUrl" from bp_installations
          where environment_id = $1 and blueprint_key = $2
        `, [input.environmentId, input.blueprintKey]);
        if (existing) return existing;
        const value = { ...input, id: randomUUID() };
        await transaction.unsafe(`
          insert into bp_installations (id, environment_id, blueprint_key, compose_project, app_url)
          values ($1, $2, $3, $4, $5)
        `, [value.id, value.environmentId, value.blueprintKey, value.composeProject, value.appUrl]);
        return value;
      });
    },

    async registerBlueprint(actor: ProductActor, input: BlueprintVersion): Promise<BlueprintVersion> {
      requirePublisher(actor);
      return database.begin(async transaction => {
        await transaction.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([input.key, input.version])]);
        const [existing] = await transaction.unsafe<BlueprintVersion>(`
          select blueprint_key as key, version, digest, definition from bp_blueprint_versions
          where blueprint_key = $1 and version = $2
        `, [input.key, input.version]);
        if (existing) {
          if (existing.digest !== input.digest || contentDigest(existing.definition) !== contentDigest(input.definition)) {
            throw new ProductError(409, "blueprint_version_conflict", "This published blueprint version has different content.");
          }
          return existing;
        }
        await transaction.unsafe(`
          insert into bp_blueprint_versions (blueprint_key, version, digest, definition, published_by)
          values ($1, $2, $3, $4::text::jsonb, $5)
        `, [input.key, input.version, input.digest, JSON.stringify(input.definition), actor.id]);
        return input;
      });
    },

    async createProject(
      actor: ProductActor,
      input: { installationId: string; blueprintVersion: string; name: string },
      idempotencyKey: string,
    ): Promise<Project> {
      mutationKey(idempotencyKey);
      if (typeof input.name !== "string" || input.name.trim().length < 1 || input.name.trim().length > 200) {
        throw new ProductError(422, "invalid_project_name", "A project name of 1 to 200 characters is required.");
      }
      const digest = contentDigest(input);
      return database.begin(async transaction => {
        await transaction.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([input.installationId, actor.id, idempotencyKey])]);
        const [row] = await transaction.unsafe<{ digest: string; response: Project }>(`
          select digest, response from bp_installation_mutations
          where installation_id = $1 and actor_id = $2 and mutation_key = $3
        `, [input.installationId, actor.id, idempotencyKey]);
        const existing = replay(row, digest);
        if (existing) return requireProject(transaction, actor, existing.response.id);
        const [binding] = await transaction.unsafe<{ blueprintKey: string }>(`
          select i.blueprint_key as "blueprintKey" from bp_installations i
          join bp_blueprint_versions b on b.blueprint_key = i.blueprint_key
          where i.id = $1 and b.version = $2
        `, [input.installationId, input.blueprintVersion]);
        if (!binding) throw new ProductError(422, "blueprint_not_installed", "The selected blueprint version is unavailable in this installation.");
        const projectId = randomUUID();
        const permissions: ProductPermission[] = ["read", "manage", "work", "approve", "feedback"];
        await transaction.unsafe(`
          insert into bp_projects (id, installation_id, blueprint_key, blueprint_version, name, created_by)
          values ($1, $2, $3, $4, $5, $6)
        `, [projectId, input.installationId, binding.blueprintKey, input.blueprintVersion, input.name.trim(), actor.id]);
        await transaction.unsafe("insert into bp_memberships (project_id, user_id, permissions) values ($1, $2, array(select jsonb_array_elements_text($3::text::jsonb)))", [projectId, actor.id, JSON.stringify(permissions)]);
        const project = await requireProject(transaction, actor, projectId);
        await transaction.unsafe(`
          insert into bp_installation_mutations (installation_id, actor_id, mutation_key, digest, response)
          values ($1, $2, $3, $4, $5::text::jsonb)
        `, [input.installationId, actor.id, idempotencyKey, digest, JSON.stringify(project)]);
        return project;
      });
    },

    getProject(actor: ProductActor, projectId: string) {
      return requireProject(database, actor, projectId);
    },

    listProjects(actor: ProductActor) {
      return database.unsafe<Project & { teamLeadChannelId: string | null }>(`
        select p.id, p.installation_id as "installationId", p.blueprint_key as "blueprintKey",
          p.blueprint_version as "blueprintVersion", p.name,
          case when p.state='Operational' and (
            (select count(*) from bp_assignments a where a.project_id=p.id) <>
              jsonb_array_length(coalesce(b.definition#>'{business,roles}','[]'::jsonb))
            or exists (select 1 from jsonb_array_elements(coalesce(b.definition#>'{business,roles}','[]'::jsonb)) role
              where not exists (select 1 from bp_assignments a join bp_readiness r on r.project_id=a.project_id and r.assignment_id=a.id
                where a.project_id=p.id and a.role_key=role->>'id' and r.status='Ready' and r.assignment_revision=a.revision))
            or exists (select 1 from jsonb_array_elements_text(coalesce(b.definition#>'{business,initialization,requiredArtifacts}','[]'::jsonb)) needed(type_key)
              where not exists (select 1 from bp_artifacts a where a.project_id=p.id and a.type_key=needed.type_key and a.status='supplied'))
            or (b.definition#>>'{business,initialization,workspace,kind}'='vm' and not exists
              (select 1 from bp_project_vms vm where vm.project_id=p.id and vm.state='Ready' and vm.provider_id is not null and vm.source_revision is not null))
          ) then 'Initializing' else p.state end as state, p.revision,
          p.created_by as "createdBy", m.permissions,
          (select c.native_channel_id from bp_conversations c
           join bp_assignments a on a.project_id=c.project_id and a.id=c.team_lead_assignment_id and a.role_key=b.definition#>>'{business,teamLeadRole}'
           join channel_agents ca on ca.channel_id=c.native_channel_id and ca.agent_id=a.native_bot_id
           join channel_memberships cm on cm.channel_id=c.native_channel_id and cm.user_id=$1
           join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
           where c.project_id=p.id order by c.created_at,c.native_channel_id limit 1) as "teamLeadChannelId"
        from bp_projects p join bp_memberships m on m.project_id = p.id
        join bp_blueprint_versions b on b.blueprint_key=p.blueprint_key and b.version=p.blueprint_version
        where m.user_id = $1 and 'read' = any(m.permissions)
        order by p.created_at desc, p.id
      `, [actor.id]);
    },

    async mutate<T extends JsonValue>(
      actor: ProductActor,
      projectId: string,
      permission: ProductPermission,
      idempotencyKey: string,
      payload: JsonValue,
      action: (transaction: ProductQuery, project: Project) => Promise<T>,
      authorize?: (transaction: ProductQuery, project: Project) => Promise<void>,
    ): Promise<T> {
      mutationKey(idempotencyKey);
      const digest = contentDigest(payload);
      return database.begin(async transaction => {
        await transaction.unsafe("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([projectId, actor.id, idempotencyKey])]);
        const project = await requireProject(transaction, actor, projectId, permission);
        // Replays are reads of the previous result, so nested-resource access must
        // be rechecked even when the mutation itself will not run again.
        if (authorize) await authorize(transaction, project);
        const [row] = await transaction.unsafe<{ digest: string; response: T }>(`
          select digest, response from bp_mutations where project_id = $1 and actor_id = $2 and mutation_key = $3
        `, [projectId, actor.id, idempotencyKey]);
        const existing = replay(row, digest);
        if (existing) return existing.response;
        if (project.state === "Archived") throw new ProductError(409, "project_archived", "This project is archived.");
        const response = await action(transaction, project);
        await transaction.unsafe(`
          insert into bp_mutations (project_id, actor_id, mutation_key, digest, response)
          values ($1, $2, $3, $4, $5::text::jsonb)
        `, [projectId, actor.id, idempotencyKey, digest, JSON.stringify(response)]);
        return response;
      });
    },

    async resolveArtifact(actor: ProductActor, projectId: string, artifactId: string, revisionId?: string) {
      await requireProject(database, actor, projectId);
      const [revision] = await database.unsafe<ArtifactRevision>(`
        select r.id, a.id as "artifactId", a.type_key as "typeKey", a.source, a.status,
          r.digest, r.payload, r.evidence
        from bp_artifacts a join bp_artifact_revisions r on r.project_id = a.project_id and r.artifact_id = a.id
        join bp_memberships m on m.project_id = a.project_id and m.user_id = $3
        where a.project_id = $1 and a.id = $2 and 'read' = any(m.permissions)
          and (a.allowed_user_ids is null or $3 = any(a.allowed_user_ids))
          and ($4::text is null or r.id = $4)
        order by r.created_at desc, r.id desc limit 1
      `, [projectId, artifactId, actor.id, revisionId ?? null]);
      if (!revision) throw new ProductError(404, "artifact_not_found", "Artifact not found.");
      return revision;
    },

    /** Call only with identities bound by the authenticated native bot turn. */
    async resolveBotArtifact(actor: ProductActor, channelId: string, nativeBotId: string, artifactId: string, revisionId?: string, trustedAssignmentId?: string) {
      return database.begin(async transaction => {
        const { project, assignmentId } = await requireBotProject(transaction, actor, channelId, nativeBotId, "read", trustedAssignmentId);
        return resolveAssignedArtifact(transaction, actor, project, assignmentId, nativeBotId, artifactId, revisionId);
      });
    },
  };
}

export type ProductStore = ReturnType<typeof createProductStore>;

export interface NativeProductSql {
  unsafe(statement: string, parameters?: unknown[]): PromiseLike<unknown>;
  begin(callback: (transaction: NativeProductSql) => Promise<unknown>): PromiseLike<unknown>;
}

/** Keep product queries on the native connection pool and transaction implementation. */
export function productDatabaseFromNative(database: { $client: NativeProductSql }): ProductDatabase {
  function adapt(client: NativeProductSql): ProductDatabase {
    return {
      async unsafe<T>(statement: string, parameters?: unknown[]): Promise<T[]> {
        return await client.unsafe(statement, parameters) as T[];
      },
      async begin<T>(callback: (transaction: ProductQuery) => Promise<T>): Promise<T> {
        return await client.begin(transaction => callback(adapt(transaction))) as T;
      },
    };
  }
  return adapt(database.$client);
}
