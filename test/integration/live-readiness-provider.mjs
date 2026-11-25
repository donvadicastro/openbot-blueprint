import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';

// Coordinates a disposable real VM with the isolated PostgreSQL fixture.
const [databaseContainer, barrierDirectory] = process.argv.slice(2);
if (!/^ob-rebind-db-[0-9]+$/.test(databaseContainer ?? '') || !barrierDirectory?.startsWith('/tmp/obr-ready.')) throw Error('Disposable fixture binding required.');
const exec = promisify(execFile);
const vmDirectory = await mkdtemp('/tmp/obrestore.');
let child;
let stopping = false;
async function cleanup() {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
  await rm(vmDirectory, { recursive: true, force: true });
}
process.on('SIGTERM', () => { void cleanup().finally(() => process.exit(0)); });
process.on('SIGINT', () => { void cleanup().finally(() => process.exit(0)); });
try {
  let binding;
  for (let attempt = 0; attempt < 300 && !binding; attempt++) {
    try {
      const { stdout } = await exec('docker', ['exec', databaseContainer, 'psql', '-U', 'postgres', '-At', '-F', '|', '-c', "select installation_id,id from bp_projects where name='SWE readiness fixture'"], { timeout: 5000 });
      const parts = stdout.trim().split('|');
      if (parts.length === 2 && parts.every(part => /^[a-zA-Z0-9-]+$/.test(part))) binding = parts;
    } catch {}
    if (!binding) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!binding) throw Error('Disposable readiness project was not created.');
  child = spawn(process.execPath, [new URL('./restored-vm-provider.mjs', import.meta.url).pathname, vmDirectory, ...binding], { env: process.env, stdio: 'inherit' });
  let metadata;
  for (let attempt = 0; attempt < 300 && !metadata; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error('Disposable VM provider exited before becoming ready.');
    try { metadata = JSON.parse(await readFile(join(vmDirectory, 'provider.json'), 'utf8')); } catch {}
    if (!metadata) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!metadata) throw Error('Disposable VM provider did not become ready.');
  await writeFile(join(barrierDirectory, 'provider.json'), JSON.stringify({ ...metadata, installationId: binding[0], projectId: binding[1] }));
  await new Promise((_, reject) => child.once('exit', code => reject(Error(`Disposable VM provider exited unexpectedly: ${code}`))));
} catch (error) {
  await writeFile(join(barrierDirectory, 'error.txt'), error instanceof Error ? error.message : 'Disposable VM provider failed.').catch(() => {});
  await cleanup();
  throw error;
}
