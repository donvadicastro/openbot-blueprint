import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'openbot-staging-test-'));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--outDir', directory, resolve('deploy/openbot/product/staging-target.ts')]);
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { createStagingTarget } = await import(pathToFileURL(join(directory, 'staging-target.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('staging lookup reconciles a lost response and refuses mismatched receipts', async () => {
  const originalFetch = globalThis.fetch;
  const operation = { operationId: 'one', projectId: 'project', candidateDigest: 'candidate', target: 'test-staging' };
  let committed = 0, saved;
  try {
    globalThis.fetch = async (url, request) => {
      assert.equal(request.headers.authorization, `Bearer ${'x'.repeat(32)}`);
      const body = JSON.parse(request.body);
      if (url.pathname.endsWith('/deploy')) { committed++; saved = { ...body, receiptId: 'receipt' }; throw new Error('lost response'); }
      return { ok: true, json: async () => ({ status: 'confirmed', receipt: saved }) };
    };
    const target = createStagingTarget('http://staging.internal', 'x'.repeat(32));
    assert.deepEqual(await target.deploy(operation), { status: 'uncertain' });
    assert.deepEqual(await target.lookup(operation), { status: 'confirmed', receipt: saved });
    assert.equal(committed, 1);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'verified', verification: { ...saved, verificationId: 'check' } }) });
    assert.deepEqual(await target.verify(saved), { status: 'verified', verificationId: 'check', receipt: saved });
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'verified', verification: { ...saved, target: 'other', verificationId: 'check' } }) });
    assert.deepEqual(await target.verify(saved), { status: 'uncertain' });
    saved = { ...saved, projectId: 'another-project' };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'confirmed', receipt: saved }) });
    assert.deepEqual(await target.lookup(operation), { status: 'uncertain' });
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'not-found', ...operation }) });
    assert.deepEqual(await target.lookup(operation), { status: 'not-found' });
    assert.deepEqual(await target.deploy(operation), { status: 'uncertain' });
  } finally { globalThis.fetch = originalFetch; }
});

