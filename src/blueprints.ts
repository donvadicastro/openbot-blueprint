import { readFile, readdir, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema } from './schema.js';
import { validateContract } from './blueprint-contract.js';
import type { Schema } from './schema.js';
import type { Agent, Blueprint } from './types.js';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const schema: Schema = JSON.parse(await readFile(join(root, 'schemas/blueprint.schema.json'), 'utf8'));
export async function catalog() {
  return (await readdir(join(root, 'blueprints'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}
export function blueprintPath(input: string) {
  return /^[a-z][a-z0-9-]*$/.test(input)
    ? join(root, 'blueprints', input, 'blueprint.json') : resolve(input);
}
export async function load(input: string): Promise<{ path: string; blueprint: unknown }> {
  const path = blueprintPath(input);
  return { path, blueprint: JSON.parse(await readFile(path, 'utf8')) };
}
export async function readAsset(directory: string, asset: string) {
  if (isAbsolute(asset)) throw new Error(`asset must be relative: ${asset}`);
  const base = await realpath(directory);
  const lexical = relative(base, resolve(base, asset));
  if (!lexical || lexical === '..' || lexical.startsWith('../') || isAbsolute(lexical)) throw new Error(`asset escapes blueprint directory: ${asset}`);
  const path = await realpath(resolve(base, asset));
  const rel = relative(base, path);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error(`asset escapes blueprint directory: ${asset}`);
  const content = await readFile(path, 'utf8');
  if (!content.trim()) throw new Error(`asset is empty: ${asset}`);
  return content;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runtimeAssets(agent: Agent): string[] {
  const runtime = agent.runtime;
  return runtime?.kind === 'local'
    ? [runtime.entrypoint, runtime.dependencyFile, ...(runtime.files ?? [])] : [];
}

export async function validate(blueprint: unknown, directory: string): Promise<string[]> {
  const shapeErrors = validateSchema(blueprint, schema);
  if (shapeErrors.length) return shapeErrors;
  const b = blueprint as Blueprint;
  const errors = validateContract(b, schema);
  for (const agent of b.agents) {
    try { await readAsset(directory, agent.prompt); }
    catch (error) { errors.push(`${agent.id}: ${errorMessage(error)}`); }
    for (const asset of runtimeAssets(agent)) {
      try { await readAsset(directory, asset); }
      catch (error) { errors.push(`${agent.id} runtime: ${errorMessage(error)}`); }
    }
  }
  for (const resource of b.resources) if (resource.path) {
    try { await readAsset(directory, resource.path); }
    catch (error) { errors.push(`${resource.id}: ${errorMessage(error)}`); }
  }
  if (b.deployment) {
    for (const asset of [b.deployment.environmentFile, ...(b.deployment.files ?? [])]) {
      try { await readAsset(directory, asset); }
      catch (error) { errors.push(`deployment: ${errorMessage(error)}`); }
    }
  }
  return errors;
}

export async function checked(input: string): Promise<{ path: string; blueprint: Blueprint }> {
  const result = await load(input);
  const errors = await validate(result.blueprint, dirname(result.path));
  if (errors.length) throw new Error(errors.join('\n'));
  return { path: result.path, blueprint: result.blueprint as Blueprint };
}

// Reserve a fresh output directory; never overwrite an existing project.
export async function createOutput(output: string, inputs: string[] = []) {
  const requested = resolve(output);
  await mkdir(dirname(requested), { recursive: true });
  const destination = join(await realpath(dirname(requested)), requested.split(/[\\/]/).at(-1)!);
  for (const input of inputs) {
    const rel = relative(input, destination);
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('output must be outside the source blueprint');
  }
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination);
  return destination;
}

export async function scaffold(source: string, output: string, id: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('id must be lowercase kebab-case');
  const { blueprint, path } = await checked(source);
  const directory = dirname(path);
  // Resolve all assets before creating output. Copy only declared files, never .env or credentials.
  const paths = new Set([
    ...blueprint.agents.map(a => a.prompt),
    ...blueprint.agents.flatMap(runtimeAssets),
    ...(blueprint.deployment ? [blueprint.deployment.environmentFile, ...(blueprint.deployment.files ?? [])] : []),
    ...blueprint.resources.flatMap(r => r.path ? [r.path] : [])
  ]);
  const assets = await Promise.all([...paths].map(async p => [p, await readAsset(directory, p)] as const));
  const out = await createOutput(output, [await realpath(directory)]);
  for (const [p, content] of assets) {
    // Normalize lexical traversal too (readAsset already checked resolved containment).
    const target = resolve(out, relative(directory, resolve(directory, p)));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx' });
  }
  blueprint.id = id;
  blueprint.name = id.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join(' ');
  blueprint.version = '0.1.0';
  blueprint.$schema = './blueprint.schema.json';
  await writeFile(join(out, 'blueprint.schema.json'), JSON.stringify(schema, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(out, 'blueprint.json'), JSON.stringify(blueprint, null, 2) + '\n', { flag: 'wx' });
  return out;
}

async function systemPrompt(agent: Agent, agents: Agent[], entrypoint: string, coordinator: string | undefined, directory: string) {
  const prompt = await readAsset(directory, agent.prompt);
  const coordinating = agent.id === entrypoint || agent.id === coordinator;
  const readiness = (coordinating ? agents : [agent]).flatMap(bot => bot.readiness?.length
    ? [
        `### ${bot.name} (${bot.id})${bot.activateWhen ? ` — when: ${bot.activateWhen}` : ''}`,
        ...bot.readiness.map(({ id, stage, instruction }) => `- \`${id}\` (${stage}): ${instruction}`),
      ]
    : []);
  if (!readiness.length) return prompt;
  const instructions = coordinating
    ? 'Use only the roles relevant to the request. Resolve intake fields through conversation and distinguish them from assignment fields produced by the team. Before message_bot, supply every required field for the recipient as a JSON object of strings in constraints. Include extra context in task or expecting. If you cannot verify a required fact, hold the handoff and explain the blocker.'
    : 'Check the fields below before doing assigned work. Verify required access with your granted tools. If a field or verification is missing, report the blocker and ask for the missing input before proceeding.';
  return `${prompt.trimEnd()}\n\n## Readiness requirements\n\n${instructions}\n\n${readiness.join('\n')}\n`;
}

export function includedAgents(blueprint: Blueprint, includeOptional: boolean): Agent[] {
  const required = new Set(blueprint.business?.roles.map(role => role.agentId) ?? []);
  return blueprint.agents.filter(agent => includeOptional || agent.tier === 'core' || required.has(agent.id));
}

export async function exportOpenBot(input: string, output: string, includeOptional = false) {
  const { blueprint: b, path } = await checked(input);
  const agents = includedAgents(b, includeOptional);
  const local = agents.filter(a => a.runtime?.kind === 'local');
  if (local.length) throw new Error(`Cannot export local bots directly: ${local.map(a => a.id).join(', ')}. Deploy them behind AG-UI endpoints and declare remote runtimes first.`);
  const rows = await Promise.all(agents.map(async a => ({
    id: a.id, name: a.name, title: a.role, role_description: a.purpose,
    avatar_seed: a.id,
    ...(a.runtime?.kind === 'remote'
      ? { type: 'remote-ag-ui', endpoint: `\${${a.runtime.endpointEnv}}` }
      : { type: 'built-in', system_prompt: await systemPrompt(a, agents, b.entrypoint, b.intake?.handoffTo, dirname(path)) })
  })));
  const out = await createOutput(output, [await realpath(dirname(path))]);
  const files = {
    // JSON is a YAML 1.2 subset, which avoids a YAML dependency and unsafe interpolation.
    'brand.yaml': { tenant: { id: b.id, product_name: b.name } },
    'agents.yaml': { agents: rows },
    'channels.yaml': { channels: [{ id: b.id, name: b.name, description: b.description, permitted_agents: agents.map(a => a.id), allowed_groups: ['all'] }] },
    'model.yaml': { model: { provider: '${BOT_PROVIDER:-openai}', credential_secret_ref: '${BOT_PROVIDER:-openai}-api-key', default_model: '${BOT_MODEL}' } },
    'knowledge.yaml': { sources: [] },
    'blueprint.json': b
  };
  for (const [name, value] of Object.entries(files)) await writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const endpointEnvs = [...new Set(agents.flatMap(a => a.runtime?.kind === 'remote' ? [a.runtime.endpointEnv] : []))];
  const environmentTemplate = b.deployment
    ? await readAsset(dirname(path), b.deployment.environmentFile)
    : await readFile(join(root, 'deploy/openbot/.env.example'), 'utf8');
  const missingEndpointEnvs = endpointEnvs.filter(name => !new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, 'm').test(environmentTemplate));
  await writeFile(join(out, '.env.example'), environmentTemplate + '\n' + missingEndpointEnvs.map(name => `${name}=`).join('\n') + '\n');
  for (const asset of b.deployment?.files ?? []) {
    const target = resolve(out, asset);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readAsset(dirname(path), asset), { flag: 'wx' });
  }
  await writeFile(join(out, 'INTEGRATION.md'), `# OpenBot integration checklist\n\nGenerated from ${b.id}@${b.version}.\n\nThis export declares coworkers and one channel for OpenBot to load. It is not a running multi-agent system.\nThe blueprint.json is reference metadata. The bundled OpenBot deployment also reads its optional team intake settings.\n\n1. Copy .env.example to .env and fill the native OpenBot settings before startup: BOT_PROVIDER, BOT_MODEL, the selected provider key, Intelligence project settings, database settings, vault key and internal service tokens. No credentials are created by this project. Set any remote endpoint variables from .env.example; remote services own their prompts and tools.\n2. Set TENANT_PACKAGE_DIR to this directory's absolute path.\n3. Configure OpenBot's required database, encryption and Intelligence environment settings, following its own setup documentation.\n4. Provision computers, register tools, connect resources and grant per-agent access in OpenBot. No tools or source connections are granted by this export.\n5. Implement directed delegation, workflow scheduling, quality gates, optional-agent activation and budgets in your orchestrator. Prompts alone do not enforce them.\n6. Validate this package against your pinned OpenBot version and exercise a complete request before deployment.\n\nOptional specialists: ${includeOptional ? 'included as available coworkers; activation still requires orchestration' : 'optional roles excluded unless required by the business contract (use --include-optional to include all)'} .\n\nSource reference: https://github.com/CopilotKit/OpenBot/blob/main/docs/configuration.md\n`);
  return out;
}
