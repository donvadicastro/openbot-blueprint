// Run in the pinned server image, which provides Hono and OpenBot's modules.
import { createProductRoutes } from "/app/server/src/product/routes.ts";

const database = {
  unsafe: async (_sql: string, args: unknown[]) => args[0] === "p"
    ? [{ id: "p", permissions: ["read"], state: "Initializing" }] : [],
};
const module = {
  database,
  definitionFor: async () => ({ id: "swe", version: "1.0.0", business: {}, agents: [{ id: "qa", name: "QA" }] }),
};
const authenticate = async (context: any, next: () => Promise<void>) => {
  context.set("actor", { id: "u", role: "user" });
  await next();
};
const app = createProductRoutes(module as any, authenticate, {} as any);
const response = await app.request("/p/blueprint");
const value = await response.json() as { version: string; agents: { name: string }[] };
if (response.status !== 200 || value.version !== "1.0.0" || value.agents[0]?.name !== "QA") {
  throw new Error("The pinned project blueprint was not returned.");
}
if ((await app.request("/other/blueprint")).status !== 404) {
  throw new Error("An unauthorized project blueprint was visible.");
}
console.log("Pinned project blueprint authorization passed.");
