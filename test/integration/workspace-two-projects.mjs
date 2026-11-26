import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { LimaWorkspaceProvider } from '../../dist/deploy/workspace-provider/lima.js';

// Two disposable projects import the same host folder into independent guests.
const exec = promisify(execFile);
const root = await mkdtemp('/tmp/ob-pair-');
const binary = process.env.LIMACTL_PATH ?? 'limactl';
process.env.LIMA_HOME = join(root, 'lima');
const provider = new LimaWorkspaceProvider(binary, process.env.LIMA_HOME);
const ids = ['first', 'second'].map(project => provider.id('fixture', project));
try {
  const blueprint = JSON.parse(await readFile(new URL('../../blueprints/software-development/blueprint.json', import.meta.url), 'utf8'));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'input'), 'original');
  for (const project of ['first', 'second']) await provider.ensure('fixture', project, blueprint.business.initialization.workspace);
  if (ids[0] === ids[1]) throw Error('Project VM identities collided.');
  for (const id of ids) await provider.importSource(id, root, source);
  const changed = await provider.runAction(ids[0], 'edit', ['sh', '-c', 'printf changed > input && printf built > build-output']);
  if (changed.status !== 'completed' || changed.exitCode !== 0) throw Error('First project could not edit its workspace.');
  const untouched = await provider.runAction(ids[1], 'check', ['sh', '-c', 'test "$(cat input)" = original && test ! -e build-output']);
  if (untouched.status !== 'completed' || untouched.exitCode !== 0 || await readFile(join(source, 'input'), 'utf8') !== 'original') throw Error('Project edit affected another guest or the host source.');
  await exec(binary, ['stop', '--force', ids[0]], { timeout: 60000 });
  const restarted = await provider.ensure('fixture', 'first', blueprint.business.initialization.workspace);
  if (!restarted.ready || restarted.id !== ids[0]) throw Error('First project did not recover the same VM.');
  const persisted = await provider.runAction(ids[0], 'after-restart', ['sh', '-c', 'test "$(cat input)" = changed && test "$(cat build-output)" = built']);
  const secondStillReady = await provider.runAction(ids[1], 'after-neighbor-restart', ['sh', '-c', 'test "$(cat input)" = original && test ! -e build-output']);
  if (persisted.status !== 'completed' || persisted.exitCode !== 0 || secondStillReady.status !== 'completed' || secondStillReady.exitCode !== 0) throw Error('Project restart did not preserve isolation and workspace state.');
  console.log('Two projects imported the same folder into separate persistent VMs without modifying each other or the host.');
} finally {
  for (const id of ids) {
    await exec(binary, ['stop', '--force', id], { timeout: 60000 }).catch(() => {});
    await exec(binary, ['delete', '--force', id], { timeout: 60000 }).catch(() => {});
  }
  await rm(root, { recursive: true, force: true });
}
