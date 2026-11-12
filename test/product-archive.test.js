import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'openbot-archive-test-'));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'), '--outDir', directory, resolve('deploy/openbot/product/archive.ts')], { stdio: 'pipe' });
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { archiveProject } = await import(pathToFileURL(join(directory, 'archive.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('archive requires management access, is repeatable, and preserves project history', async () => {
  const project = { id: 'p', state: 'Operational', revision: 1, permissions: ['read', 'manage'] };
  const statements = [];
  const database = { async begin(callback) { return callback(this); }, async unsafe(sql) {
    statements.push(sql);
    if (sql.includes('join bp_memberships')) return [{ ...project }];
    if (sql.includes('update bp_projects')) { project.state = 'Archived'; project.revision++; }
    return [];
  } };
  const actor = { id: 'owner', role: 'user' };
  assert.equal((await archiveProject({ database }, actor, 'p')).state, 'Archived');
  assert.equal((await archiveProject({ database }, actor, 'p')).revision, 2);
  assert.equal(statements.filter(sql => sql.includes('update bp_projects')).length, 1);
  assert.ok(statements.every(sql => !/\bdelete\b/i.test(sql)));
  project.permissions = ['read'];
  await assert.rejects(archiveProject({ database }, actor, 'p'), error => error.code === 'project_permission_denied');
});
