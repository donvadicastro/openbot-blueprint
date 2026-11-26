import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'openbot-qa-progress-'));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'), '--outDir', directory, resolve('deploy/openbot/product/qa-progress.ts')]);
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { nextQaScenarioStatus } = await import(pathToFileURL(join(directory, 'qa-progress.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('scenario progress has explicit, monotonic states and idempotent repeats', () => {
  assert.equal(nextQaScenarioStatus(undefined, 'queued'), true);
  assert.equal(nextQaScenarioStatus(undefined, 'passed'), false);
  assert.equal(nextQaScenarioStatus('queued', 'running'), true);
  assert.equal(nextQaScenarioStatus('queued', 'blocked'), true);
  assert.equal(nextQaScenarioStatus('running', 'passed'), true);
  assert.equal(nextQaScenarioStatus('running', 'failed'), true);
  assert.equal(nextQaScenarioStatus('running', 'running'), true);
  assert.equal(nextQaScenarioStatus('passed', 'failed'), false);
  assert.equal(nextQaScenarioStatus('blocked', 'running'), false);
});
