import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { checked, root, scaffold } from '../dist/src/blueprints.js';
import { validateOpenBotEnvironment } from '../dist/src/openbot-environment.js';
import { prepareOpenBot } from '../dist/bin/openbot-compose.js';

const { blueprint } = await checked('software-development');
const validEnvironment = () => ({
  BOT_PROVIDER: 'openai', BOT_MODEL: 'example-model', OPENAI_API_KEY: 'test-provider-key',
  CPK_INTELLIGENCE_API_KEY: 'test-project-key',
  INTELLIGENCE_API_URL: 'https://intelligence.example.com',
  INTELLIGENCE_GATEWAY_WS_URL: 'wss://intelligence.example.com',
  POSTGRES_USER: 'openbot', POSTGRES_DB: 'openbot', POSTGRES_PASSWORD: 'test-password',
  DATABASE_URL: 'postgres://openbot:test-password@postgres:5432/openbot',
  KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  COMPUTER_TOKEN: 'a'.repeat(40), SUPERVISOR_TOKEN: 'b'.repeat(40),
  AGENT_TOOL_TOKEN: 'c'.repeat(40), WORKER_SHARED_SECRET: 'd'.repeat(40),
  MANAGED_AGENT_TOKEN: 'e'.repeat(40),
  OPENBOT_SINGLE_USER: 'true', COMPUTER_BROWSER_MODE: 'headless'
});
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'openbot-compose-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('native environment templates stay aligned and are scaffolded with the blueprint', async t => {
  const template = await readFile(join(root, 'deploy/openbot/.env.example'), 'utf8');
  assert.equal(await readFile(join(root, '.env.example'), 'utf8'), await readFile(join(root, 'blueprints/software-development-custom-bot/deployment/.env.example'), 'utf8'));
  assert.equal(await readFile(join(root, 'blueprints/software-development/deployment/.env.example'), 'utf8'), template);
  assert.doesNotMatch(template, /BLUEPRINT_MODEL_/);
  const directory = await temporary(t);
  const out = join(directory, 'project');
  await scaffold('software-development', out, 'project');
  assert.equal(await readFile(join(out, blueprint.deployment.environmentFile), 'utf8'), template);
});

test('native preflight accepts either supported provider and Intelligence key name', () => {
  assert.deepEqual(validateOpenBotEnvironment(validEnvironment(), blueprint), []);
  const env = validEnvironment();
  env.BOT_PROVIDER = 'anthropic';
  delete env.OPENAI_API_KEY;
  env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  delete env.CPK_INTELLIGENCE_API_KEY;
  env.INTELLIGENCE_API_KEY = 'test-legacy-key';
  assert.deepEqual(validateOpenBotEnvironment(env, blueprint), []);
});

test('missing native settings block startup without exposing credentials', () => {
  const env = validEnvironment();
  delete env.OPENAI_API_KEY;
  delete env.CPK_INTELLIGENCE_API_KEY;
  env.KEY_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
  env.SUPERVISOR_TOKEN = env.COMPUTER_TOKEN;
  env.DATABASE_URL = 'postgres://openbot:sensitive-value@localhost/wrong';
  const errors = validateOpenBotEnvironment(env, blueprint).join('\n');
  for (const field of ['OPENAI_API_KEY', 'CPK_INTELLIGENCE_API_KEY', 'KEY_ENCRYPTION_KEY', 'DATABASE_URL']) assert.match(errors, new RegExp(field));
  assert.match(errors, /distinct/);
  for (const secret of ['sensitive-value', env.COMPUTER_TOKEN, env.KEY_ENCRYPTION_KEY]) assert.ok(!errors.includes(secret));
});

test('preflight enforces native shared identity and selected remote endpoint configuration', () => {
  const env = validEnvironment();
  env.OPENBOT_SINGLE_USER = 'false';
  assert.match(validateOpenBotEnvironment(env, blueprint).join('\n'), /sign-in provider/);
  Object.assign(env, {
    BETTER_AUTH_SECRET: 'e'.repeat(40), INITIAL_ADMIN_EMAILS: 'admin@example.com',
    TRUSTED_ORIGINS: 'http://localhost:3010', BETTER_AUTH_URL: 'http://localhost:3010',
    GOOGLE_OAUTH_CLIENT_ID: 'test-id', GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret'
  });
  assert.deepEqual(validateOpenBotEnvironment(env, blueprint), []);
  const b = structuredClone(blueprint);
  b.agents[0].runtime = { kind: 'remote', protocol: 'ag-ui', endpointEnv: 'LEAD_BOT_URL' };
  assert.match(validateOpenBotEnvironment(env, b).join('\n'), /LEAD_BOT_URL/);
  env.LEAD_BOT_URL = 'http://lead:8000/ag-ui';
  assert.deepEqual(validateOpenBotEnvironment(env, b), []);
});

test('preparation refuses missing credentials before writing a tenant', async t => {
  const directory = await temporary(t);
  const out = join(directory, 'current');
  await assert.rejects(prepareOpenBot('software-development', out, {}), /OpenBot startup blocked/);
  await assert.rejects(access(out), /ENOENT/);
});

