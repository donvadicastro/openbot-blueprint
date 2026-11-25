import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateContract } from "./contract/blueprint-contract.js";
import type { Blueprint } from "./contract/types.js";
import { ProductError, requirePublisher, type ProductActor } from "./access.js";
import { contentDigest, createProductStore, type JsonValue, type ProductDatabase } from "./store.js";

export async function createProductModule(database: ProductDatabase, tenantDirectory?: string) {
  if (!tenantDirectory) return undefined;
  const definition: Blueprint = JSON.parse(await readFile(join(tenantDirectory, "blueprint.json"), "utf8"));
  if (!definition.business) return undefined;
  const schema = JSON.parse(await readFile(new URL("./contract/blueprint.schema.json", import.meta.url), "utf8"));
  const errors = validateContract(definition, schema);
  if (errors.length) throw new Error(`Business blueprint is invalid: ${errors.join("; ")}`);
  const directory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  await database.begin(async transaction => {
    await transaction.unsafe("select pg_advisory_xact_lock(hashtext('blueprint-product-migrations'))");
    await transaction.unsafe("create table if not exists bp_migrations (name text primary key, applied_at timestamptz not null default now())");
    for (const name of (await readdir(directory)).filter(name => /^\d+[-\w]*\.sql$/.test(name)).sort()) {
      const existing = await transaction.unsafe<{ name: string }>("select name from bp_migrations where name = $1", [name]);
      if (existing.length) continue;
      await transaction.unsafe(await readFile(join(directory, name), "utf8"));
      await transaction.unsafe("insert into bp_migrations (name) values ($1)", [name]);
    }
  });
  const store = createProductStore(database);
  const environmentId = process.env.BLUEPRINT_ENVIRONMENT_ID ?? "local";
  const composeProject = process.env.COMPOSE_PROJECT_NAME ?? "openbot-blueprint";
  async function ensure(actor: ProductActor) {
    const [existing] = await database.unsafe<{ id: string }>(
      "select id from bp_installations where environment_id = $1 and blueprint_key = $2",
      [environmentId, definition.id],
    );
    const [version] = await database.unsafe<{ digest: string; definition: Record<string, JsonValue> }>(
      "select digest, definition from bp_blueprint_versions where blueprint_key = $1 and version = $2",
      [definition.id, definition.version],
    );
    const digest = contentDigest(definition as unknown as JsonValue);
    if (version && (version.digest !== digest || contentDigest(version.definition) !== digest)) {
      throw new ProductError(409, "blueprint_version_conflict", "The mounted blueprint differs from its published version.");
    }
    if (!version) {
      requirePublisher(actor);
      await store.registerBlueprint(actor, {
        key: definition.id, version: definition.version, digest,
        definition: definition as unknown as Record<string, JsonValue>,
      });
    }
    if (existing) return existing.id;
    requirePublisher(actor);
    return (await store.ensureInstallation(actor, {
      environmentId, blueprintKey: definition.id, composeProject,
      appUrl: process.env.BLUEPRINT_APP_URL ?? "http://localhost:3010",
    })).id;
  }
  async function publish(actor: ProductActor, input: unknown) {
    requirePublisher(actor);
    const failures = validateContract(input, schema);
    if (failures.length) throw new ProductError(422, "invalid_blueprint", failures.join("; "));
    const blueprint = input as Blueprint;
    if (blueprint.id !== definition.id || !blueprint.business) {
      throw new ProductError(422, "blueprint_identity", "Choose a version of the installed business blueprint.");
    }
    return store.registerBlueprint(actor, {
      key: blueprint.id, version: blueprint.version,
      digest: contentDigest(blueprint as unknown as JsonValue),
      definition: blueprint as unknown as Record<string, JsonValue>,
    });
  }
  async function definitionFor(project: { blueprintKey: string; blueprintVersion: string }): Promise<Blueprint> {
    const [version] = await database.unsafe<{ definition: Blueprint }>(
      "select definition from bp_blueprint_versions where blueprint_key = $1 and version = $2",
      [project.blueprintKey, project.blueprintVersion],
    );
    if (!version) throw new ProductError(409, "blueprint_unavailable", "The project blueprint version is unavailable.");
    return version.definition;
  }
  return { database, store, definition, definitionFor, ensure, publish, schema };
}

export type ProductModule = NonNullable<Awaited<ReturnType<typeof createProductModule>>>;
