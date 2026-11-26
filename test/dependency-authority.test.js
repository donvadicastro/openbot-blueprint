import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDependencyAuthority } from '../dist/deploy/workspace-provider/dependency-authority.js';
import { LimaWorkspaceProvider } from '../dist/deploy/workspace-provider/lima.js';

test('dependency authorities persist per project and keep signing keys private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openbot-dependency-ca-'));
  const firstDir = join(root, 'first'), secondDir = join(root, 'second');
  const policy = { destinations: [{ hostname: 'packages.example.org', port: 443 }] };
  try {
    const [first, concurrent] = await Promise.all([prepareDependencyAuthority(firstDir, policy), prepareDependencyAuthority(firstDir, policy)]);
    assert.deepEqual(first.caCertificate, concurrent.caCertificate);
    const second = await prepareDependencyAuthority(secondDir, policy);
    assert.notDeepEqual(first.caCertificate, second.caCertificate);
    assert.deepEqual([...first.certificates.keys()], ['packages.example.org']);
    const leafDir = join(firstDir, 'leaves', createHash('sha256').update('packages.example.org').digest('hex'));
    const caKey = join(firstDir, 'authority', 'ca.key'), leafKey = join(leafDir, 'leaf.key');
    assert.equal((await lstat(firstDir)).mode & 0o077, 0);
    assert.equal((await lstat(caKey)).mode & 0o077, 0);
    assert.equal((await lstat(leafKey)).mode & 0o077, 0);
    const ca = new X509Certificate(first.caCertificate), leaf = new X509Certificate(await readFile(join(leafDir, 'leaf.crt')));
    assert.equal(leaf.checkHost('packages.example.org'), 'packages.example.org');
    assert.equal(leaf.checkHost('unapproved.example.org'), undefined);
    assert.equal(leaf.verify(ca.publicKey), true);
    const provider = new LimaWorkspaceProvider('/fixture/limactl', join(root, 'lima'));
    const vmId = provider.id('installation', 'project');
    provider.check = async () => ({ id: vmId, ready: true, isolated: true });
    let installed;
    provider.command = async args => { installed = args; return { stdout: '', stderr: '' }; };
    assert.equal((await provider.installDependencyAuthority(vmId, first.caCertificate)).installed, true);
    assert.deepEqual(Buffer.from(installed.at(-2), 'base64'), first.caCertificate);
    await assert.rejects(provider.installDependencyAuthority(vmId, await readFile(join(leafDir, 'leaf.crt'))), /Invalid dependency authority/);
    await assert.rejects(provider.installDependencyAuthority(vmId, Buffer.concat([first.caCertificate, first.caCertificate])), /Invalid dependency authority/);
    const csr = join(root, 'expired.csr'), extensions = join(root, 'expired.cnf');
    await writeFile(extensions, '[leaf]\nbasicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:packages.example.org\nextendedKeyUsage=serverAuth\n');
    execFileSync('openssl', ['req', '-new', '-key', leafKey, '-out', csr, '-subj', '/CN=fixture'], { stdio: 'ignore' });
    execFileSync('openssl', ['x509', '-req', '-in', csr, '-CA', join(firstDir, 'authority', 'ca.crt'), '-CAkey', caKey,
      '-set_serial', '1', '-days', '0', '-extfile', extensions, '-extensions', 'leaf', '-out', join(leafDir, 'leaf.crt')], { stdio: 'ignore' });
    const expired = new X509Certificate(await readFile(join(leafDir, 'leaf.crt')));
    const renewed = await prepareDependencyAuthority(firstDir, policy);
    const replacement = new X509Certificate(await readFile(join(leafDir, 'leaf.crt')));
    assert.deepEqual(renewed.caCertificate, first.caCertificate);
    assert.notEqual(replacement.fingerprint256, expired.fingerprint256);
    assert.equal(replacement.verify(ca.publicKey), true);
    assert.deepEqual([...(await prepareDependencyAuthority(firstDir, { destinations: [] })).certificates.keys()], []);
    await chmod(caKey, 0o644);
    await assert.rejects(prepareDependencyAuthority(firstDir, policy), /private regular files/);
    const link = join(root, 'link'); await symlink(firstDir, link);
    await assert.rejects(prepareDependencyAuthority(link, policy), /real directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
