import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import { promisify } from 'node:util';
import { registryTransaction } from '../../src/file-lock.js';
import { parseDependencyEgressPolicy, type DependencyEgressPolicy } from './egress-policy.js';

const exec = promisify(execFile);
const openssl = async (...args: string[]) => (await exec('openssl', args, { timeout: 30000, maxBuffer: 1024 * 1024 })).stdout;

async function regularFile(path: string, privateKey = false) {
  const info = await lstat(path);
  if (!info.isFile() || (privateKey && (info.mode & 0o077) !== 0)) throw new Error('Dependency authority files are not private regular files.');
}

async function matchingKey(certificate: string, key: string) {
  await regularFile(certificate);
  await regularFile(key, true);
  const publicCertificate = await openssl('x509', '-in', certificate, '-pubkey', '-noout');
  const publicKey = await openssl('pkey', '-in', key, '-pubout');
  if (publicCertificate !== publicKey) throw new Error('Dependency certificate and key do not match.');
}

/** Prepare a persistent per-project authority and only the currently authorized leaf contexts. */
export async function prepareDependencyAuthority(directory: string, input: DependencyEgressPolicy): Promise<{
  caCertificate: Buffer; certificates: Map<string, SecureContext>;
}> {
  const policy = parseDependencyEgressPolicy(input);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Dependency authority directory must be a real directory.');
  await chmod(directory, 0o700);
  return registryTransaction(directory, async () => {
    const authority = join(directory, 'authority'), ca = join(authority, 'ca.crt'), caKey = join(authority, 'ca.key');
    let exists = false;
    try { const info = await lstat(authority); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid authority directory.'); exists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!exists) {
      const staging = await mkdtemp(join(directory, '.authority-'));
      try {
        await openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
          '-subj', '/CN=OpenBot project dependency authority', '-addext', 'basicConstraints=critical,CA:TRUE',
          '-keyout', join(staging, 'ca.key'), '-out', join(staging, 'ca.crt'));
        await chmod(join(staging, 'ca.key'), 0o600);
        await rename(staging, authority);
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    await chmod(authority, 0o700);
    await matchingKey(ca, caKey);
    await openssl('x509', '-in', ca, '-checkend', '86400', '-noout');
    const leaves = join(directory, 'leaves');
    await mkdir(leaves, { recursive: true, mode: 0o700 });
    const leafRoot = await lstat(leaves);
    if (!leafRoot.isDirectory() || leafRoot.isSymbolicLink()) throw new Error('Invalid dependency certificate directory.');
    await chmod(leaves, 0o700);
    const certificates = new Map<string, SecureContext>();
    for (const { hostname } of policy.destinations) {
      const target = join(leaves, createHash('sha256').update(hostname).digest('hex'));
      const leaf = join(target, 'leaf.crt'), key = join(target, 'leaf.key');
      let reusable = false, replaceExpired = false, targetExists = false;
      try {
        const info = await lstat(target);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid dependency leaf directory.');
        targetExists = true;
        await chmod(target, 0o700);
        await matchingKey(leaf, key);
        await openssl('verify', '-no_check_time', '-CAfile', ca, '-verify_hostname', hostname, leaf);
        try { await openssl('x509', '-in', leaf, '-checkend', '86400', '-noout'); reusable = true; }
        catch { replaceExpired = true; }
      } catch (error) {
        if (targetExists || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!reusable) {
        const staging = await mkdtemp(join(leaves, '.leaf-'));
        try {
          await openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=OpenBot dependency gateway',
            '-keyout', join(staging, 'leaf.key'), '-out', join(staging, 'leaf.csr'));
          await chmod(join(staging, 'leaf.key'), 0o600);
          await writeFile(join(staging, 'extensions.cnf'), `[leaf]\nbasicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:${hostname}\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
          await openssl('x509', '-req', '-in', join(staging, 'leaf.csr'), '-CA', ca, '-CAkey', caKey,
            '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-days', '30', '-sha256',
            '-extfile', join(staging, 'extensions.cnf'), '-extensions', 'leaf', '-out', join(staging, 'leaf.crt'));
          await matchingKey(join(staging, 'leaf.crt'), join(staging, 'leaf.key'));
          await openssl('verify', '-CAfile', ca, '-verify_hostname', hostname, join(staging, 'leaf.crt'));
          await rm(join(staging, 'leaf.csr')); await rm(join(staging, 'extensions.cnf'));
          if (replaceExpired) {
            const previous = `${target}.previous-${randomBytes(8).toString('hex')}`;
            await rename(target, previous);
            try { await rename(staging, target); }
            catch (error) { await rename(previous, target); throw error; }
            await rm(previous, { recursive: true, force: true });
          } else await rename(staging, target);
        } finally { await rm(staging, { recursive: true, force: true }); }
      }
      certificates.set(hostname, createSecureContext({ cert: await readFile(leaf), key: await readFile(key) }));
    }
    return { caCertificate: await readFile(ca), certificates };
  }, 300000);
}
