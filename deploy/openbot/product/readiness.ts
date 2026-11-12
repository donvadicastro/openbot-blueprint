import { ProductError, requireProject, type ProductActor } from "./access.js";
import type { ProductModule } from "./module.js";
import { contentDigest, type JsonValue } from "./store.js";
import { workspaceCall } from "./workspace.js";

type Assignment = { id: string; roleKey: string; nativeBotId: string; revision: number };
type Artifact = { typeKey: string; source: Record<string, unknown>; status: string };
type Workspace = { providerId: string | null; sourceRevision: string | null; state: string };
type Check = { id: string; kind: string; artifactType?: string };

/**
 * The OpenBot adapter invokes this callback under the assigned bot's project
 * context. A successful response must represent the bot's own check, not an
 * inference from the owner's access or the presence of a configuration.
 */
export type ReadinessProbe = (input: {
  projectId: string;
  assignmentId: string;
  nativeBotId: string;
  roleKey: string;
  actorId: string;
  checks: Check[];
  artifacts: Artifact[];
  workspace: Workspace | null;
}) => Promise<{ ready: boolean; checks: { id: string; passed: boolean; evidence: string }[]; reason?: string }>;

type ReadinessReport = {
  assignmentId: string;
  assignmentRevision: number;
  inputDigest: string;
  status: "Ready" | "Blocked";
  evidence: { reason?: string; checks: { id: string; passed: boolean; evidence: string }[] };
};

