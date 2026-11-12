import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, readdir, chmod, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { captureSource } from '../dist/deploy/workspace-provider/source-import.js';
import { LimaWorkspaceProvider } from '../dist/deploy/workspace-provider/lima.js';

test('changing the source preserves guest work and reconciles a partially moved workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openbot-source-rebind-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = join(root, 'sources');
  const first = join(projects, 'first');
  const second = join(projects, 'second');
  const guest = join(root, 'guest');
  await mkdir(first, { recursive: true });
  await mkdir(second);
  await mkdir(guest);
  await writeFile(join(first, 'file.txt'), 'first');
  await writeFile(join(second, 'file.txt'), 'second');
  const binary = join(root, 'limactl');
  await writeFile(binary, '#!/bin/sh\nshift 3\nexec "$@"\n');
  await chmod(binary, 0o755);
  const originalHome = process.env.HOME;
  process.env.HOME = guest;
  try {
    const provider = new LimaWorkspaceProvider(binary, join(root, 'instances'));
    provider.prepareProject = async () => {};
    const id = provider.id('installation', 'project');
    const baseline = await provider.importSource(id, projects, first);
    assert.deepEqual(await provider.sourceStatus(id), { revision: baseline.revision, hasProject: true });
    const originalCommand = provider.command.bind(provider);
    provider.command = async () => ({ stdout: `${baseline.revision}\npresent\n\nunexpected\n`, stderr: '' });
    await assert.rejects(provider.sourceStatus(id), /source state is invalid/);
    provider.command = originalCommand;
    await writeFile(join(guest, 'project', 'file.txt'), 'guest work');
    await assert.rejects(provider.importSource(id, projects, second));
    assert.equal(await readFile(join(guest, 'project', 'file.txt'), 'utf8'), 'guest work');
    const changed = await provider.importSource(id, projects, second, { expectedRevision: baseline.revision });
    assert.equal(await readFile(join(guest, 'project', 'file.txt'), 'utf8'), 'second');
    const backups = join(guest, '.openbot', 'backups');
    const [backup] = await readdir(backups);
    assert.equal(await readFile(join(backups, backup, 'project', 'file.txt'), 'utf8'), 'guest work');
    await provider.importSource(id, projects, second, { expectedRevision: baseline.revision });
    assert.equal((await readdir(backups)).length, 1);
    // An interrupted import may leave the old project already moved aside.
    await rename(join(guest, 'project'), join(backups, 'interrupted-project'));
    assert.deepEqual(await provider.sourceStatus(id), { revision: changed.revision, hasProject: false });
    const restored = await provider.importSource(id, projects, first, { expectedRevision: changed.revision });
    assert.equal(restored.revision, baseline.revision);
    assert.equal(await readFile(join(guest, 'project', 'file.txt'), 'utf8'), 'first');
    assert.equal(await readFile(join(first, 'file.txt'), 'utf8'), 'first');
    assert.equal(await readFile(join(second, 'file.txt'), 'utf8'), 'second');
  } finally {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  }
});

test('source intake is bounded to its root and rejects symlinks without modifying source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openbot-intake-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const source = join(root,'application');
  await mkdir(source);
  await writeFile(join(source,'main.txt'),'baseline');
  const snapshot = await captureSource(root,source);
  assert.equal(snapshot.files,1);
  assert.equal(await readFile(join(source,'main.txt'),'utf8'),'baseline');
  await snapshot.cleanup();
  await symlink('/etc/passwd',join(source,'escape'));
  await assert.rejects(captureSource(root,source),/symbolic link/);
  await assert.rejects(captureSource(source,root),/outside/);
});

test('Git intake captures the committed revision while preserving uncommitted edits', async t => {
  const { execFileSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'openbot-git-intake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' }).toString().trim();
  git('init');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  await writeFile(join(root, 'source.txt'), 'committed');
  git('add', 'source.txt');
  git('commit', '-m', 'baseline');
  await writeFile(join(root, 'source.txt'), 'changed');
  const snapshot = await captureSource(root, root);
  t.after(snapshot.cleanup);
  assert.equal(snapshot.digest, git('rev-parse', 'HEAD'));
  assert.equal(snapshot.excludesUncommittedChanges, true);
  assert.equal(execFileSync('tar', ['-xOf', snapshot.archive, 'source.txt']).toString(), 'committed');
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'changed');
});

test('worktree metadata pointing outside the selected root is not followed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openbot-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, '.git'), 'gitdir: /outside/secret\n');
  await writeFile(join(project, 'source.txt'), 'working-tree content');
  const snapshot = await captureSource(root, project);
  t.after(snapshot.cleanup);
  assert.equal(snapshot.files, 1);
  assert.equal(execFileSync('tar', ['-xOf', snapshot.archive, './source.txt']).toString(), 'working-tree content');
});
