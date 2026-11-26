import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'openbot-workspace-auth-'));
execFileSync(resolve('node_modules/.bin/tsc'), [
  '--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext',
  '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'),
  '--outDir', directory, resolve('deploy/openbot/product/workspace-actions.ts'),
], { stdio: 'pipe' });
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { authorizedWorkspaceAction } = await import(pathToFileURL(join(directory, 'workspace-actions.js')).href);
const { conversationWorkspaceAction } = await import(pathToFileURL(join(directory, 'workspace-actions.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('workspace dispatch checks project membership, assignment, role, tool and VM identity', async () => {
  const context = { actor: { id: 'owner', role: 'user' }, projectId: 'project', assignmentId: 'assignment', nativeBotId: 'engineer', actionId: 'implement', tool: 'workspace-edit', operationKey: 'operation' };
  let assignment = { roleKey: 'engineer', nativeBotId: 'engineer' };
  let readiness = [{ roleKey: 'engineer', revision: 1, reportedRevision: 1, status: 'Ready' }];
  let sourceAllowed = true;
  const project = { id: 'project', installationId: 'install', state: 'Operational', permissions: ['read', 'work'] };
  const database = { async begin(callback) { return callback(this); }, async unsafe(sql) {
    if (sql.includes('join bp_memberships')) return [project];
    if (sql.includes('join bp_readiness')) return readiness;
    if (sql.includes('from bp_assignments')) return assignment ? [assignment] : [];
    if (sql.includes('from bp_project_vms')) return [{ providerId: 'vm', sourceRevision: 'revision', state: 'Ready' }];
    if (sql.includes('from bp_artifacts')) return sourceAllowed ? [{ id: 'source' }] : [];
    throw new Error('unexpected query');
  } };
  let protectedAction = false;
  const module = { database, async definitionFor() { return { agents: [{ id: 'engineer', tools: ['workspace-edit'] }], business: { actions: [{ id: 'implement', role: 'engineer', approvalRequired: protectedAction }], artifactTypes: [{ id: 'source-code' }], roles: [{ id: 'engineer', agentId: 'engineer', actions: ['implement'] }] } }; } };
  project.state = 'Initializing';
  await assert.rejects(authorizedWorkspaceAction(module, context, ['true']), error => error.code === 'project_not_operational');
  project.state = 'Archived';
  await assert.rejects(authorizedWorkspaceAction(module, context, ['true']), error => error.code === 'project_not_operational');
  project.state = 'Operational';
  await assert.rejects(authorizedWorkspaceAction(module, { ...context, nativeBotId: 'other' }, ['true']), error => error.code === 'assignment_denied');
  await assert.rejects(authorizedWorkspaceAction(module, { ...context, tool: 'ungranted' }, ['true']), error => error.code === 'tool_denied');
  await assert.rejects(authorizedWorkspaceAction(module, { ...context, actionId: 'deploy' }, ['true']), error => error.code === 'tool_denied');
  assignment = null;
  await assert.rejects(authorizedWorkspaceAction(module, context, ['true']), error => error.code === 'assignment_denied');
  assignment = { roleKey: 'engineer', nativeBotId: 'engineer' };
  protectedAction = true;
  await assert.rejects(authorizedWorkspaceAction(module, context, ['true']), error => error.code === 'approval_gate_unavailable');
  protectedAction = false;
  readiness = [{ roleKey: 'engineer', revision: 2, reportedRevision: 1, status: 'Ready' }];
  await assert.rejects(authorizedWorkspaceAction(module, context, ['true']), error => error.code === 'readiness_stale');
  readiness = [{ roleKey: 'engineer', revision: 1, reportedRevision: 1, status: 'Ready' }];
  const oldFetch = globalThis.fetch;
  const oldUrl = process.env.WORKSPACE_PROVIDER_URL;
  const oldToken = process.env.WORKSPACE_PROVIDER_TOKEN;
  const oldInstallation = process.env.WORKSPACE_PROVIDER_INSTALLATION_ID;
  process.env.WORKSPACE_PROVIDER_URL = 'http://provider.invalid';
  process.env.WORKSPACE_PROVIDER_TOKEN = 'test-token';
  delete process.env.WORKSPACE_PROVIDER_INSTALLATION_ID;
  const calls = [];
  try {
    globalThis.fetch = async (url, request) => {
      calls.push({ path: url.pathname, body: JSON.parse(request.body) });
      return { ok: true, json: async () => url.pathname === '/check' ? { id: 'vm', ready: true, isolated: true } : url.pathname === '/source' ? { hasProject: true, revision: 'revision' } : { status: 'completed', exitCode: 0 } };
    };
    const result = await authorizedWorkspaceAction(module, context, ['true']);
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls.map(call => call.path), ['/check', '/source', '/run']);
    assert.equal(calls[2].body.installationId, 'install');
    assert.equal(calls[2].body.projectId, 'project');
    assert.match(calls[2].body.operationKey, /^[a-f0-9]{64}$/);
    assert.deepEqual(calls[2].body.argv, ['true']);
    sourceAllowed = false;
    await assert.rejects(authorizedWorkspaceAction(module, context, ['true']), error => error.code === 'workspace_source_unavailable');
    sourceAllowed = true;
    globalThis.fetch = async url => ({ ok: true, json: async () => url.pathname === '/check' ? { id: 'vm', ready: true, isolated: true } : { hasProject: true, revision: 'different' } });
    await assert.rejects(authorizedWorkspaceAction(module, context, ['true']), error => error.code === 'workspace_source_unavailable');
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'vm', ready: true }) });
    await assert.rejects(authorizedWorkspaceAction(module, context, ['true']), error => error.code === 'workspace_isolation_unverified');
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'other-vm', ready: true }) });
    await assert.rejects(authorizedWorkspaceAction(module, context, ['true']), error => error.code === 'workspace_unavailable');
    globalThis.fetch = async () => { throw new Error('connection refused'); };
    await assert.rejects(authorizedWorkspaceAction(module, context, ['true']), error => error.code === 'workspace_unavailable');
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries({ WORKSPACE_PROVIDER_URL: oldUrl, WORKSPACE_PROVIDER_TOKEN: oldToken, WORKSPACE_PROVIDER_INSTALLATION_ID: oldInstallation })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('conversation dispatch rechecks the binding inside the action transaction', async () => {
  let lookups = 0;
  const project = { id: 'project', installationId: 'install', state: 'Operational', permissions: ['read', 'work'] };
  const database = { async begin(callback) { return callback(this); }, async unsafe(sql) {
    if (sql.includes('from bp_conversations')) return ++lookups === 1 ? [{ projectId: 'project', assignmentId: 'assignment' }] : [];
    if (sql.includes('join bp_memberships')) return [project];
    throw new Error('The revoked callback must not reach the workspace.');
  } };
  const context = { actor: { id: 'owner', role: 'user' }, channelId: 'channel', nativeBotId: 'engineer', actionId: 'implement', tool: 'workspace-edit', operationKey: 'operation' };
  await assert.rejects(conversationWorkspaceAction({ database }, context, ['true']), error => error.code === 'project_not_found');
  assert.equal(lookups, 2);
});
