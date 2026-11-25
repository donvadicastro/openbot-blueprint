import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { PhaseRequest } from "./phase-activity.js";

export type PhaseOutcome = { kind: "advance"; nextPhase: string; delaySeconds?: number } | { kind: "wait"; decisionId: string; question: string }
  | { kind: "complete"; result: string } | { kind: "blocked" | "uncertain"; reason: string };
export type WorkflowActivityHandler = {
  execute(request: PhaseRequest & { decision?: { id: string; value: unknown } }): Promise<PhaseOutcome>;
  reconcile(request: PhaseRequest & { decision?: { id: string; value: unknown } }): Promise<PhaseOutcome | { kind: "not-started" }>;
};

/** Private worker transport. Business authorization and effect reconciliation belong to the handler. */
export function createWorkflowActivityRoutes(token: string, handler: WorkflowActivityHandler) {
  if (token.length < 32) throw new Error("Configure a workflow activity token of at least 32 characters.");
  const routes = new Hono();
  routes.use("*", async (context, next) => {
    const supplied = Buffer.from(context.req.header("authorization") ?? ""), expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return context.json({ error: "Unauthorized." }, 401);
    await next();
  });
  routes.post("/:operation", async context => {
    const operation = context.req.param("operation");
    if (operation !== "execute" && operation !== "reconcile") return context.json({ error: "Not found." }, 404);
    const length = Number(context.req.header("content-length") ?? 0);
    if (!Number.isFinite(length) || length < 0 || length > 65536) return context.json({ error: "Request too large." }, 413);
    const reader = context.req.raw.body?.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65536) { await reader.cancel(); return context.json({ error: "Request too large." }, 413); }
      chunks.push(chunk.value);
    }
    let request: unknown;
    try { request = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return context.json({ error: "Invalid request." }, 422); }
    if (!request || typeof request !== "object" || Array.isArray(request)) return context.json({ error: "Invalid request." }, 422);
    try {
      const result = await handler[operation](request as PhaseRequest);
      return context.json(result);
    } catch {
      // A transport failure must not be interpreted as permission to retry an effect.
      return context.json({ error: "The workflow activity could not be confirmed." }, 503);
    }
  });
  return routes;
}
