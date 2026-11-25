import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'openbot-dispatch-scheduler-'));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'), '--outDir', directory, resolve('deploy/openbot/product/dispatch-scheduler.ts')]);
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { createDispatchScheduler } = await import(pathToFileURL(join(directory, 'dispatch-scheduler.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('scheduler serializes ticks and respects the batch limit', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const scheduler = createDispatchScheduler({}, { batchSize: 2, dispatch: async () => { calls++; if (calls === 1) await gate; return true; } });
  const first = scheduler.tick(), second = scheduler.tick();
  assert.equal(first, second);
  release();
  assert.equal(await first, 2);
  assert.equal(calls, 2);
  await scheduler.stop();
});

test('a failed dispatch can be retried on a subsequent tick', async () => {
  let calls = 0;
  const scheduler = createDispatchScheduler({}, { dispatch: async () => { if (++calls === 1) throw Error('unavailable'); return false; } });
  await assert.rejects(scheduler.tick(), /unavailable/);
  assert.equal(await scheduler.tick(), 0);
  assert.equal(calls, 2);
});