export function readinessOperations(module: ProductModule, probe?: ReadinessProbe) {
  return {
    async inspect(actor: ProductActor, projectId: string) {
      const project = await requireProject(module.database, actor, projectId);
      const reports = await module.database.unsafe<{
        assignmentId: string; assignmentRevision: number; inputDigest: string | null;
        status: "Ready" | "Blocked" | "Pending"; evidence: unknown;
        roleKey: string; checkedAt: string | null;
      }>(`
        select a.id as "assignmentId", a.revision as "assignmentRevision",
          r.input_digest as "inputDigest", coalesce(r.status, 'Pending') as status,
          coalesce(r.evidence, '{"reason":"Waiting for the assigned bot to report readiness.","checks":[]}'::jsonb) as evidence,
          a.role_key as "roleKey", r.checked_at as "checkedAt"
        from bp_assignments a left join bp_readiness r on r.project_id=a.project_id and r.assignment_id=a.id
        where a.project_id=$1 order by a.role_key
      `, [projectId]);
      const [workspace] = await module.database.unsafe<Workspace & { reason: string | null; excludedPaths: string[]; excludesUncommittedChanges: boolean }>(`
        select provider_id as "providerId", source_revision as "sourceRevision", state, reason,
          excluded_paths as "excludedPaths", excludes_uncommitted_changes as "excludesUncommittedChanges"
        from bp_project_vms where project_id=$1
      `, [projectId]);
      const [conversation] = await module.database.unsafe<{ nativeChannelId: string }>(`
        select c.native_channel_id as "nativeChannelId"
        from bp_conversations c
        join channel_memberships m on m.channel_id=c.native_channel_id and m.user_id=$2
        join channels ch on ch.id=c.native_channel_id and ch.deleted_at is null
        where c.project_id=$1 limit 1
      `, [projectId, actor.id]);
      const definition = await module.definitionFor(project);
      const artifacts = await module.database.unsafe<{ typeKey: string }>(
        "select type_key as \"typeKey\" from bp_artifacts where project_id=$1 and status='supplied'", [projectId],
      );
      const visibleArtifacts = await module.database.unsafe<{ typeKey: string; source: Record<string, unknown>; status: string }>(
        'select type_key as "typeKey", source, status from bp_artifacts where project_id=$1 and (allowed_user_ids is null or $2 = any(allowed_user_ids)) order by type_key',
        [projectId, actor.id],
      );
      const present = new Set(artifacts.map(artifact => artifact.typeKey));
      return {
        project,
        workspace: workspace ? {
          ...workspace,
          ...(visibleArtifacts.some(artifact => artifact.typeKey === "source-code") ? {} : {
            excludedPaths: [], excludesUncommittedChanges: false, sourceRevision: null,
          }),
        } : null,
        reports,
        artifacts: visibleArtifacts,
        teamLeadChannelId: conversation?.nativeChannelId ?? null,
        missingArtifacts: definition.business!.initialization.requiredArtifacts.filter(type => !present.has(type)),
      };
    },

    async refresh(actor: ProductActor, projectId: string) {
      const project = await requireProject(module.database, actor, projectId, "manage");
      if (project.state === "Archived") throw new ProductError(409, "project_archived", "This project is archived.");
      const definition = await module.definitionFor(project);
      const business = definition.business!;
      const assignments = await module.database.unsafe<Assignment>(`
        select id, role_key as "roleKey", native_bot_id as "nativeBotId", revision
        from bp_assignments where project_id=$1 order by role_key
      `, [projectId]);
      const artifacts = await module.database.unsafe<Artifact>(`
        select type_key as "typeKey", source, status from bp_artifacts
        where project_id=$1 order by type_key
      `, [projectId]);
      const [workspace] = await module.database.unsafe<Workspace>(`
        select provider_id as "providerId", source_revision as "sourceRevision", state
        from bp_project_vms where project_id=$1
      `, [projectId]);

      let workspaceReady = business.initialization.workspace.kind === "none";
      let workspaceReason = "The project workspace is unavailable.";
      if (!workspaceReady && workspace?.providerId && workspace.sourceRevision) {
        try {
          const checked = await workspaceCall("check", { installationId: project.installationId, projectId });
          const reachable = checked.ready === true && checked.id === workspace.providerId;
          workspaceReady = reachable && checked.isolated === true;
          if (checked.status === "IsolationUnverified" || (reachable && !workspaceReady)) workspaceReason = "The project workspace network isolation has not been verified.";
        } catch {
          workspaceReady = false;
        }
      }
      const missingArtifacts = business.initialization.requiredArtifacts.filter(
        type => !artifacts.some(artifact => artifact.typeKey === type && artifact.status === "supplied"),
      );
      const reports: ReadinessReport[] = [];
      for (const role of business.roles) {
        const assignment = assignments.find(item => item.roleKey === role.id);
        if (!assignment) continue;
        const inputDigest = contentDigest({
          assignmentId: assignment.id,
          assignmentRevision: assignment.revision,
          artifacts: artifacts as unknown as JsonValue,
          workspace: (workspace ?? null) as unknown as JsonValue,
        });
        const required = role.startupChecks;
        let result: Awaited<ReturnType<ReadinessProbe>> | undefined;
        if (probe && workspaceReady && !missingArtifacts.length) {
          try {
            result = await probe({
              projectId, assignmentId: assignment.id, nativeBotId: assignment.nativeBotId,
              roleKey: role.id, actorId: actor.id, checks: required, artifacts, workspace: workspace ?? null,
            });
          } catch {
            result = undefined;
          }
        }
        const allChecksPassed = result?.ready === true && required.every(check => {
          const matches = result!.checks.filter(item => item.id === check.id);
          return matches.length === 1 && matches[0].passed && Boolean(matches[0].evidence.trim());
        });
        const reason = missingArtifacts.length ? `Required artifacts are missing: ${missingArtifacts.join(", ")}.`
          : !workspaceReady ? workspaceReason
            : !result ? "Waiting for the assigned bot to report readiness."
              : !allChecksPassed ? result.reason ?? "The assigned bot reported an incomplete readiness check."
                : undefined;
        reports.push({
          assignmentId: assignment.id, assignmentRevision: assignment.revision, inputDigest,
          status: !reason && allChecksPassed ? "Ready" : "Blocked",
          evidence: { ...(reason ? { reason } : {}), checks: result?.checks ?? [] },
        });
      }
      await module.database.begin(async transaction => {
        await transaction.unsafe("select pg_advisory_xact_lock(hashtextextended($1,0))", [projectId]);
        const current = await requireProject(transaction, actor, projectId, "manage");
        if (current.state === "Archived" || current.revision !== project.revision) {
          throw new ProductError(409, "readiness_stale", "Project setup changed while readiness checks were running. Check again.");
        }
        const currentAssignments = await transaction.unsafe<Assignment>(`
          select id, role_key as "roleKey", native_bot_id as "nativeBotId", revision
          from bp_assignments where project_id=$1 order by role_key for share
        `, [projectId]);
        if (currentAssignments.length !== assignments.length || currentAssignments.some((assignment, index) => {
          const previous = assignments[index];
          return !previous || assignment.id !== previous.id || assignment.roleKey !== previous.roleKey ||
            assignment.nativeBotId !== previous.nativeBotId || assignment.revision !== previous.revision;
        })) {
          throw new ProductError(409, "readiness_stale", "Bot assignments changed while readiness checks were running. Check again.");
        }
        for (const report of reports) {
          await transaction.unsafe(`
            insert into bp_readiness(project_id,assignment_id,assignment_revision,input_digest,status,evidence)
            values($1,$2,$3,$4,$5,$6::text::jsonb)
            on conflict(project_id,assignment_id) do update set
              assignment_revision=excluded.assignment_revision,input_digest=excluded.input_digest,
              status=excluded.status,evidence=excluded.evidence,checked_at=now()
          `, [projectId, report.assignmentId, report.assignmentRevision, report.inputDigest, report.status, JSON.stringify(report.evidence)]);
        }
        const allReady = workspaceReady && !missingArtifacts.length
          && assignments.length === business.roles.length
          && reports.length === business.roles.length
          && reports.every(report => report.status === "Ready");
        await transaction.unsafe(
          "update bp_projects set state=$2,revision=revision+1 where id=$1",
          [projectId, allReady ? "Operational" : "Initializing"],
        );
        if (!workspaceReady && business.initialization.workspace.kind === "vm") {
          await transaction.unsafe(
            "update bp_project_vms set state='Blocked',reason=$2,updated_at=now() where project_id=$1",
            [projectId, workspaceReason],
          );
        }
      });
      return this.inspect(actor, projectId);
    },
  };
}
