import { Hono, type MiddlewareHandler } from "hono";
import { sql } from "drizzle-orm";
import type { ChannelStore } from "../channels/routes";
import { readinessOperations } from "./readiness.js";
import type { AppVariables } from "../auth/guards";
import { ProductError, requireProject } from "./access.js";
import { projectOperations } from "./projects.js";
import { archiveProject } from "./archive.js";
import { recordGuidance } from "./feedback.js";
import type { ProductModule } from "./module.js";
import { migrateLegacyProjects } from "./legacy-projects.js";
import { listWorkItems, readWorkItem } from "./work-query.js";
import { reconcileWorkflow, readWorkflowEngineState } from "./workflow-reconcile.js";
import { answerWorkflowDecision } from "./workflow-decision.js";
import { streamSSE } from "hono/streaming";
import { chatStateEvent, readChatProjection } from "./chat-events.js";

export function createProductRoutes(module: ProductModule, requireUser: MiddlewareHandler<{ Variables: AppVariables }>, channels: ChannelStore) {
  const projects = projectOperations(module, async ({ actor, projectId, assignmentId, nativeBotId }) => {
    await channels.create(actor, [nativeBotId], async (transaction, channel) => {
      await transaction.execute(sql`insert into bp_conversations (project_id,native_channel_id,team_lead_assignment_id) values (${projectId},${channel.id},${assignmentId})`);
    });
  });
  const readiness = readinessOperations(module, channels.productReadiness);
  const routes = new Hono<{ Variables: AppVariables; Bindings: { server?: { timeout(request: Request, seconds: number): void } } }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    if (error instanceof ProductError) return context.json({ error: error.message, code: error.code }, error.status);
    console.error("Product request failed", error instanceof Error ? error.name : "unknown");
    return context.json({ error: "The project operation could not complete." }, 500);
  });
  routes.get("/blueprint", async context => {
    await module.ensure(context.var.actor);
    return context.json({ id: module.definition.id, version: module.definition.version, business: module.definition.business,
      agents: module.definition.agents.map(({ id, name }) => ({ id, name })) });
  });
  routes.post("/blueprints", async context => {
    const result = await module.publish(context.var.actor, await context.req.json().catch(() => null));
    return context.json({ key: result.key, version: result.version, digest: result.digest }, 201);
  });
  routes.post("/legacy/:legacyId/import", async context => {
    const body = await context.req.json().catch(() => null);
    if (!body || !Array.isArray(body.channelIds) || body.channelIds.length > 200 ||
        body.channelIds.some((id: unknown) => typeof id !== 'string' || !id || id.length > 200) ||
        new Set(body.channelIds).size !== body.channelIds.length) {
      throw new ProductError(422, 'invalid_legacy_selection', 'Select the previous conversations to import.');
    }
    if (!channels.teamSetup) throw new ProductError(404, 'legacy_project_not_found', 'Previous project not found.');
    const actor = context.var.actor;
    const groups = await channels.teamSetup.listProjects(actor.id);
    const group = groups.find(item => item.id === context.req.param('legacyId'));
    if (!group || body.channelIds.some((id: string) => !group.conversations.some(item => item.channelId === id))) {
      throw new ProductError(404, 'legacy_project_not_found', 'Previous project or conversation not found.');
    }
    const selected = { ...group, conversations: group.conversations.filter(item => body.channelIds.includes(item.channelId)) };
    await migrateLegacyProjects(module, actor, [selected], (input, key) => projects.create(actor, input, key), { manual: true });
    const installationId = await module.ensure(actor);
    const [mapping] = await module.database.unsafe<{ projectId: string }>(`select project_id as "projectId" from bp_legacy_project_groups
      where installation_id=$1 and owner_id=$2 and legacy_key=$3`, [installationId, actor.id, group.id]);
    if (!mapping) throw new ProductError(409, 'legacy_project_unavailable', 'The previous project could not be imported.');
    return context.json({ projectId: mapping.projectId, imported: selected.conversations.map(item => item.channelId) });
  });
  routes.get("/", async context => {
    await module.ensure(context.var.actor);
    let legacyPending = 0;
    if (channels.teamSetup) {
      const actor = context.var.actor;
      const groups = await channels.teamSetup.listProjects(actor.id);
      for (const group of groups) {
        try { await migrateLegacyProjects(module, actor, [group], (input, key) => projects.create(actor, input, key)); }
        catch (error) {
          if (!(error instanceof ProductError)) throw error;
          legacyPending++;
        }
      }
    }
    return context.json({ projects: await module.store.listProjects(context.var.actor), legacyPending });
  });
  routes.post("/", async context => {
    const body = await context.req.json().catch(() => null);
    if (!body || typeof body.name !== "string") throw new ProductError(422, "invalid_project", "Enter a project name.");
    const project = await projects.create(context.var.actor, body, context.req.header("idempotency-key") ?? "");
    return context.json({ project }, 201);
  });
  routes.post("/:id/initialization", async context => {
    const body = await context.req.json().catch(() => null);
    if (!body || !body.artifacts || typeof body.artifacts !== "object" || Array.isArray(body.artifacts)) {
      throw new ProductError(422, "invalid_artifacts", "Supply the project artifacts.");
    }
    try {
      // VM startup and five sequential specialist turns can exceed the HTTP idle timeout.
      context.env?.server?.timeout(context.req.raw, 0);
      const project = await projects.initialize(context.var.actor, context.req.param("id"), body.artifacts);
      return context.json({ project, readiness: await readiness.refresh(context.var.actor, context.req.param("id")) });
    } catch (error) {
      const blockers = ["artifact_required", "source_required", "workspace_unavailable", "workspace_binding_changed", "workspace_path_too_long", "readiness_stale"];
      if (!(error instanceof ProductError) || error.status !== 409 || !blockers.includes(error.code)) throw error;
      return context.json({ error: error.message, code: error.code, retryable: error.code !== "workspace_binding_changed",
        readiness: await readiness.inspect(context.var.actor, context.req.param("id")) }, 409);
    }
  });
  routes.get("/:id/blueprint", async context => {
    const project = await requireProject(module.database, context.var.actor, context.req.param("id"));
    const definition = await module.definitionFor(project);
    return context.json({ id: definition.id, version: definition.version, business: definition.business,
      agents: definition.agents.map(({ id, name }) => ({ id, name })) });
  });
  routes.get("/:id/readiness", async context => context.json(await readiness.inspect(context.var.actor, context.req.param("id"))));
  routes.post("/:id/readiness", async context => {
    context.env?.server?.timeout(context.req.raw, 0);
    return context.json(await readiness.refresh(context.var.actor, context.req.param("id")));
  });
  routes.post("/:id/archive", async context => context.json({ project: await archiveProject(module, context.var.actor, context.req.param("id")) }));
  routes.get("/:id/work-items", async context => context.json({ workItems: await listWorkItems(module, context.var.actor, context.req.param("id")) }));
  routes.get("/:id/work-items/:workItemId", async context => context.json({ workItem: await readWorkItem(module, context.var.actor, context.req.param("id"), context.req.param("workItemId")) }));
  routes.get('/:id/work-items/:workItemId/runs/:runId/views/:viewId/events', async context => {
    const actor = context.var.actor;
    const { id, workItemId, runId, viewId } = context.req.param();
    // Resolve before opening the stream so hidden resources produce a 404.
    await readChatProjection(module, actor, id, workItemId, runId, viewId);
    context.header('Cache-Control', 'no-store');
    return streamSSE(context, async stream => {
      let previous: unknown | undefined;
      let stopped = false;
      stream.onAbort(() => { stopped = true; });
      // A bounded stream makes reconnects start from a fresh authorized snapshot.
      for (let iteration = 0; iteration < 40 && !stopped; iteration++) {
        let projection: unknown;
        try {
          // The native guard checks the current session and role with cookie
          // caching disabled; do not retain authority from stream creation.
          let authenticated = false;
          await requireUser(context, async () => { authenticated = true; });
          if (!authenticated || context.var.actor.id !== actor.id) throw new Error('Session unavailable');
          projection = await readChatProjection(module, context.var.actor, id, workItemId, runId, viewId);
        }
        catch {
          // Clear previously displayed data if access or its backing resource disappears.
          if (previous !== undefined) await stream.writeSSE({ data: JSON.stringify({ type: 'STATE_SNAPSHOT', snapshot: null }) });
          return;
        }
        const event = chatStateEvent(previous, projection);
        if (event) await stream.writeSSE({ data: JSON.stringify(event) });
        previous = projection;
        await stream.sleep(1500);
      }
    });
  });
  routes.get("/:id/work-items/:workItemId/runs/:runId/status", async context => context.json(await readWorkflowEngineState(module, context.var.actor, context.req.param("id"), context.req.param("workItemId"), context.req.param("runId"))));
  routes.post("/:id/work-items/:workItemId/runs/:runId/reconcile", async context => context.json(await reconcileWorkflow(module, context.var.actor, context.req.param("id"), context.req.param("workItemId"), context.req.param("runId"))));
  routes.post("/:id/work-items/:workItemId/runs/:runId/decisions/:decisionId", async context => {
    const body = await context.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'value')) throw new ProductError(422, 'invalid_decision', 'Choose one of the available options.');
    return context.json(await answerWorkflowDecision(module, context.var.actor, context.req.param('id'), context.req.param('workItemId'), context.req.param('runId'), context.req.param('decisionId'), body.value));
  });
  routes.post("/:id/assignments/:assignmentId/feedback", async context => {
    const body = await context.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProductError(422, "invalid_feedback", "Provide feedback and its source.");
    const result = await recordGuidance(module, context.var.actor, context.req.param("id"), context.req.param("assignmentId"), body,
      context.req.header("idempotency-key") ?? "", channels.productFeedbackTranscript);
    return context.json({ memory: result });
  });
  return routes;
}
