import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'openbot-action-test-'));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'), '--outDir', directory, resolve('deploy/openbot/product/actions.ts')]);
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { validateActionResult, selectActionTransition } = await import(pathToFileURL(join(directory, 'actions.js')).href);
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

test('transition selection honors QA verdict and a human shipping decision', () => {
  const workflow = { phases: ['verify', 'implement', 'verified', 'release'].map(id => ({ id })), transitions: [
    { from: 'verify', to: 'implement', when: { status: 'succeeded', recordType: 'qa', field: 'verdict', equals: 'failed' } },
    { from: 'verify', to: 'verified', when: { status: 'succeeded', recordType: 'qa', field: 'verdict', equals: 'passed', decision: 'verify-only' } },
    { from: 'verify', to: 'release', when: { status: 'succeeded', recordType: 'qa', field: 'verdict', equals: 'passed', decision: 'ship' } },
  ] };
  assert.equal(selectActionTransition(workflow, 'verify', 'succeeded', new Map([['qa', { verdict: 'failed' }]]), 'ship'), 'implement');
  assert.equal(selectActionTransition(workflow, 'verify', 'succeeded', new Map([['qa', { verdict: 'passed' }]])), null);
  assert.equal(selectActionTransition(workflow, 'verify', 'succeeded', new Map([['qa', { verdict: 'passed' }]]), 'ship'), 'release');
  assert.equal(selectActionTransition(workflow, 'verify', 'succeeded', new Map([['qa', { verdict: 'pending' }]]), 'ship'), null);
  assert.throws(() => selectActionTransition({ ...workflow, transitions: [...workflow.transitions, workflow.transitions[2]] }, 'verify', 'succeeded', new Map([['qa', { verdict: 'passed' }]]), 'ship'), error => error.code === 'workflow_plan_invalid');
});

test('a needs-input result must ask one bounded question before producing output', () => {
  const action = { id: 'discover', outputTypes: ['brief'], results: [{ status: 'needs-input', requiredOutputTypes: [], requiredEvidence: [] }] };
  const binding = { projectId: 'p', runId: 'r', occurrenceId: 'o', assignmentId: 'a', actionId: 'discover', attempt: 1, runRevision: 2 };
  const result = { ...binding, status: 'needs-input', question: 'Which audience should this serve?', outputs: [], evidence: {} };
  assert.equal(validateActionResult(action, binding, result, new Map(), new Set()).status, 'needs-input');
  assert.throws(() => validateActionResult(action, binding, { ...result, question: ' ' }, new Map(), new Set()), /clarification/);
  assert.throws(() => validateActionResult(action, binding, { ...result, outputs: [{ type: 'brief', revisionId: 'v1' }] }, new Map([['v1', 'brief']]), new Set()), /clarification/);
});

test('failure reasons are bounded and only accepted for failed or blocked outcomes', () => {
  const action = { id: 'discover', outputTypes: [], results: [
    { status: 'failed', requiredOutputTypes: [], requiredEvidence: [] },
    { status: 'succeeded', requiredOutputTypes: [], requiredEvidence: [] },
  ] };
  const binding = { projectId: 'p', runId: 'r', occurrenceId: 'o', assignmentId: 'a', actionId: 'discover', attempt: 1, runRevision: 2 };
  const result = { ...binding, status: 'failed', reason: 'The service did not respond.', outputs: [], evidence: {} };
  const check = value => validateActionResult(action, binding, value, new Map(), new Set());
  assert.equal(check(result).status, 'failed');
  assert.throws(() => check({ ...result, reason: ' ' }), /failure reason/i);
  assert.throws(() => check({ ...result, reason: 'x'.repeat(4001) }), /failure reason/i);
  assert.throws(() => check({ ...result, status: 'succeeded' }), /failure reason/i);
});

test('the SWE blueprint sends failed QA to rework and a shipping request to release preparation', async () => {
  const workflows = JSON.parse(await readFile('blueprints/software-development/workflows.json', 'utf8'));
  const workflow = workflows.find(item => item.id === 'feature-development');
  assert.equal(selectActionTransition(workflow, 'verify', 'succeeded', new Map([['qa-evidence', { verdict: 'failed' }]]), 'ship'), 'implement');
  assert.equal(selectActionTransition(workflow, 'verify', 'succeeded', new Map([['qa-evidence', { verdict: 'passed' }]]), 'ship'), 'prepare-release');
  assert.equal(selectActionTransition(workflow, 'verify', 'succeeded', new Map([['qa-evidence', { verdict: 'passed' }]])), null);
});


test('an action cannot return competing revisions of the same output type', () => {
  const action = { id: 'produce', outputTypes: ['brief'], results: [{ status: 'succeeded', requiredOutputTypes: ['brief'], requiredEvidence: [] }] };
  const binding = { projectId: 'p', runId: 'r', occurrenceId: 'o', assignmentId: 'a', actionId: 'produce', attempt: 1, runRevision: 1 };
  const result = { ...binding, status: 'succeeded', outputs: [{type:'brief',revisionId:'v1'},{type:'brief',revisionId:'v2'}], evidence: {} };
  assert.throws(() => validateActionResult(action, binding, result, new Map([['v1','brief'],['v2','brief']]), new Set()), /duplicated/);
});
