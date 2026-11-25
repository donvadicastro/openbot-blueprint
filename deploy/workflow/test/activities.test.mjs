import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivities } from '../dist/activities.js';

test('the activity adapter uses its configured private endpoint and validates outcomes', async () => {
  assert.throws(() => createActivities('http://user:secret@example.invalid', 'x'.repeat(32)));
  assert.throws(() => createActivities('http://service', 'short'));
  const savedFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url: url.href, options });
      return { ok: true, json: async () => ({ kind: 'not-started' }) };
    };
    const activities = createActivities('http://private-service:3001', 'x'.repeat(32));
    const request = { installationId: 'i', projectId: 'p', runId: 'r', planDigest: 'digest', phase: 'start', occurrence: 1, operationKey: 'r:1' };
    assert.deepEqual(await activities.reconcilePhase(request), { kind: 'not-started' });
    assert.equal(calls[0].url, 'http://private-service:3001/internal/workflow-activities/reconcile');
    assert.equal(calls[0].options.redirect, 'error');
    await assert.rejects(activities.executePhase(request), /Invalid/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ kind: 'advance', nextPhase: 'start', delaySeconds: 2 }) });
    assert.deepEqual(await activities.executePhase(request), { kind: 'advance', nextPhase: 'start', delaySeconds: 2 });
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ kind: 'advance', nextPhase: 'start', delaySeconds: -1 }) });
    await assert.rejects(activities.executePhase(request), /Invalid/);
    globalThis.fetch = async () => ({ ok: false });
    await assert.rejects(activities.reconcilePhase(request), /not confirmed/);
  } finally { globalThis.fetch = savedFetch; }
});
