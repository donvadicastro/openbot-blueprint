import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { workspaceServer } from '../dist/deploy/workspace-provider/server.js';

test('workspace provider serializes imports for each project and checks authorization', async () => {
  let active = 0;
  let maximum = 0;
  const calls = [];
  const provider = {
    id: (installation, project) => installation + '-' + project,
    async importSource(id, root, source) {
      active++;
      maximum = Math.max(maximum, active);
      calls.push([id, root, source]);
      await new Promise(resolve => setTimeout(resolve, 30));
      active--;
      return { revision: 'baseline' };
    },
  };
  const token = 'a'.repeat(32);
  const server = workspaceServer({ token, installationId: 'install', sourceRoot: '/host/projects', provider });
  function send(authorization) {
    const body = JSON.stringify({ installationId: 'install', projectId: 'project', source: '/projects/repo' });
    const request = Readable.from([Buffer.from(body)]);
    request.headers = authorization ? { authorization } : {};
    request.method = 'POST';
    request.url = '/import';
    return new Promise(resolve => {
      const response = {
        status: 200,
        writeHead(status) { this.status = status; return this; },
        end() { resolve(this.status); },
      };
      server.emit('request', request, response);
    });
  }
  assert.equal(await send(), 401);
  const statuses = await Promise.all([send('Bearer ' + token), send('Bearer ' + token)]);
  assert.deepEqual(statuses, [200, 200]);
  assert.equal(maximum, 1);
  assert.deepEqual(calls, [
    ['install-project', '/host/projects', '/host/projects/repo'],
    ['install-project', '/host/projects', '/host/projects/repo'],
  ]);
});

