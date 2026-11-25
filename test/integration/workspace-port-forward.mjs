import { createServer, connect } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { LimaWorkspaceProvider } from '../../dist/deploy/workspace-provider/lima.js';

const exec = promisify(execFile);
const directory = await mkdtemp('/tmp/ob-port-');
const binary = process.env.LIMACTL_PATH ?? 'limactl';
process.env.LIMA_HOME = join(directory, 'lima');
const provider = new LimaWorkspaceProvider(binary, process.env.LIMA_HOME);
const id = provider.id('fixture', 'port-forward');
let interrupted = false;
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => { interrupted = true; process.exitCode = code; });
const checkInterrupted = () => { if (interrupted) throw Error('Disposable VM test interrupted.'); };
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const reachable = () => new Promise(resolve => {
  const socket = connect({ host: '127.0.0.1', port });
  socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
try {
  if (await reachable()) throw Error('The selected host port is already in use.');
  const blueprint = JSON.parse(await readFile(new URL('../../blueprints/software-development/blueprint.json', import.meta.url), 'utf8'));
  await provider.ensure('fixture', 'port-forward', blueprint.business.initialization.workspace);
  checkInterrupted();
  await provider.command(['shell', id, '--', 'sudo', '-n', 'sh', '-eu', '-c', 'groupadd openbot-isolation-test; usermod -a -G openbot-isolation-test openbot-project']);
  try {
    if ((await provider.check(id)).ready) throw Error('A project user with an extra group was accepted as isolated.');
    let refused = false;
    try { await provider.runAction(id, 'group-isolation-check', ['true']); } catch { refused = true; }
    if (!refused) throw Error('A workspace action ran while the project user had an extra group.');
  } finally {
    await provider.command(['shell', id, '--', 'sudo', '-n', 'sh', '-eu', '-c', 'gpasswd -d openbot-project openbot-isolation-test >/dev/null; groupdel openbot-isolation-test']);
  }
  if (!(await provider.check(id)).ready) throw Error('The guest did not recover after removing the extra group.');
  console.log('The project VM refused actions while the project user had an extra group.');
  const source = join(directory, 'source');
  await mkdir(source);
  await writeFile(join(source, 'fixture'), 'fixture');
  await provider.importSource(id, directory, source);
  const privilege = await provider.runAction(id, 'no-new-privileges', ['sh', '-c', "awk '/^NoNewPrivs:/ {print $2}' /proc/self/status"]);
  if (privilege.status !== 'completed' || privilege.exitCode !== 0 || privilege.stdout.trim() !== '1') throw Error('Project commands did not run with no-new-privileges enabled.');
  console.log('Project commands ran with no-new-privileges enabled.');
  await provider.command(['shell', id, '--', 'sh', '-c', `nohup python3 -m http.server ${port} --bind 127.0.0.1 >/tmp/openbot-port-fixture.log 2>&1 </dev/null &`]);
  await provider.command(['shell', id, '--', 'python3', '-c', `import socket,time
for attempt in range(30):
 try:
  s=socket.create_connection(('127.0.0.1',${port}),timeout=1); s.close(); break
 except OSError: time.sleep(0.2)
else: raise RuntimeError('Guest listener did not start')`]);
  for (let attempt = 0; attempt < 10; attempt++) {
    checkInterrupted();
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (await reachable()) throw Error('A guest loopback listener was forwarded to the host.');
  }
  console.log('A disposable guest loopback listener was not forwarded to the host.');
} finally {
  await exec(binary, ['stop', '--force', id], { timeout: 60000 }).catch(() => {});
  let removed = false;
  try { await exec(binary, ['delete', '--force', id], { timeout: 60000 }); removed = true; }
  catch {
    try { removed = (await provider.check(id)).status === 'Missing'; } catch { /* Retain recovery metadata. */ }
  }
  if (removed) await rm(directory, { recursive: true, force: true });
  else { console.error(`Disposable VM cleanup failed; metadata retained at ${directory}.`); process.exitCode = 1; }
}
