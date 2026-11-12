import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'openbot-qa-test-'));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'), '--outDir', directory, resolve('deploy/openbot/product/qa.ts')]);
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { validateQaReport } = await import(pathToFileURL(join(directory, 'qa.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('QA results cover exact scenarios and compute verdicts with the full denominator', () => {
  const plan = { candidateRevision: 'candidate', briefRevision: 'brief', environment: 'test', scenarios: [
    { id: 'one', steps: ['do it'], expected: 'works' }, { id: 'two', steps: ['try again'], expected: 'works' },
  ] };
  const report = { candidateRevision: 'candidate', briefRevision: 'brief', planRevision: 'plan', environment: 'test', verdict: 'pending', passPercentage: 50,
    results: [{ id: 'one', status: 'passed', observed: 'worked', evidence: ['log'] }, { id: 'two', status: 'blocked', reason: 'offline' }] };
  const check = value => validateQaReport(plan, 'plan', ['one', 'two'], value, new Set(['log']));
  assert.deepEqual(check(report), { verdict: 'pending', passed: 1, failed: 0, pending: 1, total: 2, passPercentage: 50 });
  assert.throws(() => check({ ...report, verdict: 'passed' }), /verdict/);
  assert.throws(() => check({ ...report, candidateRevision: 'old' }), /does not match/);
  assert.throws(() => check({ ...report, results: [report.results[0], report.results[0]] }), /exactly one/);
  assert.throws(() => check({ ...report, results: [{ ...report.results[0], evidence: ['secret'] }, report.results[1]] }), /unauthorized/);
  const failed = { ...report, verdict: 'failed', results: [report.results[0], { id: 'two', status: 'failed', observed: 'broken' }] };
  assert.equal(check(failed).verdict, 'failed');
  const passed = { ...report, verdict: 'passed', passPercentage: 100, results: [report.results[0], { id: 'two', status: 'passed', observed: 'worked' }] };
  assert.equal(check(passed).verdict, 'passed');
});