test('preparation can be repeated, selects optional coworkers and never writes credential values', async t => {
  const directory = await temporary(t);
  const out = join(directory, 'current');
  const env = validEnvironment();
  assert.equal((await prepareOpenBot('software-development', out, env)).agents, 12);
  env.BLUEPRINT_INCLUDE_OPTIONAL = 'false';
  assert.equal((await prepareOpenBot('software-development', out, env)).agents, 9);
  const model = JSON.parse(await readFile(join(out, 'model.yaml'), 'utf8')).model;
  assert.equal(model.provider, '${BOT_PROVIDER:-openai}');
  assert.equal(model.default_model, '${BOT_MODEL}');
  const template = await readFile(join(out, '.env.example'), 'utf8');
  for (const name of ['OPENAI_API_KEY', 'CPK_INTELLIGENCE_API_KEY', 'KEY_ENCRYPTION_KEY', 'COMPUTER_TOKEN']) assert.ok(!template.includes(env[name]));
  await assert.rejects(prepareOpenBot('software-development', out, { ...env, BLUEPRINT_INCLUDE_OPTIONAL: 'maybe' }), /must be true or false/);
});

test('Compose configuration wires the native platform and isolates its data network', async t => {
  const availability = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (availability.status !== 0) { t.skip('Docker Compose is not installed'); return; }
  const directory = await temporary(t);
  const envPath = join(directory, '.env');
  const botEnvPath = join(directory, '.env.implementer');
  await writeFile(botEnvPath, 'BOT_PROVIDER=openai\nBOT_MODEL=custom-model\nOPENAI_API_KEY=synthetic-bot-key\n');
  const env = { ...validEnvironment(), IMPLEMENTER_ENV_FILE: botEnvPath };
  for (const key of ['POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD', 'DATABASE_URL']) delete env[key];
  await writeFile(envPath, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'));
  const result = spawnSync('docker', ['compose', '--env-file', envPath, 'config', '--format', 'json'], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENBOT_ENV_FILE: envPath },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, 'Compose config failed; rendered environment deliberately omitted');
  const config = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(config.services).sort(), ['agent-computer', 'blueprint-init', 'implementer-bot', 'migrate', 'postgres', 'server', 'supervisor', 'worker']);
  assert.equal(config.services.server.environment.TENANT_PACKAGE_DIR, '/tenant/current');
  assert.equal(config.services.server.depends_on['blueprint-init'].condition, 'service_completed_successfully');
  assert.equal(config.services.server.depends_on['implementer-bot'].condition, 'service_healthy');
  assert.equal(config.services['implementer-bot'].profiles, undefined);
  assert.equal(config.services['implementer-bot'].environment.BOT_MODEL, 'custom-model');
  assert.equal(config.services['implementer-bot'].environment.DATABASE_URL, undefined);
  assert.equal(config.services.server.environment.MANAGED_AGENT_AG_UI_URL, 'http://implementer-bot:4201/ag-ui');
  assert.equal(config.services.server.environment.MANAGED_AGENT_TOKEN, config.services['implementer-bot'].environment.MANAGED_AGENT_TOKEN);
  assert.equal(config.services['blueprint-init'].volumes.find(volume => volume.target === '/definition').source, join(root, 'blueprints/software-development-custom-bot'));
  assert.equal(config.services.postgres.depends_on['blueprint-init'].condition, 'service_completed_successfully');
  for (const service of ['blueprint-init', 'migrate', 'server', 'worker']) {
    assert.equal(config.services[service].environment.DATABASE_URL, 'postgres://openbot:openbot@postgres:5432/openbot');
  }
  for (const key of ['POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD']) {
    assert.equal(config.services.postgres.environment[key], 'openbot');
    assert.equal(config.services['blueprint-init'].environment[key], 'openbot');
  }
  assert.deepEqual(Object.keys(config.services.postgres.networks), ['data']);
  assert.equal(config.networks.data.internal, true);
  assert.equal(config.services.server.ports[0].host_ip, '127.0.0.1');
  assert.equal(config.services.supervisor.environment.COMPUTER_NETWORK, config.networks.agents.name);
  const revision = JSON.parse(await readFile(join(root, 'deploy/openbot/upstream.json'), 'utf8')).revision;
  for (const service of ['migrate', 'server', 'worker']) {
    const build = config.services[service].build;
    assert.equal(build.dockerfile, 'deploy/openbot/server.Dockerfile');
    assert.ok(build.additional_contexts['openbot-source'].endsWith(`#${revision}`));
  }
  for (const service of ['agent-computer', 'supervisor', 'implementer-bot']) assert.ok(config.services[service].build.context.endsWith(`#${revision}`));
  const secretServices = Object.entries(config.services).filter(([, service]) => service.environment?.OPENAI_API_KEY).map(([name]) => name).sort();
  assert.deepEqual(secretServices, ['blueprint-init', 'implementer-bot', 'server']);
});
