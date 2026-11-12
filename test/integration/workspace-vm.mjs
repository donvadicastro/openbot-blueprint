import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { LimaWorkspaceProvider } from '../../dist/deploy/workspace-provider/lima.js';

const exec = promisify(execFile);
const root = await mkdtemp('/tmp/ob-');
const binary = process.env.LIMACTL_PATH ?? 'limactl';
process.env.LIMA_HOME = join(root, 'lima');
const provider = new LimaWorkspaceProvider(binary, process.env.LIMA_HOME);
const id = provider.id('fixture', 'recovery');
try {
  const blueprint = JSON.parse(await readFile(new URL('../../blueprints/software-development/blueprint.json', import.meta.url), 'utf8'));
  await provider.ensure('fixture', 'recovery', blueprint.business.initialization.workspace);
  const sourceA = join(root, 'source-a');
  const sourceB = join(root, 'source-b');
  await mkdir(sourceA);
  await mkdir(sourceB);
  await writeFile(join(sourceA, 'input'), 'source-a');
  await writeFile(join(sourceB, 'input'), 'source-b');
  console.log('Importing the initial source.');
  const imported = await provider.importSource(id, root, sourceA);
  const originalStatus = await provider.sourceStatus(id);
  if (originalStatus.revision !== imported.revision || !originalStatus.hasProject) throw new Error('Original source state was not available.');
  await provider.command(['shell', id, '--', 'sudo', '-n', 'ip', '-n', 'openbot-project', 'route', 'add', '192.0.2.0/24', 'dev', 'lo']);
  try {
    const untrusted = await provider.check(id);
    if (untrusted.isolated !== false) throw new Error('A modified project network was accepted.');
    let refused = false;
    try { await provider.runAction(id, 'blocked-isolation', ['true']); } catch { refused = true; }
    if (!refused) throw new Error('An action ran with a modified project network.');
  } finally {
    await provider.command(['shell', id, '--', 'sudo', '-n', 'ip', '-n', 'openbot-project', 'route', 'del', '192.0.2.0/24', 'dev', 'lo']);
  }
  const isolation = await provider.runAction(id, 'isolation-check', ['python3', '-c', `
import errno, os, socket, subprocess
assert os.geteuid() >= 1000
assert not os.path.exists('/run/dbus/system_bus_socket')
assert not os.path.exists('/proc/1/root/run/dbus/system_bus_socket')
assert subprocess.run(['sudo', '-n', 'true'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0
for family, target in [(socket.AF_INET, ('192.0.2.1', 9)), (socket.AF_INET6, ('2001:db8::1', 9))]:
    probe = socket.socket(family, socket.SOCK_STREAM)
    probe.settimeout(2)
    assert probe.connect_ex(target) == errno.ENETUNREACH
    probe.close()
server = socket.socket()
server.bind(('127.0.0.1', 0))
server.listen(1)
client = socket.create_connection(server.getsockname(), timeout=2)
connection, _ = server.accept()
connection.close(); client.close(); server.close()
`]);
  if (isolation.status !== 'completed' || isolation.exitCode !== 0) throw new Error('The project user or private network checks failed.');
  const original = provider.command.bind(provider);
  let interrupted = false;
  provider.command = async args => {
    const result = await original(args);
    if (!interrupted && args.includes('openbot-action')) { interrupted = true; throw new Error('simulated lost response'); }
    return result;
  };
  const argv = ['sh', '-c', 'printf x >> fixture; printf done'];
  const first = await provider.runAction(id, 'probe', argv);
  const recovered = await provider.reconcileAction(id, 'probe');
  const retry = await provider.runAction(id, 'probe', argv);
  const contents = await original(['shell', id, '--', 'sh', '-c', 'cat "$HOME/project/fixture"']);
  if (first.status !== 'uncertain' || recovered.status !== 'completed' || recovered.stdout !== 'done' || retry.status !== 'completed' || contents.stdout !== 'x') throw new Error('Recovery probe failed.');
  await provider.command(process.env.OPENBOT_TEST_FORCE_STOP === '1' ? ['stop', '--force', id] : ['stop', id]);
  const restarted = await provider.ensure('fixture', 'recovery', blueprint.business.initialization.workspace);
  if (!restarted.ready || restarted.id !== id) throw new Error('The same VM did not return after restart.');
  const persisted = await provider.runAction(id, 'probe', argv);
  const afterRestart = await original(['shell', id, '--', 'sh', '-c', 'cat "$HOME/project/fixture"']);
  if (persisted.status !== 'completed' || afterRestart.stdout !== 'x') throw new Error('The workspace or action receipt did not survive restart.');
  console.log('Replacing the source while retaining the previous workspace.');
  const replacement = await provider.importSource(id, root, sourceB, { expectedRevision: imported.revision });
  const replacementStatus = await provider.sourceStatus(id);
  if (replacementStatus.revision !== replacement.revision || !replacementStatus.hasProject) throw new Error('Replacement source state was not available.');
  const state = await original(['shell', id, '--', 'sh', '-c', 'printf "%s|" "$(cat "$HOME/project/input")"; find "$HOME/.openbot/backups" -name fixture -exec cat {} \\;']);
  if (state.stdout !== 'source-b|x') throw new Error('Source replacement did not preserve guest work.');
  console.log('Real VM: recovered one effect, persisted it across restart, and preserved guest work when replacing the source.');
} finally {
  await exec(binary, ['stop', '--force', id], { timeout: 60000 }).catch(() => {});
  await exec(binary, ['delete', '--force', id], { timeout: 60000 }).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
