import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { checked, validate, scaffold, exportOpenBot, root } from '../dist/src/blueprints.js';

const id = 'software-development-custom-bot';
const { blueprint, path } = await checked(id);
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'custom-bot-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('custom implementer blueprint preserves the team and declares a native remote endpoint', () => {
  assert.equal(blueprint.agents.length, 12);
  const implementer = blueprint.agents.find(agent => agent.id === 'implementer');
  assert.deepEqual(implementer.runtime, { kind: 'remote', protocol: 'ag-ui', endpointEnv: 'MANAGED_AGENT_AG_UI_URL' });
  assert.ok(blueprint.agents.filter(agent => agent.id !== 'implementer').every(agent => agent.runtime.kind === 'builtin'));
});

test('scaffolding and export preserve custom deployment assets and existing endpoint defaults', async t => {
  const directory = await temporary(t);
  const project = join(directory, 'project');
  await scaffold(id, project, 'my-suite');
  const tenant = join(directory, 'tenant');
  await exportOpenBot(id, tenant);
  for (const asset of blueprint.deployment.files) {
    const expected = await readFile(join(dirname(path), asset), 'utf8');
    assert.equal(await readFile(join(project, asset), 'utf8'), expected);
    assert.equal(await readFile(join(tenant, asset), 'utf8'), expected);
  }
  await access(join(project, 'prompts/implementer.md'));
  const env = await readFile(join(tenant, '.env.example'), 'utf8');
  assert.equal([...env.matchAll(/^MANAGED_AGENT_AG_UI_URL=/gm)].length, 1);
  assert.match(env, /^MANAGED_AGENT_AG_UI_URL=http:\/\/implementer-bot:4201\/ag-ui$/m);
  const { agents } = JSON.parse(await readFile(join(tenant, 'agents.yaml'), 'utf8'));
  assert.equal(agents.find(agent => agent.id === 'implementer').endpoint, '${MANAGED_AGENT_AG_UI_URL}');
  for (const id of ['product-manager', 'business-analyst']) {
    const agent = agents.find(agent => agent.id === id);
    assert.equal(agent.type, 'built-in');
    assert.ok(agent.role_description && agent.system_prompt);
  }
});

test('declared deployment files must exist and remain contained', async () => {
  for (const asset of ['missing.yml', '../../package.json']) {
    const b = structuredClone(blueprint);
    b.deployment.files.push(asset);
    assert.ok((await validate(b, dirname(path))).some(message => message.startsWith('deployment:')));
  }
});

test('default Compose provisions custom registration and separate model environment without an override', async t => {
  if (spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status !== 0) { t.skip('Docker Compose is not installed'); return; }
  const directory = await temporary(t);
  const envPath = join(directory, '.env');
  const botEnvPath = join(directory, '.env.implementer');
  await writeFile(botEnvPath, 'BOT_PROVIDER=openai\nBOT_MODEL=custom-coding-model\nOPENAI_BASE_URL=http://host.docker.internal:1234/v1\n');
  const env = {
    POSTGRES_PASSWORD: 'synthetic-db-password', DATABASE_URL: 'postgres://openbot:synthetic-db-password@postgres:5432/openbot',
    KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    COMPUTER_TOKEN: 'a'.repeat(40), SUPERVISOR_TOKEN: 'b'.repeat(40),
    AGENT_TOOL_TOKEN: 'c'.repeat(40), WORKER_SHARED_SECRET: 'd'.repeat(40), MANAGED_AGENT_TOKEN: 'e'.repeat(40),
    BOT_PROVIDER: 'openai', BOT_MODEL: 'platform-model', OPENAI_API_KEY: 'synthetic-platform-key',
    BLUEPRINT_DIR: './blueprints/software-development-custom-bot',
    MANAGED_AGENT_AG_UI_URL: 'http://implementer-bot:4201/ag-ui', AGENT_ENDPOINT_ALLOWED_HOSTS: 'implementer-bot:4201',
    IMPLEMENTER_ENV_FILE: botEnvPath
  };
  await writeFile(envPath, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'));
  const base = ['compose', '--env-file', envPath, '-f', 'docker-compose.yml'];
  const options = { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENBOT_ENV_FILE: envPath }, encoding: 'utf8' };
  const result = spawnSync('docker', [...base, 'config', '--format', 'json'], options);
  assert.equal(result.status, 0, 'Compose merge failed; rendered credentials deliberately omitted');
  const config = JSON.parse(result.stdout);
  const server = config.services.server;
  const bot = config.services['implementer-bot'];
  assert.equal(server.environment.MANAGED_AGENT_AG_UI_URL, env.MANAGED_AGENT_AG_UI_URL);
  assert.equal(server.environment.MANAGED_AGENT_TOKEN, bot.environment.MANAGED_AGENT_TOKEN);
  assert.equal(server.depends_on['implementer-bot'].condition, 'service_healthy');
  assert.equal(bot.depends_on['blueprint-init'].condition, 'service_completed_successfully');
  assert.equal(server.environment.BOT_MODEL, 'platform-model');
  assert.equal(bot.environment.BOT_MODEL, 'custom-coding-model');
  assert.equal(bot.environment.OPENAI_BASE_URL, 'http://host.docker.internal:1234/v1');
  assert.equal(bot.environment.OPENAI_API_KEY, undefined);
  assert.ok(bot.extra_hosts.includes('host.docker.internal=host-gateway'));
  assert.equal(bot.environment.DATABASE_URL, undefined);
  for (const service of ['blueprint-init', 'migrate', 'server', 'worker']) {
    assert.equal(config.services[service].environment.DATABASE_URL, env.DATABASE_URL);
  }
  assert.equal(config.services.postgres.environment.POSTGRES_PASSWORD, env.POSTGRES_PASSWORD);
  assert.equal(bot.environment.KEY_ENCRYPTION_KEY, undefined);
  assert.equal(bot.environment.OPENBOT_TOOL_URL, 'http://server:3001/api/agent-tools/call');
  assert.equal(bot.ports, undefined);
  assert.deepEqual(Object.keys(bot.networks), ['agents']);
  const revision = JSON.parse(await readFile(join(root, 'deploy/openbot/upstream.json'), 'utf8')).revision;
  assert.ok(bot.build.context.endsWith(`#${revision}`));

  const compatibility = spawnSync('docker', [...base, '-f', `${dirname(path)}/deployment/compose.custom-bot.yml`, 'config', '--format', 'json'], options);
  assert.equal(compatibility.status, 0, 'Reference override must remain compatible');
  assert.deepEqual(JSON.parse(compatibility.stdout).services['implementer-bot'], bot);

  const published = spawnSync('docker', [...base, '-f', `${dirname(path)}/deployment/compose.host-access.yml`, 'config', '--format', 'json'], options);
  assert.equal(published.status, 0, 'Host-access Compose merge failed');
  const ports = JSON.parse(published.stdout).services['implementer-bot'].ports;
  assert.equal(ports[0].host_ip, '127.0.0.1');
  assert.equal(ports[0].published, '4201');
});
