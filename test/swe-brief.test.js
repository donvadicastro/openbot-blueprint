import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'openbot-swe-brief-'));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'), '--outDir', directory, resolve('deploy/openbot/product/swe-brief.ts')]);
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { requireChangeBrief } = await import(pathToFileURL(join(directory, 'swe-brief.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('change briefs require distinct, meaningful acceptance scenarios', () => {
  const brief = { scope: 'Add search', scenarios: [{ id: 'found', expected: 'Shows a match' }, { id: 'empty', expected: 'Shows an empty state' }] };
  assert.doesNotThrow(() => requireChangeBrief(brief));
  for (const invalid of [
    { ...brief, scope: '  ' },
    { ...brief, scenarios: [brief.scenarios[0], brief.scenarios[0]] },
    { ...brief, scenarios: [{ id: '', expected: 'Shows a match' }] },
    { ...brief, scenarios: [{ id: 'found', expected: ' ' }] },
  ]) assert.throws(() => requireChangeBrief(invalid), error => error.code === 'invalid_change_brief');
});
