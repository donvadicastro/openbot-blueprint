import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'openbot-engine-test-'));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'), '--outDir', directory, resolve('deploy/openbot/product/workflow-engine.ts')], { stdio: 'pipe' });
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { dispatchPendingWorkflow } = await import(pathToFileURL(join(directory, 'workflow-engine.js')).href);
const { contentDigest } = await import(pathToFileURL(join(directory, 'store.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('dispatch pins the plan and leaves an ambiguous start pending for retry', async () => {
  const plan = { workflow: { startPhase: 'start', phases: [{ id: 'start' }] }, guidance: [] };
  const row = { projectId: 'p', runId: 'r', occurrenceId: 'o', attempt: 1, installationId: 'i', planDigest: contentDigest(plan), plan,
    definition: { business: { roles: [{ id: 'engineer' }], initialization: { workspace: { kind: 'none' } } } } };
  const updates = [];
  let reportStatus = 'Ready';
  const database = { async begin(callback) { return callback(this); }, async unsafe(sql, args) {
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
    globalThis.fetch = async () => { throw new Error('connection lost'); };
    await assert.rejects(dispatchPendingWorkflow({ database }));
    assert.equal(updates.length, 0);
    let request;
    globalThis.fetch = async (_url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ workflowId: 'stable', existing: false }) }; };
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
