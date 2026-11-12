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

export function createProductRoutes(module: ProductModule, requireUser: MiddlewareHandler<{ Variables: AppVariables }>, channels: ChannelStore) {
  const projects = projectOperations(module, async ({ actor, projectId, assignmentId, nativeBotId }) => {
    await channels.create(actor, [nativeBotId], async (transaction, channel) => {
      await transaction.execute(sql`insert into bp_conversations (project_id,native_channel_id,team_lead_assignment_id) values (${projectId},${channel.id},${assignmentId})`);
    });
  });
  const readiness = readinessOperations(module, channels.productReadiness);
  const routes = new Hono<{ Variables: AppVariables }>();
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
  routes.get("/", async context => {
    await module.ensure(context.var.actor);
    return context.json({ projects: await module.store.listProjects(context.var.actor) });
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
    const project = await projects.initialize(context.var.actor, context.req.param("id"), body.artifacts);
    return context.json({ project, readiness: await readiness.refresh(context.var.actor, context.req.param("id")) });
  });
  routes.get("/:id/blueprint", async context => {
    const project = await requireProject(module.database, context.var.actor, context.req.param("id"));
    const definition = await module.definitionFor(project);
    return context.json({ id: definition.id, version: definition.version, business: definition.business,
      agents: definition.agents.map(({ id, name }) => ({ id, name })) });
  });
  routes.get("/:id/readiness", async context => context.json(await readiness.inspect(context.var.actor, context.req.param("id"))));
  routes.post("/:id/readiness", async context => context.json(await readiness.refresh(context.var.actor, context.req.param("id"))));
  routes.post("/:id/archive", async context => context.json({ project: await archiveProject(module, context.var.actor, context.req.param("id")) }));
  routes.post("/:id/assignments/:assignmentId/feedback", async context => {
    const body = await context.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProductError(422, "invalid_feedback", "Provide feedback and its source.");
    const result = await recordGuidance(module, context.var.actor, context.req.param("id"), context.req.param("assignmentId"), body,
      context.req.header("idempotency-key") ?? "", channels.productFeedbackTranscript);
    return context.json({ memory: result });
  });
  return routes;
}
