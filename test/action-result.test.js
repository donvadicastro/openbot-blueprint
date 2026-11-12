import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'openbot-action-test-'));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'), '--outDir', directory, resolve('deploy/openbot/product/actions.ts')]);
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { validateActionResult } = await import(pathToFileURL(join(directory, 'actions.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('action results must match the active attempt and authorized output contracts', () => {
  const action = { id: 'verify', outputTypes: ['qa-evidence'], results: [{ status: 'succeeded', requiredOutputTypes: ['qa-evidence'], requiredEvidence: ['result'] }] };
  const binding = { projectId: 'p', runId: 'r', occurrenceId: 'o', assignmentId: 'a', actionId: 'verify', attempt: 1, runRevision: 2 };
  const result = { ...binding, status: 'succeeded', outputs: [{ type: 'qa-evidence', revisionId: 'v1' }], evidence: { result: 'report' } };
  const check = value => validateActionResult(action, binding, value, new Map([['v1', 'qa-evidence']]), new Set(['report']));
  assert.equal(check(result).status, 'succeeded');
  assert.throws(() => check({ ...result, runRevision: 1 }), error => error.code === 'stale_action_result');
  assert.throws(() => check({ ...result, assignmentId: 'other' }), error => error.code === 'stale_action_result');
  assert.throws(() => check({ ...result, outputs: [{ type: 'qa-evidence', revisionId: 'other' }] }), /unauthorized/);
  assert.throws(() => check({ ...result, outputs: [] }), /missing/);
  assert.throws(() => check({ ...result, evidence: {} }), /missing/);
  assert.throws(() => check({ ...result, evidence: { result: 'unauthorized' } }), /authorized/);
});
