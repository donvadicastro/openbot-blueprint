import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

const workflowsPath = fileURLToPath(new URL('../dist/workflows.js', import.meta.url));
const input = runId => ({ installationId: 'installation', projectId: 'project', runId, planDigest: 'digest', initialPhase: 'start', phaseIds: ['start'] });
async function waitFor(handle, state) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const snapshot = await handle.query('snapshot').catch(() => null);
    if (snapshot?.state === state) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Workflow did not reach ${state}.`);
}

test('decision waits and uncertain effects survive worker replacement', { timeout: 120000 }, async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `blueprint-test-${randomUUID()}`;
  let effects = 0;
  let executions = 0;
  const activities = {
    async executePhase(request) {
      if (request.runId === 'wait-run') return request.decision
        ? { kind: 'complete', result: 'answered' }
        : { kind: 'wait', decisionId: 'decision-1', question: 'Choose?' };
      effects++;
      executions++;
      throw new Error('response lost after the effect');
    },
    async reconcilePhase() { return { kind: 'complete', result: 'reconciled' }; },
  };
  const makeWorker = () => Worker.create({ connection: environment.nativeConnection, taskQueue, workflowsPath, activities, maxCachedWorkflows: 0 });
  let worker = await makeWorker();
  let running = worker.run();
  try {
    const waiting = await environment.client.workflow.start('businessWorkflow', { workflowId: `wait-${randomUUID()}`, taskQueue, args: [input('wait-run')] });
    const uncertain = await environment.client.workflow.start('businessWorkflow', { workflowId: `effect-${randomUUID()}`, taskQueue, args: [input('effect-run')] });
    await waitFor(waiting, 'waiting');
    await waitFor(uncertain, 'uncertain');
    worker.shutdown();
    await running;
    // Both messages arrive while no worker is available.
    await waiting.signal('answerDecision', 'decision-1', 'yes');
    await uncertain.signal('reconcileUncertain');
    worker = await makeWorker();
    running = worker.run();
    const bounded = async promise => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Workflow result timed out.')), 10000); })]); }
      finally { clearTimeout(timer); }
    };
    assert.equal((await bounded(waiting.result())).result, 'answered');
    assert.equal((await bounded(uncertain.result())).result, 'reconciled');
    assert.equal(effects, 1);
    assert.equal(executions, 1);
  } finally {
    worker.shutdown();
    await running;
    await environment.teardown();
  }
});
