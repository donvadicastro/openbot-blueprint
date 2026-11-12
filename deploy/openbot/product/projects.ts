import { randomUUID } from "node:crypto";
import type { ProductActor } from "./access.js";
import { ProductError, requireProject } from "./access.js";
import type { ProductModule } from "./module.js";
import { contentDigest, type JsonValue } from "./store.js";
import { workspaceCall } from "./workspace.js";
import { validateSchema, type Schema } from "./contract/schema.js";

/**
 * The caller must create the native channel and insert the bp_conversations
 * link within the same native database transaction.
 */
export type ProjectConversationCreator = (input: {
  actor: ProductActor;
  projectId: string;
  assignmentId: string;
  nativeBotId: string;
}) => Promise<void>;

export function projectOperations(module: ProductModule, createConversation?: ProjectConversationCreator) {
  return {
    async create(actor: ProductActor, input: { name: string; blueprintVersion?: string }, key: string) {
      const installationId = await module.ensure(actor);
      const project = await module.store.createProject(actor, {
        installationId, blueprintVersion: input.blueprintVersion ?? module.definition.version, name: input.name,
      }, key);
      const definition = await module.definitionFor(project);
      await module.database.begin(async transaction => {
        for (const role of definition.business!.roles) {
          await transaction.unsafe(
            "insert into bp_assignments(project_id,id,role_key,native_bot_id) values($1,$2,$3,$4) on conflict(project_id,role_key) do nothing",
            [project.id, randomUUID(), role.id, role.agentId],
          );
        }
        await transaction.unsafe("insert into bp_project_vms(project_id) values($1) on conflict do nothing", [project.id]);
      });
      await module.database.begin(async transaction => {
        // The lock spans the native channel transaction so concurrent retries
        // cannot create two conversations for the same project.
        await transaction.unsafe("select pg_advisory_xact_lock(hashtextextended($1,0))", [`team-lead:${project.id}`]);
        const [linked] = await transaction.unsafe<{ nativeChannelId: string }>(
          'select native_channel_id as "nativeChannelId" from bp_conversations where project_id=$1',
          [project.id],
        );
        if (!linked) {
          const [assignment] = await transaction.unsafe<{ id: string; nativeBotId: string }>(
            'select id,native_bot_id as "nativeBotId" from bp_assignments where project_id=$1 and role_key=$2',
            [project.id, definition.business!.teamLeadRole],
          );
          if (!assignment || !createConversation) {
            throw new ProductError(409, "team_lead_unavailable", "The Team Lead conversation is not available. Retry project creation.");
          }
          await createConversation({ actor, projectId: project.id, assignmentId: assignment.id, nativeBotId: assignment.nativeBotId });
          const [created] = await transaction.unsafe<{ nativeChannelId: string }>(
            'select native_channel_id as "nativeChannelId" from bp_conversations where project_id=$1',
            [project.id],
          );
          if (!created) throw new ProductError(409, "team_lead_unavailable", "The Team Lead conversation could not be linked. Retry project creation.");
        }
      });
      return project;
    },
    async initialize(actor: ProductActor, projectId: string, inputs: Record<string, Record<string, unknown> & { path?: string; reference?: string }>) {
      const project = await requireProject(module.database, actor, projectId, "manage");
      if (project.state === "Archived") throw new ProductError(409, "project_archived", "This project is archived.");
      const definition = await module.definitionFor(project);
      const business = definition.business!;
      for (const type of Object.keys(inputs)) {
        if (!business.artifactTypes.some(artifact => artifact.id === type)) throw new ProductError(422, "unknown_artifact", "Choose an artifact type declared by this blueprint.");
      }
      for (const [type, value] of Object.entries(inputs)) {
        if (!value || typeof value !== "object" || Array.isArray(value)
          || (value.path !== undefined && typeof value.path !== "string")
          || (value.reference !== undefined && typeof value.reference !== "string")) {
          throw new ProductError(422, "invalid_artifact", "Supply a folder or reference for each artifact.");
        }
        if (type === "source-code" && "revision" in value) {
          throw new ProductError(422, "invalid_artifact", "The source revision is determined by the project workspace.");
        }
        const definition = business.artifactTypes.find(artifact => artifact.id === type)!;
        if (validateSchema(value, definition.schema as Schema).length) {
          throw new ProductError(422, "invalid_artifact", `The ${definition.description} does not match its declared structure.`);
        }
      }
      const result = await module.database.begin(async transaction => {
        // Hold one project lock across the provider call. Concurrent retries
        // must never import into the same guest at the same time.
        await transaction.unsafe("select pg_advisory_xact_lock(hashtextextended($1,0))", [projectId]);
        const current = await requireProject(transaction, actor, projectId, "manage");
        if (current.state === "Archived") throw new ProductError(409, "project_archived", "This project is archived.");
        await transaction.unsafe("update bp_projects set state='Initializing', revision=revision+1 where id=$1", [projectId]);
        const previous = await transaction.unsafe<{ typeKey: string; source: JsonValue }>(
          'select type_key as "typeKey",source from bp_artifacts where project_id=$1', [projectId],
        );
        const changed = new Set(Object.entries(inputs)
          .filter(([type, source]) => {
            const existing = previous.find(artifact => artifact.typeKey === type);
            return !existing || contentDigest(existing.source) !== contentDigest(source as JsonValue);
          }).map(([type]) => type));
        const affected = business.roles.filter(role => role.startupChecks.some(check =>
          (check.kind === "artifact-access" && check.artifactType && changed.has(check.artifactType))
          || (check.kind === "workspace-ready" && changed.has("source-code")),
        )).map(role => role.id);
        if (affected.length) await transaction.unsafe(
          "delete from bp_readiness where project_id=$1 and assignment_id in (select id from bp_assignments where project_id=$1 and role_key in (select jsonb_array_elements_text($2::text::jsonb)))",
          [projectId, JSON.stringify(affected)],
        );
        for (const [type, source] of Object.entries(inputs)) {
          if (type === "source-code" && !source.path?.trim()) {
            throw new ProductError(422, "source_required", "Choose the project source folder to continue.");
          }
          const revision = contentDigest(source as JsonValue);
          await transaction.unsafe(`
            insert into bp_artifacts(project_id,id,type_key,source,status) values($1,$2,$2,$3::text::jsonb,'supplied')
            on conflict(project_id,id) do update set source=excluded.source,status='supplied'
          `, [projectId, type, JSON.stringify(source)]);
          await transaction.unsafe(`
            insert into bp_artifact_revisions(project_id,artifact_id,id,digest,payload,created_by)
            values($1,$2,$3,$3,$4::text::jsonb,$5) on conflict do nothing
          `, [projectId, type, revision, JSON.stringify(source), actor.id]);
        }
        const supplied = await transaction.unsafe<{ typeKey: string }>(
          `select type_key as "typeKey" from bp_artifacts where project_id=$1 and status='supplied'`, [projectId],
        );
        const suppliedTypes = new Set(supplied.map(item => item.typeKey));
        const missing = business.initialization.requiredArtifacts.filter(type => !suppliedTypes.has(type));
        if (missing.length) {
          await transaction.unsafe("update bp_project_vms set state='Blocked',reason=$2,updated_at=now() where project_id=$1",
            [projectId, `Required artifacts are missing: ${missing.join(", ")}.`]);
          return { error: new ProductError(409, "artifact_required", `Required artifacts are missing: ${missing.join(", ")}.`) };
        }
        if (business.initialization.workspace.kind === "none") {
          await transaction.unsafe("update bp_project_vms set state='NotRequired',reason=null,updated_at=now() where project_id=$1", [projectId]);
          return { project: { ...current, state: "Initializing" as const, revision: current.revision + 1 },
            sourceRevision: null, excludesUncommittedChanges: false };
        }
        const [source] = await transaction.unsafe<{ source: { path?: string } }>(
          "select source from bp_artifacts where project_id=$1 and type_key='source-code'", [projectId],
        );
        if (!source?.source.path) {
          await transaction.unsafe("update bp_project_vms set state='Blocked',reason=$2,updated_at=now() where project_id=$1", [projectId, "Choose the project source folder to continue."]);
          return { error: new ProductError(409, "source_required", "Choose the project source folder to continue.") };
        }
        try {
          const ensured = await workspaceCall("ensure", { installationId: current.installationId, projectId, profile: business.initialization.workspace });
          if (!ensured.ready || !ensured.id) throw new Error("Workspace is not ready.");
          const [existing] = await transaction.unsafe<{ providerId: string | null; sourceRevision: string | null; importedSourcePath: string | null; excludesUncommittedChanges: boolean; excludedPaths: string[] }>(
            'select provider_id as "providerId",source_revision as "sourceRevision",imported_source_path as "importedSourcePath",excludes_uncommitted_changes as "excludesUncommittedChanges",excluded_paths as "excludedPaths" from bp_project_vms where project_id=$1',
            [projectId],
          );
          if (existing?.providerId && existing.providerId !== ensured.id) throw new ProductError(409, "workspace_binding_changed", "The project VM binding does not match the existing workspace.");
          let revision = existing?.sourceRevision;
          let excludesUncommittedChanges = existing?.excludesUncommittedChanges ?? false;
          let excludedPaths = existing?.excludedPaths ?? [];
          const sourceChanged = Boolean(revision && existing?.importedSourcePath !== source.source.path);
          const actual = revision ? await workspaceCall("source", { installationId: current.installationId, projectId }) : null;
          if (revision && (!actual?.revision || typeof actual.hasProject !== "boolean")) throw new Error("The guest source state cannot be reconciled.");
          if (!revision || existing?.importedSourcePath !== source.source.path || actual?.revision !== revision || !actual?.hasProject) {
            const imported = await workspaceCall("import", { installationId: current.installationId, projectId, source: source.source.path,
              ...(revision ? { replace: true, expectedRevision: actual!.revision } : {}) });
            revision = imported.revision ?? null;
            excludesUncommittedChanges = imported.excludesUncommittedChanges ?? false;
            excludedPaths = imported.excludedPaths ?? [];
          }
          if (!revision) throw new Error("The source baseline is unavailable.");
          await transaction.unsafe(
            "update bp_project_vms set provider_id=$2,source_revision=$3,excludes_uncommitted_changes=$4,excluded_paths=$5::text::jsonb,imported_source_path=$6,state='Ready',reason=null,updated_at=now() where project_id=$1",
            [projectId, ensured.id, revision, excludesUncommittedChanges, JSON.stringify(excludedPaths), source.source.path],
          );
          return { project: { ...current, state: "Initializing" as const, revision: current.revision + 1 }, sourceRevision: revision, excludesUncommittedChanges, excludedPaths, sourceChanged };
        } catch (error) {
          const affected = business.roles.filter(role => role.startupChecks.some(
            check => check.kind === "workspace-ready",
          )).map(role => role.id);
          if (affected.length) await transaction.unsafe(
            "delete from bp_readiness where project_id=$1 and assignment_id in (select id from bp_assignments where project_id=$1 and role_key in (select jsonb_array_elements_text($2::text::jsonb)))",
            [projectId, JSON.stringify(affected)],
          );
          await transaction.unsafe(
            "update bp_project_vms set state='Blocked',reason=$2,updated_at=now() where project_id=$1",
            [projectId, "Workspace setup could not complete."],
          );
          return { error: error instanceof ProductError ? error : new ProductError(409, "workspace_unavailable", "The project workspace could not be prepared. Retry initialization.") };
        }
      });
      if ("error" in result && result.error) throw result.error;
      return result;
    },
  };
}
