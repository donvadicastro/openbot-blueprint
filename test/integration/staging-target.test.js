import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stagingFixture } from '../fixtures/staging-target.mjs';

test('the disposable staging target persists one effect when a receipt is lost', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openbot-staging-integration-'));
  execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--outDir', directory, resolve('deploy/openbot/product/staging-target.ts')]);
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  const { createStagingTarget } = await import(pathToFileURL(join(directory, 'staging-target.js')).href);
  const token = 's'.repeat(32);
  const operation = { operationId: 'operation-1', projectId: 'project-1', candidateDigest: 'sha256:abc', target: 'staging' };
  let fixture = stagingFixture(join(directory, 'staging.sqlite'), token, { dropFirstReceipt: true });
  await new Promise((resolve, reject) => fixture.server.once('error', reject).listen(0, '127.0.0.1', resolve));
  let target = createStagingTarget(`http://127.0.0.1:${fixture.server.address().port}`, token);
  try {
    assert.deepEqual(await target.lookup(operation), { status: 'not-found' });
    assert.deepEqual(await target.deploy(operation), { status: 'uncertain' });
    assert.equal(fixture.count(), 1);
    await new Promise(resolve => fixture.server.close(resolve));
    fixture.close();
    fixture = stagingFixture(join(directory, 'staging.sqlite'), token);
    await new Promise((resolve, reject) => fixture.server.once('error', reject).listen(0, '127.0.0.1', resolve));
    target = createStagingTarget(`http://127.0.0.1:${fixture.server.address().port}`, token);
    assert.equal((await target.lookup(operation)).status, 'confirmed');
    assert.equal((await target.lookup({ ...operation, projectId: 'other' })).status, 'uncertain');
    assert.equal(fixture.count(), 1);
  } finally {
    await new Promise(resolve => fixture.server.close(resolve));
    fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
