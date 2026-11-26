import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'openbot-ready-vm-'));
execFileSync(resolve('node_modules/.bin/tsc'), [
  '--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext',
  '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'),
  '--outDir', directory, resolve('deploy/openbot/product/readiness-workspace.ts'),
], { stdio: 'pipe' });
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { verifyReadinessWorkspace } = await import(pathToFileURL(join(directory, 'readiness-workspace.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('readiness checks the assigned bot, project VM and exact source revision', async () => {
  const input = { actorId: 'owner', projectId: 'p', assignmentId: 'a', nativeBotId: 'qa', roleKey: 'quality' };
  const project = { id: 'p', installationId: 'install', state: 'Initializing', permissions: ['read', 'manage'] };
  const database = { async unsafe(sql) {
    if (sql.includes('join bp_memberships')) return [project];
    if (sql.includes('from bp_assignments')) return [{ roleKey: 'quality', nativeBotId: 'qa' }];
    if (sql.includes('from bp_project_vms')) return [{ providerId: 'vm', sourceRevision: 'revision', state: 'Ready' }];
    if (sql.includes('from bp_artifacts')) return [{ id: 'source' }];
    throw new Error('unexpected query');
  } };
  const module = { database, async definitionFor() { return { agents: [{ id: 'qa', tools: ['repository-read'] }], business: { roles: [{ id: 'quality', agentId: 'qa' }], artifactTypes: [{ id: 'source-code', owner: 'engineering', producers: [], consumers: ['quality'] }] } }; } };
  await assert.rejects(verifyReadinessWorkspace(module, { ...input, nativeBotId: 'other' }), error => error.code === 'tool_denied');
  const oldFetch = globalThis.fetch;
  const oldUrl = process.env.WORKSPACE_PROVIDER_URL;
  const oldToken = process.env.WORKSPACE_PROVIDER_TOKEN;
  const oldInstallation = process.env.WORKSPACE_PROVIDER_INSTALLATION_ID;
  process.env.WORKSPACE_PROVIDER_URL = 'http://provider.invalid';
  process.env.WORKSPACE_PROVIDER_TOKEN = 'test-token';
  delete process.env.WORKSPACE_PROVIDER_INSTALLATION_ID;
  let revision = 'revision';
  const calls = [];
  try {
    globalThis.fetch = async (url, request) => {
      calls.push({ path: url.pathname, body: JSON.parse(request.body) });
      return { ok: true, json: async () => url.pathname === '/check' ? { id: 'vm', ready: true, isolated: true } : url.pathname === '/source' ? { revision, hasProject: true } : { status: 'completed', exitCode: 0, stdout: '' } };
    };
    assert.equal((await verifyReadinessWorkspace(module, input)).verified, true);
    assert.equal(calls[2].body.projectId, 'p');
    assert.match(calls[2].body.argv[2], /^unreadable=\$\(find /);
    if (process.platform === 'linux') {
      const home = await mkdtemp(join(tmpdir(), 'openbot-readiness-command-'));
      try {
        await mkdir(join(home, '.openbot'));
        await writeFile(join(home, '.openbot', 'source-revision'), 'revision');
        const command = calls[2].body.argv;
        const execution = spawnSync(command[0], command.slice(1), { cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8' });
        assert.equal(execution.status, 0, execution.stderr);
        assert.equal(execution.stdout, '');
      } finally { await rm(home, { recursive: true, force: true }); }
    }
    revision = 'wrong-revision';
    assert.equal((await verifyReadinessWorkspace(module, input)).verified, false);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries({ WORKSPACE_PROVIDER_URL: oldUrl, WORKSPACE_PROVIDER_TOKEN: oldToken, WORKSPACE_PROVIDER_INSTALLATION_ID: oldInstallation })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
