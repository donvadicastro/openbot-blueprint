import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { workflowGateway } from '../dist/gateway.js';

test('private gateway binds run identity and deduplicates starts', { timeout: 120000 }, async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `gateway-test-${randomUUID()}`;
  const worker = await Worker.create({ connection: environment.nativeConnection, taskQueue, maxCachedWorkflows: 0,
    workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
    activities: { async executePhase(request) { return request.runId === 'uncertain-run' ? { kind: 'uncertain', reason: 'response lost' } : request.decision ? { kind: 'complete', result: 'done' } : { kind: 'wait', decisionId: 'decision', question: 'Continue?' }; }, async reconcilePhase(request) { return request.runId === 'uncertain-run' ? { kind: 'complete', result: 'reconciled' } : { kind: 'uncertain', reason: 'unknown' }; } } });
  const running = worker.run();
  const token = 'x'.repeat(32);
  const gateway = workflowGateway(environment.client.workflow, token, taskQueue);
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${gateway.address().port}`;
  const run = { installationId: 'install', projectId: 'project', runId: 'run', planDigest: 'a'.repeat(64), initialPhase: 'start', phaseIds: ['start'] };
  async function post(path, body, authorization = `Bearer ${token}`) {
    const response = await fetch(url + path, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  try {
    assert.equal((await post('/start', { run }, 'wrong')).status, 401);
    assert.equal((await post('/start', { run })).status, 201);
    assert.equal((await post('/start', { run })).body.existing, true);
    assert.equal((await post('/start', { run: { ...run, planDigest: 'b'.repeat(64) } })).status, 409);
    let status;
    for (let i = 0; i < 100; i++) {
      status = await post('/status', { run });
      if (status.body.snapshot?.state === 'waiting') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(status.body.snapshot.state, 'waiting');
    assert.equal((await post('/decision', { run, decisionId: 'wrong', value: 'yes' })).status, 409);
    assert.equal((await post('/decision', { run, decisionId: 'decision', value: 'yes' })).status, 202);
    for (let i = 0; i < 100; i++) {
      status = await post('/status', { run });
      if (status.body.snapshot?.state === 'complete') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(status.body.snapshot.state, 'complete');
    assert.equal((await post('/decision', { run, decisionId: 'decision', value: 'yes' })).status, 202);
    assert.equal((await post('/decision', { run, decisionId: 'decision', value: 'no' })).status, 409);
    const uncertain = { ...run, runId: 'uncertain-run' };
    assert.equal((await post('/start', { run: uncertain })).status, 201);
    for (let i = 0; i < 100; i++) {
      status = await post('/status', { run: uncertain });
      if (status.body.snapshot?.state === 'uncertain') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(status.body.snapshot.state, 'uncertain');
    assert.equal((await post('/decision', { run: uncertain, decisionId: 'decision', value: 'yes' })).status, 202);
    for (let i = 0; i < 100; i++) {
      status = await post('/status', { run: uncertain });
      if (status.body.snapshot?.state === 'complete') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(status.body.snapshot.result, 'reconciled');
  } finally {
    await new Promise(resolve => gateway.close(resolve));
    worker.shutdown(); await running; await environment.teardown();
  }
});