test('Lima discovery distinguishes a missing VM from a provider failure', async t => {
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { LimaPathError, LimaWorkspaceProvider } = await import('../dist/deploy/workspace-provider/lima.js');
  const dir = await mkdtemp(join(tmpdir(), 'openbot-lima-list-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'limactl');
  await writeFile(binary, '#!/bin/sh\nif [ "$1" = list ] && [ "$2" = --json ] && [ "$#" -eq 2 ]; then printf "%s\\n" "{\\"name\\":\\"other\\",\\"status\\":\\"Running\\"}"; elif [ "$1" = shell ]; then exit 0; else exit 7; fi\n');
  await chmod(binary, 0o755);
  const provider = new LimaWorkspaceProvider(binary, join(dir, 'instances'));
  assert.deepEqual(await provider.check('missing'), { id: 'missing', ready: false, status: 'Missing' });
  assert.deepEqual(await provider.check('other'), { id: 'other', ready: true, status: 'Running', isolated: true, qaSandbox: 'git-readonly-v1' });
  await assert.rejects(provider.check('../other'), /Invalid workspace identifier/);
  await writeFile(binary, '#!/bin/sh\nif [ "$1" = list ]; then printf "%s\\n" "{\\"name\\":\\"other\\",\\"status\\":\\"Running\\"}"; elif [ "$4" = true ]; then exit 0; else exit 7; fi\n');
  assert.deepEqual(await provider.check('other'), { id: 'other', ready: false, status: 'IsolationUnverified', isolated: false });
  await writeFile(binary, '#!/bin/sh\nif [ "$1" = list ]; then printf "%s\\n" "{\\"name\\":\\"other\\",\\"status\\":\\"Running\\"}"; else exit 7; fi\n');
  assert.deepEqual(await provider.check('other'), { id: 'other', ready: false, status: 'Unreachable' });
  const projectId = provider.id('install', 'project');
  await writeFile(binary, `#!/bin/sh\nif [ "$1" = list ]; then printf '%s\\n' '{"name":"${projectId}","status":"Running"}'; else exit 7; fi\n`);
  const profile = { kind: 'vm', image: 'https://example.invalid/image', imageDigest: 'sha256:' + 'a'.repeat(64) };
  assert.deepEqual(await provider.ensure('install', 'project', profile), { id: projectId, ready: false, status: 'Unreachable' });
  await writeFile(binary, '#!/bin/sh\nexit 7\n');
  await assert.rejects(provider.check('missing'));
  await writeFile(binary, '#!/bin/sh\necho UNIX_PATH_MAX >&2\nexit 1\n');
  await assert.rejects(provider.check('missing'), LimaPathError);
});

test('Lima ensure reconciles concurrent processes to one VM', async t => {
  const { mkdtemp, writeFile, chmod, readFile, rm } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { spawn } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'openbot-vm-concurrent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'limactl');
  const state = join(dir, 'state');
  const launches = join(dir, 'launches');
  const capturedProfile = join(dir, 'profile.json');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'list') {
  if (fs.existsSync(process.env.PROBE_STATE)) console.log(fs.readFileSync(process.env.PROBE_STATE, 'utf8'));
} else if (args[0] === 'start') {
  const name = args.find(v => v.startsWith('--name=')).slice(7);
  fs.copyFileSync(args.at(-1), process.env.PROBE_CONFIG);
  fs.appendFileSync(process.env.PROBE_LAUNCHES, name + '\\n');
  setTimeout(() => fs.writeFileSync(process.env.PROBE_STATE, JSON.stringify({name, status:'Running'})), 100);
} else if (args[0] !== 'shell') process.exitCode = 1;
`);
  await chmod(binary, 0o755);
  const script = join(dir, 'ensure.mjs');
  await writeFile(script, `import { LimaWorkspaceProvider } from ${JSON.stringify(new URL('../dist/deploy/workspace-provider/lima.js', import.meta.url).href)};
const provider = new LimaWorkspaceProvider(process.env.PROBE_BINARY);
const result = await provider.ensure('installation', 'project', {kind:'vm',provider:'lima',image:'https://example.invalid/image',imageDigest:'sha256:' + 'a'.repeat(64),cpus:2,memoryMb:1024,diskGb:10});
if (!result.ready) process.exitCode = 2;`);
  const env = { ...process.env, LIMA_HOME: join(dir, 'instances'), PROBE_STATE: state, PROBE_LAUNCHES: launches, PROBE_BINARY: binary, PROBE_CONFIG: capturedProfile };
  function run() {
    return new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: resolve('.') });
      let stderr = '';
      child.stderr.on('data', chunk => stderr += chunk);
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolveRun() : reject(new Error(stderr)));
    });
  }
  await Promise.all([run(), run()]);
  assert.equal((await readFile(launches, 'utf8')).trim().split('\n').length, 1);
  const profile = JSON.parse(await readFile(capturedProfile, 'utf8'));
  assert.deepEqual(profile.portForwards, [{ guestIP: '0.0.0.0', guestIPMustBeZero: false, proto: 'any', guestPortRange: [1, 65535], ignore: true }]);
});

test('workspace actions persist results and never rerun uncertain operations', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { LimaWorkspaceProvider } = await import('../dist/deploy/workspace-provider/lima.js');
  const dir = await mkdtemp(join(tmpdir(), 'openbot-actions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = new LimaWorkspaceProvider('ignored', join(dir, 'instances'));
  provider.verifyIsolation = async () => true;
  const id = provider.id('install', 'project');
  let calls = 0;
  provider.command = async args => {
    calls++;
    assert.deepEqual(args.slice(-2), ['printf', 'hello']);
    return { stdout: 'hello', stderr: '\n' + args[7] + '0\n' };
  };
  const result = await provider.runAction(id, 'action-1', ['printf', 'hello']);
  assert.deepEqual(result, { status: 'completed', exitCode: 0, stdout: 'hello', stderr: '' });
  assert.deepEqual(await provider.runAction(id, 'action-1', ['printf', 'hello']), result);
  assert.deepEqual(await provider.reconcileAction(id, 'action-1'), result);
  assert.equal(calls, 1);
  provider.verifyIsolation = async () => false;
  await assert.rejects(provider.runAction(id, 'denied', ['pwd']), /network isolation/);
  assert.equal(calls, 1);
  provider.verifyIsolation = async () => true;
  provider.command = async args => ({ stdout: '', stderr: 'failed\n' + args[7] + '2\n' });
  assert.deepEqual(await provider.runAction(id, 'failure', ['false']), { status: 'completed', exitCode: 2, stdout: '', stderr: 'failed' });
  await assert.rejects(provider.runAction(id, 'action-1', ['pwd']));
  provider.command = async () => { calls++; throw new Error('connection interrupted'); };
  assert.deepEqual(await provider.runAction(id, 'action-2', ['pwd']), { status: 'uncertain' });
  assert.deepEqual(await provider.runAction(id, 'action-2', ['pwd']), { status: 'uncertain' });
  assert.deepEqual(await provider.reconcileAction(id, 'action-2'), { status: 'uncertain' });
  assert.deepEqual(await provider.reconcileAction(id, 'missing'), { status: 'unknown' });
  assert.equal(calls, 4);
});

test('workspace reconciliation recovers a completed guest action after a lost response', async t => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { LimaWorkspaceProvider } = await import('../dist/deploy/workspace-provider/lima.js');
  const dir = await mkdtemp(join(tmpdir(), 'openbot-action-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'guest', 'project'), { recursive: true });
  const provider = new LimaWorkspaceProvider('ignored', join(dir, 'instances'));
  provider.verifyIsolation = async () => true;
  const id = provider.id('install', 'project');
  let interrupt = true;
  provider.command = async args => {
    const localArgs = [...args.slice(4)];
    localArgs[1] = localArgs[1].replace(/sudo -n ip netns exec openbot-project unshare --mount --propagation private sh -c '[^']*' openbot-exec "\$@"/, '"$@"');
    const result = await promisify(execFile)(args[3], localArgs, { env: { ...process.env, HOME: join(dir, 'guest') } });
    if (interrupt) { interrupt = false; throw new Error('response lost'); }
    return result;
  };
  const argv = ['sh', '-c', 'printf effect >> effects; printf output; printf warning >&2; exit 2'];
  assert.deepEqual(await provider.runAction(id, 'stable', argv), { status: 'uncertain' });
  const { createHash } = await import('node:crypto');
  const receipt = createHash('sha256').update('stable').digest('hex');
  const digestPath = join(dir, 'guest', '.openbot', 'actions', receipt, 'digest');
  const digest = await readFile(digestPath, 'utf8');
  await writeFile(digestPath, 'wrong');
  assert.deepEqual(await provider.reconcileAction(id, 'stable'), { status: 'uncertain' });
  await writeFile(digestPath, digest);
  assert.deepEqual(await provider.reconcileAction(id, 'stable'), { status: 'completed', exitCode: 2, stdout: 'output', stderr: 'warning' });
  assert.equal(await readFile(join(dir, 'guest', 'project', 'effects'), 'utf8'), 'effect');
  assert.deepEqual(await provider.runAction(id, 'stable', argv), { status: 'completed', exitCode: 2, stdout: 'output', stderr: 'warning' });
  assert.equal(await readFile(join(dir, 'guest', 'project', 'effects'), 'utf8'), 'effect');
  interrupt = true;
  assert.deepEqual(await provider.runAction(id, 'second', argv), { status: 'uncertain' });
  assert.deepEqual(await provider.runAction(id, 'second', argv), { status: 'completed', exitCode: 2, stdout: 'output', stderr: 'warning' });
  assert.equal(await readFile(join(dir, 'guest', 'project', 'effects'), 'utf8'), 'effecteffect');
});

test('workspace action endpoints validate authorization, project binding and argv', async () => {
  const { LimaPathError } = await import('../dist/deploy/workspace-provider/lima.js');
  const token = 'a'.repeat(32);
  const calls = [];
  const provider = { id: (installation, project) => installation + '-' + project,
    async check() { throw new LimaPathError(); },
    async sourceStatus(id) { calls.push([id]); return { revision: 'baseline', hasProject: true }; },
    async runAction(...args) { calls.push(args); return { status: 'completed', exitCode: 0 }; },
    async reconcileAction(...args) { calls.push(args); return { status: 'unknown' }; } };
  const server = workspaceServer({ token, installationId: 'install', sourceRoot: '/projects', provider });
  async function send(url, body, authorization = 'Bearer ' + token) {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(request, { headers: { authorization }, method: 'POST', url });
    return new Promise(resolve => server.emit('request', request, {
      status: 200, writeHead(status) { this.status = status; return this; }, end(value) { resolve([this.status, value && JSON.parse(value)]); },
    }));
  }
  const base = { installationId: 'install', projectId: 'project', operationKey: 'stable-1' };
  assert.equal((await send('/run', { ...base, argv: ['pwd'] }, 'wrong'))[0], 401);
  assert.equal((await send('/run', { ...base, projectId: '../bad', argv: ['pwd'] }))[0], 422);
  assert.equal((await send('/run', { ...base, argv: 'pwd' }))[0], 422);
  assert.equal((await send('/run', { ...base, argv: ['pwd'], qa: { revision: '../bad' } }))[0], 422);
  assert.equal((await send('/run', { ...base, argv: ['pwd'], qa: { revision: 'a'.repeat(40), extra: true } }))[0], 422);
  assert.equal((await send('/run', { ...base, argv: ['pwd'] }))[0], 200);
  assert.equal((await send('/run', { ...base, operationKey: 'qa-1', argv: ['pwd'], qa: { revision: 'a'.repeat(40) } }))[0], 200);
  assert.deepEqual((await send('/check', base))[1], { code: 'workspace_path_too_long' });
  assert.deepEqual((await send('/source', base))[1], { revision: 'baseline', hasProject: true });
  assert.deepEqual((await send('/reconcile', base))[1], { status: 'unknown' });
  assert.deepEqual(calls, [['install-project', 'stable-1', ['pwd']], ['install-project', 'qa-1', ['pwd'], { revision: 'a'.repeat(40) }], ['install-project'], ['install-project', 'stable-1']]);
});
