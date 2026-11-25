import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { LimaWorkspaceProvider } from '../../dist/deploy/workspace-provider/lima.js';
import { prepareDependencyAuthority } from '../../dist/deploy/workspace-provider/dependency-authority.js';

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
  if (process.env.OPENBOT_TEST_DEPENDENCY_TRUST === '1') {
    const authority = await prepareDependencyAuthority(join(root, 'dependency-authority'), { destinations: [{ hostname: 'packages.example.org', port: 443 }] });
    const installed = await provider.installDependencyAuthority(id, authority.caCertificate);
    if (!installed.installed) throw new Error('Disposable guest did not install its public dependency authority.');
    const trust = await provider.runAction(id, 'dependency-trust-check', ['sh', '-c', `
set -eu
test -r /usr/local/share/ca-certificates/openbot-project-egress.crt
test ! -e /usr/local/share/ca-certificates/openbot-project-egress.key
if (printf altered >> /usr/local/share/ca-certificates/openbot-project-egress.crt) 2>/dev/null; then exit 1; fi
openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt /usr/local/share/ca-certificates/openbot-project-egress.crt >/dev/null
`]);
    if (trust.status !== 'completed' || trust.exitCode !== 0) throw new Error('Guest dependency trust was not protected or usable.');
    console.log('Installed only the public dependency CA in the disposable guest; project commands cannot alter it.');
  }
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
  const seed = await provider.runAction(id, 'qa-seed', ['sh', '-c', 'git init -q && git config user.email fixture@example.invalid && git config user.name fixture && git add input && git commit -qm fixture && git rev-parse HEAD']);
  const candidate = seed.stdout.trim();
  if (seed.status !== 'completed' || seed.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(candidate)) throw new Error('Could not prepare the disposable QA candidate.');
  const dirty = await provider.runAction(id, 'qa-dirty-workspace', ['sh', '-c', 'printf dirty > input']);
  if (dirty.status !== 'completed' || dirty.exitCode !== 0) throw new Error('Could not prepare the changed workspace fixture.');
  const qa = await provider.runAction(id, 'qa-isolation', ['sh', '-c', `
set -eu
test "$(cat /work/input)" = source-a
test ! -e /home
test ! -e /proc/1/root/home
if touch /work/qa-mutation 2>/dev/null; then exit 1; fi
if touch /usr/qa-mutation 2>/dev/null; then exit 1; fi
if (echo changed > /proc/sys/kernel/hostname) 2>/dev/null; then exit 1; fi
if sudo -n true >/dev/null 2>&1; then exit 1; fi
if unshare -Ur -m sh -c 'mount -o remount,rw /work && touch /work/escape' >/dev/null 2>&1; then exit 1; fi
python3 -c 'import errno,socket; s=socket.socket(); s.settimeout(2); assert s.connect_ex(("192.0.2.1",9)) == errno.ENETUNREACH'
touch /tmp/qa-scratch
printf QA_SANDBOX_OK
`], { revision: candidate });
  if (qa.status !== 'completed' || qa.exitCode !== 0 || qa.stdout !== 'QA_SANDBOX_OK') throw new Error(`QA sandbox isolation failed: ${JSON.stringify(qa)}`);
  const canonical = await provider.command(['shell', id, '--', 'sh', '-c', 'test "$(cat "$HOME/project/input")" = dirty && test ! -e "$HOME/project/qa-mutation" && test ! -e "$HOME/project/escape"']);
  if (canonical.stderr) throw new Error('The canonical workspace check returned an unexpected error.');
  let changedQaBindingRejected = false;
  try { await provider.runAction(id, 'qa-isolation', ['true'], { revision: candidate }); } catch { changedQaBindingRejected = true; }
  if (!changedQaBindingRejected) throw new Error('QA operation accepted changed arguments.');
  const safeLink = await provider.runAction(id, 'qa-safe-link-candidate', ['sh', '-c', 'git checkout -- input && ln -s input link && git add link && git commit -qm safe-link && git rev-parse HEAD']);
  if (safeLink.status !== 'completed' || safeLink.exitCode !== 0) throw new Error('Could not prepare the internal symlink candidate.');
  const safeLinkQa = await provider.runAction(id, 'qa-safe-link', ['sh', '-c', 'test "$(cat /work/link)" = source-a && printf SAFE_LINK_OK'], { revision: safeLink.stdout.trim() });
  if (safeLinkQa.status !== 'completed' || safeLinkQa.exitCode !== 0 || safeLinkQa.stdout !== 'SAFE_LINK_OK') throw new Error('QA sandbox rejected a safe internal symbolic link.');
  const restoreLink = await provider.runAction(id, 'qa-restore-after-safe-link', ['git', 'reset', '--hard', candidate]);
  if (restoreLink.status !== 'completed' || restoreLink.exitCode !== 0) throw new Error('Could not restore the candidate after the safe symlink check.');
  const symlink = await provider.runAction(id, 'qa-symlink-candidate', ['sh', '-c', 'git checkout -- input && ln -s /tmp/outside link && git add link && git commit -qm symlink && git rev-parse HEAD']);
  if (symlink.status !== 'completed' || symlink.exitCode !== 0) throw new Error('Could not prepare the symlink candidate.');
  const rejectedSymlink = await provider.runAction(id, 'qa-reject-symlink', ['sh', '-c', 'printf UNEXPECTED_QA_EXECUTION'], { revision: symlink.stdout.trim() });
  if (rejectedSymlink.status !== 'completed' || rejectedSymlink.exitCode === 0 || rejectedSymlink.stdout.includes('UNEXPECTED_QA_EXECUTION')) throw new Error('QA sandbox accepted a candidate with an unsafe symbolic link.');
  const restored = await provider.runAction(id, 'qa-restore-candidate', ['git', 'reset', '--hard', candidate]);
  if (restored.status !== 'completed' || restored.exitCode !== 0) throw new Error('Could not restore the disposable candidate.');
  const escapeLink = await provider.runAction(id, 'qa-escaping-link-candidate', ['sh', '-c', 'ln -s ../../outside link && git add link && git commit -qm escaping-link && git rev-parse HEAD']);
  if (escapeLink.status !== 'completed' || escapeLink.exitCode !== 0) throw new Error('Could not prepare the escaping symlink candidate.');
  const rejectedEscape = await provider.runAction(id, 'qa-reject-escaping-link', ['sh', '-c', 'printf UNEXPECTED_QA_EXECUTION'], { revision: escapeLink.stdout.trim() });
  if (rejectedEscape.status !== 'completed' || rejectedEscape.exitCode === 0 || rejectedEscape.stdout.includes('UNEXPECTED_QA_EXECUTION')) throw new Error('QA sandbox accepted an escaping symbolic link.');
  const restoredEscape = await provider.runAction(id, 'qa-restore-after-escaping-link', ['git', 'reset', '--hard', candidate]);
  if (restoredEscape.status !== 'completed' || restoredEscape.exitCode !== 0) throw new Error('Could not restore the candidate after the escaping symlink check.');
  const exportIgnored = await provider.runAction(id, 'qa-export-ignore-candidate', ['sh', '-c', "printf 'input export-ignore\\n' > .gitattributes && git add .gitattributes && git commit -qm export-ignore && git rev-parse HEAD"]);
  if (exportIgnored.status !== 'completed' || exportIgnored.exitCode !== 0) throw new Error('Could not prepare the incomplete archive candidate.');
  const rejectedArchive = await provider.runAction(id, 'qa-reject-incomplete-archive', ['sh', '-c', 'printf UNEXPECTED_QA_EXECUTION'], { revision: exportIgnored.stdout.trim() });
  if (rejectedArchive.status !== 'completed' || rejectedArchive.exitCode === 0 || rejectedArchive.stdout.includes('UNEXPECTED_QA_EXECUTION')) throw new Error('QA sandbox accepted an archive that omitted committed files.');
  const restoredAgain = await provider.runAction(id, 'qa-restore-after-export-ignore', ['git', 'reset', '--hard', candidate]);
  if (restoredAgain.status !== 'completed' || restoredAgain.exitCode !== 0) throw new Error('Could not restore the candidate after archive verification.');
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
  const backupArgv = ['sh', '-c', 'printf y >> backup-uncertain; printf saved'];
  if (process.env.OPENBOT_TEST_VM_BACKUP === '1') {
    interrupted = false;
    const uncertain = await provider.runAction(id, 'backup-uncertain', backupArgv);
    if (uncertain.status !== 'uncertain') throw new Error('Backup fixture did not retain an uncertain action.');
  }
  await provider.command(process.env.OPENBOT_TEST_FORCE_STOP === '1' ? ['stop', '--force', id] : ['stop', id]);
  if (process.env.OPENBOT_TEST_VM_BACKUP === '1') {
    // All paths are inside this test's newly-created temporary root. Copy only
    // after stopping the disposable guest, then restore to the same binding.
    const vmDirectory = join(root, 'lima', id);
    const actionDirectory = join(root, '.openbot-vm-state');
    const backup = join(root, 'vm-backup');
    await mkdir(backup);
    const copyArgs = process.platform === 'darwin' ? ['-cR'] : ['-a', '--reflink=auto', '--sparse=always'];
    await exec('cp', [...copyArgs, vmDirectory, join(backup, 'vm')], { timeout: 240000 });
    await exec('cp', [...copyArgs, actionDirectory, join(backup, 'actions')], { timeout: 240000 });
    await rm(vmDirectory, { recursive: true, force: true });
    await rm(actionDirectory, { recursive: true, force: true });
    await exec('cp', [...copyArgs, join(backup, 'vm'), vmDirectory], { timeout: 240000 });
    await exec('cp', [...copyArgs, join(backup, 'actions'), actionDirectory], { timeout: 240000 });
    console.log('Restored the stopped disposable guest disk and provider receipts from backup.');
  }
  const restarted = await provider.ensure('fixture', 'recovery', blueprint.business.initialization.workspace);
  if (!restarted.ready || restarted.id !== id) throw new Error('The same VM did not return after restart.');
  const persisted = await provider.runAction(id, 'probe', argv);
  const afterRestart = await original(['shell', id, '--', 'sh', '-c', 'cat "$HOME/project/fixture"']);
  if (persisted.status !== 'completed' || afterRestart.stdout !== 'x') throw new Error('The workspace or action receipt did not survive restart.');
  if (process.env.OPENBOT_TEST_VM_BACKUP === '1') {
    const recoveredBackup = await provider.reconcileAction(id, 'backup-uncertain');
    const replayedBackup = await provider.runAction(id, 'backup-uncertain', backupArgv);
    const backupContents = await original(['shell', id, '--', 'sh', '-c', 'cat "$HOME/project/backup-uncertain"']);
    if (recoveredBackup.status !== 'completed' || recoveredBackup.stdout !== 'saved' || replayedBackup.status !== 'completed' || backupContents.stdout !== 'y') {
      throw new Error('The restored uncertain action was not reconciled exactly once.');
    }
    console.log('Restored an uncertain guest action and reconciled its single effect.');
  }
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
