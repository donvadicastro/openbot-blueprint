import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'openbot-engine-test-'));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'), '--outDir', directory, resolve('deploy/openbot/product/workflow-engine.ts')], { stdio: 'pipe' });
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { dispatchPendingWorkflow } = await import(pathToFileURL(join(directory, 'workflow-engine.js')).href);
const { contentDigest } = await import(pathToFileURL(join(directory, 'store.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('dispatch pins the plan and leaves an ambiguous start pending for retry', async () => {
  const plan = { workflow: { startPhase: 'start', phases: [{ id: 'start', action: 'build' }] }, guidance: [] };
  const row = { projectId: 'p', runId: 'r', occurrenceId: 'o', attempt: 1, installationId: 'i', phaseKey: 'start', actionId: 'build', assignmentRole: 'engineer', assignmentBot: 'engineer-bot', planDigest: contentDigest(plan), plan,
    definition: { business: { roles: [{ id: 'engineer', agentId: 'engineer-bot' }], actions: [{ id: 'build', role: 'engineer' }], initialization: { workspace: { kind: 'none' } } } } };
  const updates = [];
  let reportStatus = 'Ready';
  const database = { async begin(callback) { return callback(this); }, async unsafe(sql, args) {
    if (sql.includes('dispatch_failures=dispatch_failures+1')) return [];
    if (sql.includes('from bp_dispatch_intents')) return [row];
    if (sql.includes('for share of p,m,c,cm,ch')) return [{ id: 'p' }];
    if (sql.includes('from bp_assignments')) return [{ roleKey: 'engineer', revision: 1, reportedRevision: 1, status: reportStatus }];
    updates.push({ sql, args }); return [];
  } };
  const oldFetch = globalThis.fetch, oldUrl = process.env.WORKFLOW_ENGINE_URL, oldToken = process.env.WORKFLOW_ENGINE_TOKEN;
  process.env.WORKFLOW_ENGINE_URL = 'http://engine.invalid';
  process.env.WORKFLOW_ENGINE_TOKEN = 'x'.repeat(32);
  try {
    reportStatus = 'Blocked';
    await assert.rejects(dispatchPendingWorkflow({ database }), error => error.code === 'readiness_stale');
    assert.equal(updates.length, 0);
    reportStatus = 'Ready';
    row.assignmentBot = 'different-bot';
    await assert.rejects(dispatchPendingWorkflow({ database }), error => error.code === 'assignment_unavailable');
    assert.equal(updates.length, 0);
    row.assignmentBot = 'engineer-bot';
    globalThis.fetch = async () => { throw new Error('connection lost'); };
    await assert.rejects(dispatchPendingWorkflow({ database }));
    assert.equal(updates.length, 0);
    let request;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ workflowId: 'wrong-run', existing: false }) });
    await assert.rejects(dispatchPendingWorkflow({ database }), error => error.code === 'workflow_unavailable');
    assert.equal(updates.length, 0);
    const workflowId = 'openbot-' + createHash('sha256').update(JSON.stringify(['i', 'p', 'r'])).digest('hex');
    globalThis.fetch = async (_url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ workflowId, existing: false }) }; };
    assert.equal(await dispatchPendingWorkflow({ database }), true);
    assert.equal(request.run.planDigest, row.planDigest);
    assert.deepEqual(request.run.phaseIds, ['start']);
    assert.equal(updates.length, 2);
    row.planDigest = 'a'.repeat(64);
    await assert.rejects(dispatchPendingWorkflow({ database }), error => error.code === 'workflow_plan_invalid');
    assert.equal(updates.length, 2);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.WORKFLOW_ENGINE_URL; else process.env.WORKFLOW_ENGINE_URL = oldUrl;
    if (oldToken === undefined) delete process.env.WORKFLOW_ENGINE_TOKEN; else process.env.WORKFLOW_ENGINE_TOKEN = oldToken;
  }
});

test('dispatch holds work when the workspace source revision has changed', async () => {
  const plan = { workflow: { startPhase: 'start', phases: [{ id: 'start', action: 'build' }] }, guidance: [] };
  const row = { projectId: 'p', runId: 'r', occurrenceId: 'o', attempt: 1, installationId: 'i', phaseKey: 'start', actionId: 'build', assignmentRole: 'engineer', assignmentBot: 'engineer-bot', planDigest: contentDigest(plan), plan,
    definition: { business: { roles: [{ id: 'engineer', agentId: 'engineer-bot' }], actions: [{ id: 'build', role: 'engineer' }], initialization: { workspace: { kind: 'vm' } } } } };
  const database = { async begin(callback) { return callback(this); }, async unsafe(sql) {
    if (sql.includes('dispatch_failures=dispatch_failures+1')) return [];
    if (sql.includes('from bp_dispatch_intents')) return [row];
    if (sql.includes('for share of p,m,c,cm,ch')) return [{ id: 'p' }];
    if (sql.includes('from bp_assignments')) return [{ roleKey: 'engineer', revision: 1, reportedRevision: 1, status: 'Ready' }];
    if (sql.includes('from bp_project_vms')) return [{ providerId: 'vm', sourceRevision: 'expected', state: 'Ready' }];
    throw Error('The engine must not dispatch a stale workspace.');
  } };
  const names = ['WORKFLOW_ENGINE_URL', 'WORKFLOW_ENGINE_TOKEN', 'WORKSPACE_PROVIDER_URL', 'WORKSPACE_PROVIDER_TOKEN'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.WORKFLOW_ENGINE_URL = 'http://engine.invalid'; process.env.WORKFLOW_ENGINE_TOKEN = 'x'.repeat(32);
  process.env.WORKSPACE_PROVIDER_URL = 'http://provider.invalid'; process.env.WORKSPACE_PROVIDER_TOKEN = 'token';
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => ({ ok: true, json: async () => url.pathname === '/check' ? { id: 'vm', ready: true, isolated: true } : { hasProject: true, revision: 'stale' } });
  try { await assert.rejects(dispatchPendingWorkflow({ database }), error => error.code === 'workspace_unavailable'); }
  finally {
    globalThis.fetch = oldFetch;
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
});
