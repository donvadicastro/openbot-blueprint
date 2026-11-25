import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LimaWorkspaceProvider } from '../../dist/deploy/workspace-provider/lima.js';
import { workspaceServer } from '../../dist/deploy/workspace-provider/server.js';

// Disposable VM provider used only by the combined restore fixture.
const [directory, installationId, projectId] = process.argv.slice(2);
if (!directory?.startsWith('/tmp/obrestore.') || !installationId || !projectId) throw Error('Disposable restore binding required.');
const binary = process.env.LIMACTL_PATH ?? 'limactl';
const token = 'restore-fixture-provider-token-0123456789';
const exec = promisify(execFile);
process.env.LIMA_HOME = join(directory, 'lima');
const provider = new LimaWorkspaceProvider(binary, process.env.LIMA_HOME);
const id = provider.id(installationId, projectId);
let server;
let closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  if (server) await new Promise(resolve => server.close(resolve));
  await exec(binary, ['stop', '--force', id], { timeout: 60000 }).catch(() => {});
  await exec(binary, ['delete', '--force', id], { timeout: 60000 }).catch(() => {});
}
process.on('SIGTERM', () => { void cleanup().finally(() => process.exit(0)); });
process.on('SIGINT', () => { void cleanup().finally(() => process.exit(0)); });
try {
  const definition = JSON.parse(await readFile(new URL('../../blueprints/software-development/blueprint.json', import.meta.url), 'utf8'));
  const source = join(directory, 'source');
  await mkdir(source);
  await writeFile(join(source, 'fixture'), 'source');
  await provider.ensure(installationId, projectId, definition.business.initialization.workspace);
  const imported = await provider.importSource(id, directory, source);
  const original = provider.command.bind(provider);
  let lost = false;
  provider.command = async args => {
    const result = await original(args);
    if (!lost && args.includes('openbot-action')) { lost = true; throw Error('fixture lost response'); }
    return result;
  };
  const argv = ['sh', '-c', 'printf y >> before-backup; printf saved'];
  if ((await provider.runAction(id, 'backup-uncertain', argv)).status !== 'uncertain') throw Error('The fixture did not retain an uncertain action.');
  await original(['stop', '--force', id]);
  const vm = join(directory, 'lima', id), actions = join(directory, '.openbot-vm-state'), backup = join(directory, 'backup');
  await mkdir(backup);
  const copy = process.platform === 'darwin' ? ['-cR'] : ['-a', '--reflink=auto', '--sparse=always'];
  await exec('cp', [...copy, vm, join(backup, 'vm')], { timeout: 240000 });
  await exec('cp', [...copy, actions, join(backup, 'actions')], { timeout: 240000 });
  await rm(vm, { recursive: true, force: true });
  await rm(actions, { recursive: true, force: true });
  await exec('cp', [...copy, join(backup, 'vm'), vm], { timeout: 240000 });
  await exec('cp', [...copy, join(backup, 'actions'), actions], { timeout: 240000 });
  provider.command = original;
  if (!(await provider.ensure(installationId, projectId, definition.business.initialization.workspace)).ready) throw Error('Restored VM was not ready.');
  const homeId = createHash('sha256').update(process.env.LIMA_HOME).digest('hex').slice(0, 16);
  const receipt = createHash('sha256').update('backup-uncertain').digest('hex');
  const pending = JSON.parse(await readFile(join(directory, '.openbot-vm-state', homeId, id, `${receipt}.json`), 'utf8'));
  if (pending.status !== 'running') throw Error('Restored uncertain operation was not held for reconciliation.');
  const recovered = await provider.reconcileAction(id, 'backup-uncertain');
  const replayed = await provider.runAction(id, 'backup-uncertain', argv);
  const marker = await original(['shell', id, '--', 'sh', '-c', 'cat "$HOME/project/before-backup"']);
  if (recovered.status !== 'completed' || replayed.status !== 'completed' || marker.stdout !== 'y') throw Error('Restored uncertain operation was repeated or not reconciled.');
  server = workspaceServer({ token, installationId, sourceRoot: directory, provider });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await writeFile(join(directory, 'provider.json'), JSON.stringify({ id, revision: imported.revision, port: server.address().port }), { mode: 0o600 });
} catch (error) {
  await cleanup();
  throw error;
}
