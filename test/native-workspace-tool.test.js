import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'openbot-native-workspace-'));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'), '--outDir', directory, resolve('deploy/openbot/product/native-workspace-tool.ts')]);
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { callNativeWorkspaceTool, nativeWorkspaceTools } = await import(pathToFileURL(join(directory, 'native-workspace-tool.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('workspace tools require an active bound phase and use its stable operation key', async () => {
  const actor = { id: 'owner', role: 'user' }, run = { actorId: 'owner', botId: 'bot', threadId: 'thread', runId: 'native-run' };
  const project = { id: 'project', installationId: 'installation', permissions: ['read', 'work'], state: 'Operational' };
  let active = true;
  const database = { async begin(callback) { return callback(this); }, async unsafe(sql) {
    if (sql.includes('select assignment_id')) return [{ assignmentId: 'assignment' }];
    if (sql.includes('from intelligence_channel_mappings')) return [{ channelId: 'channel' }];
    if (sql.includes('from group_bot_threads')) return [];
    if (sql.includes('from bp_conversations')) return [{ projectId: 'project', assignmentId: 'assignment' }];
    if (sql.includes('from bp_projects')) return [project];
    if (sql.includes('from bp_native_action_runs')) return active ? [{ actionId: 'implement', assignmentId: 'assignment', operationKey: 'stable-operation', tool: 'workspace-edit' }] : [];
    if (sql.includes('join bp_readiness')) return [{ roleKey: 'engineer', revision: 1, reportedRevision: 1, status: 'Ready' }];
    if (sql.includes('from bp_assignments')) return [{ roleKey: 'engineer', nativeBotId: 'bot' }];
    if (sql.includes('from bp_project_vms')) return [{ providerId: 'vm', state: 'Ready', sourceRevision: 'revision' }];
    if (sql.includes('from bp_artifacts')) return [{ id: 'source' }];
    throw Error('Unexpected query');
  } };
  const module = { database, async definitionFor() { return { agents: [{ id: 'bot', tools: ['workspace-edit'] }], business: {
    roles: [{ id: 'engineer', agentId: 'bot', actions: ['implement'] }], actions: [{ id: 'implement', role: 'engineer' }], artifactTypes: [{ id: 'source-code' }],
  } }; } };
  const oldFetch = globalThis.fetch, oldUrl = process.env.WORKSPACE_PROVIDER_URL, oldToken = process.env.WORKSPACE_PROVIDER_TOKEN, oldInstallation = process.env.WORKSPACE_PROVIDER_INSTALLATION_ID;
  process.env.WORKSPACE_PROVIDER_URL = 'http://provider.invalid'; process.env.WORKSPACE_PROVIDER_TOKEN = 'token'; delete process.env.WORKSPACE_PROVIDER_INSTALLATION_ID;
  const calls = [];
  globalThis.fetch = async (url, request) => {
    const body = JSON.parse(request.body); calls.push({ path: url.pathname, body });
    return { ok: true, json: async () => url.pathname === '/check' ? { id: 'vm', ready: true, isolated: true } :
      url.pathname === '/source' ? { hasProject: true, revision: 'revision' } : { status: 'completed', exitCode: 0 } };
  };
  try {
    const tools = await nativeWorkspaceTools(module, actor, run, {}, {}, async () => true);
    assert.equal(tools.length, 2);
    assert.equal(JSON.parse(await tools[0].execute({ argv: ['true'] })).status, 'completed');
    assert.equal(JSON.parse(await tools[1].execute({})).status, 'completed');
    const effectCalls = calls.filter(call => call.path === '/run' || call.path === '/reconcile');
    assert.equal(effectCalls.length, 2);
    assert.equal(effectCalls[0].body.operationKey, effectCalls[1].body.operationKey);
    const input = { name: 'project_workspace_run', actorId: actor.id, botId: 'bot', run, args: { argv: ['true'], projectId: 'other' } };
    assert.equal((await callNativeWorkspaceTool(module, actor, input)).isError, true);
    active = false;
    assert.match(await tools[0].execute({ argv: ['true'] }), /^Refused\./);
    assert.deepEqual(await nativeWorkspaceTools(module, actor, run, {}, {}, async () => true), []);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries({ WORKSPACE_PROVIDER_URL: oldUrl, WORKSPACE_PROVIDER_TOKEN: oldToken, WORKSPACE_PROVIDER_INSTALLATION_ID: oldInstallation })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
