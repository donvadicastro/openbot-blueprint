import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'openbot-readiness-test-'));
execFileSync(resolve('node_modules/.bin/tsc'), [
  '--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext',
  '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'),
  '--outDir', directory, resolve('deploy/openbot/product/readiness.ts'), resolve('deploy/openbot/product/native-readiness.ts'),
], { stdio: 'pipe' });
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { readinessOperations } = await import(pathToFileURL(join(directory, 'readiness.js')).href);
const { createNativeReadinessProbe } = await import(pathToFileURL(join(directory, 'native-readiness.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

function fixture() {
  const project = {
    id: 'project-a', installationId: 'installation-a', blueprintKey: 'swe', blueprintVersion: '1',
    state: 'Initializing', revision: 1, permissions: ['read', 'manage'],
  };
  const assignment = { id: 'assignment-a', roleKey: 'qa', nativeBotId: 'qa-bot', revision: 1 };
  const business = {
    roles: [{ id: 'qa', startupChecks: [{ id: 'role-ready', kind: 'role-ready' }] }],
    initialization: { workspace: { kind: 'none' }, requiredArtifacts: [] },
  };
  const saved = [];
  const database = {
    async unsafe(sql, args = []) {
      if (sql.includes('join bp_memberships')) return [{ ...project }];
      if (sql.includes('from bp_assignments where')) return [assignment];
      if (sql.includes('from bp_artifacts')) return [];
      if (sql.includes('from bp_project_vms')) return [];
      if (sql.includes('left join bp_readiness r')) return saved.length ? saved : [{ assignmentId: assignment.id, roleKey: assignment.roleKey, status: 'Pending', evidence: { reason: 'Waiting for the assigned bot to report readiness.', checks: [] } }];
      if (sql.includes('insert into bp_readiness')) {
        saved.push({ assignmentId: args[1], status: args[4], evidence: JSON.parse(args[5]) });
      }
      if (sql.includes('update bp_projects set state=')) {
        project.state = args[1];
        project.revision++;
      }
      return [];
    },
    async begin(callback) { return callback(this); },
  };
  return { project, saved, module: { database, async definitionFor() { return { business }; } } };
}

test('a missing bot response keeps the project blocked', async () => {
  const f = fixture();
  const result = await readinessOperations(f.module).refresh({ id: 'owner', role: 'user' }, 'project-a');
  assert.equal(f.project.state, 'Initializing');
  assert.equal(result.reports[0].status, 'Blocked');
  assert.match(result.reports[0].evidence.reason, /Waiting for the assigned bot/);
});

test('a reachable VM without verified network isolation keeps the project blocked', async () => {
  const f = fixture();
  const original = f.module.database.unsafe;
  f.module.database.unsafe = async function (sql, args = []) {
    if (sql.includes('from bp_project_vms')) return [{ providerId: 'vm', sourceRevision: 'revision', state: 'Ready' }];
    return original.call(this, sql, args);
  };
  f.module.definitionFor = async () => ({ business: { roles: [{ id: 'qa', startupChecks: [{ id: 'role-ready', kind: 'role-ready' }] }], initialization: { workspace: { kind: 'vm' }, requiredArtifacts: [] } } });
  const oldFetch = globalThis.fetch, oldUrl = process.env.WORKSPACE_PROVIDER_URL, oldToken = process.env.WORKSPACE_PROVIDER_TOKEN;
  process.env.WORKSPACE_PROVIDER_URL = 'http://provider.invalid';
  process.env.WORKSPACE_PROVIDER_TOKEN = 'test-token';
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 'vm', ready: true }) });
  try {
    const result = await readinessOperations(f.module, async () => { throw Error('probe should not run'); }).refresh({ id: 'owner', role: 'user' }, 'project-a');
    assert.equal(result.project.state, 'Initializing');
    assert.match(result.reports[0].evidence.reason, /isolation has not been verified/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.WORKSPACE_PROVIDER_URL; else process.env.WORKSPACE_PROVIDER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.WORKSPACE_PROVIDER_TOKEN; else process.env.WORKSPACE_PROVIDER_TOKEN = oldToken;
  }
});

test('a recovered VM is marked ready before bots recheck it, and its source revision must match', async () => {
  const f = fixture();
  const vm = { providerId: 'vm', sourceRevision: 'revision', state: 'Blocked' };
  const original = f.module.database.unsafe;
  f.module.database.unsafe = async function (sql, args = []) {
    if (sql.includes("update bp_project_vms set state='Ready'")) { vm.state = 'Ready'; return [{ projectId: 'project-a' }]; }
    if (sql.includes('from bp_project_vms')) return [vm];
    return original.call(this, sql, args);
  };
  f.module.definitionFor = async () => ({ business: { roles: [{ id: 'qa', startupChecks: [{ id: 'role-ready', kind: 'role-ready' }] }], initialization: { workspace: { kind: 'vm' }, requiredArtifacts: [] } } });
  const oldFetch = globalThis.fetch, oldUrl = process.env.WORKSPACE_PROVIDER_URL, oldToken = process.env.WORKSPACE_PROVIDER_TOKEN;
  process.env.WORKSPACE_PROVIDER_URL = 'http://provider.invalid'; process.env.WORKSPACE_PROVIDER_TOKEN = 'test-token';
  let sourceRevision = 'old-revision';
  globalThis.fetch = async url => ({ ok: true, json: async () => url.pathname === '/check' ? { id: 'vm', ready: true, isolated: true } : { hasProject: true, revision: sourceRevision } });
  try {
    let probed = false;
    const probe = async () => { probed = true; assert.equal(vm.state, 'Ready'); return { ready: true, checks: [{ id: 'role-ready', passed: true, evidence: 'checked' }] }; };
    await readinessOperations(f.module, probe).refresh({ id: 'owner', role: 'user' }, 'project-a');
    assert.equal(probed, false);
    assert.equal(f.project.state, 'Initializing');
    sourceRevision = 'revision';
    await readinessOperations(f.module, probe).refresh({ id: 'owner', role: 'user' }, 'project-a');
    assert.equal(probed, true);
    assert.equal(vm.state, 'Ready');
    assert.equal(f.project.state, 'Operational');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.WORKSPACE_PROVIDER_URL; else process.env.WORKSPACE_PROVIDER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.WORKSPACE_PROVIDER_TOKEN; else process.env.WORKSPACE_PROVIDER_TOKEN = oldToken;
  }
});

test('project setup hides restricted source details from members without artifact access', async () => {
  const f = fixture();
  f.module.definitionFor = async () => ({ business: {
    roles: [{ id: 'qa', startupChecks: [] }], artifactTypes: [{ id: 'source-code', owner: 'other-role', producers: [], consumers: [] }],
    initialization: { workspace: { kind: 'vm' }, requiredArtifacts: [] },
  } });
  const original = f.module.database.unsafe;
  f.module.database.unsafe = async function (sql, args = []) {
    if (sql.includes('from bp_project_vms')) return [{ state: 'Ready', sourceRevision: 'private-revision', excludedPaths: ['private/path'], excludesUncommittedChanges: true, reason: 'Cannot read private/path' }];
    if (sql.includes('from bp_artifacts') && sql.includes('allowed_user_ids')) {
      assert.deepEqual(args, ['project-a', 'viewer']);
      return [];
    }
    if (sql.includes('from bp_artifacts')) return [{ typeKey: 'source-code' }];
    return original.call(this, sql, args);
  };
  const result = await readinessOperations(f.module).inspect({ id: 'viewer', role: 'user' }, 'project-a');
  assert.deepEqual(result.artifacts, []);
  assert.equal(result.workspace.sourceRevision, null);
  assert.deepEqual(result.workspace.excludedPaths, []);
  assert.equal(result.workspace.excludesUncommittedChanges, false);
  assert.equal(result.workspace.reason, 'Workspace details are unavailable.');
  assert.deepEqual(result.reports[0].evidence, { reason: 'Some readiness details are restricted.', checks: [] });
});

test('a bot must report every declared check with evidence', async () => {
  const f = fixture();
  await readinessOperations(f.module, async () => ({ ready: true, checks: [] }))
    .refresh({ id: 'owner', role: 'user' }, 'project-a');
  assert.equal(f.project.state, 'Initializing');
  assert.equal(f.saved[0].status, 'Blocked');
  const g = fixture();
  await readinessOperations(g.module, async input => {
    assert.equal(input.nativeBotId, 'qa-bot');
    return { ready: true, checks: [{ id: 'role-ready', passed: true, evidence: 'checked by qa-bot' }] };
  }).refresh({ id: 'owner', role: 'user' }, 'project-a');
  assert.equal(g.project.state, 'Operational');
});

test('malformed bot readiness output is blocked without crashing or being persisted as evidence', async () => {
  const f = fixture();
  const result = await readinessOperations(f.module, async () => ({ ready: true, checks: [{ id: 'role-ready', passed: 'yes', evidence: {} }] }))
    .refresh({ id: 'owner', role: 'user' }, 'project-a');
  assert.equal(result.project.state, 'Initializing');
  assert.equal(result.reports[0].status, 'Blocked');
  assert.deepEqual(result.reports[0].evidence.checks, []);
});

test('readiness probes receive only artifacts visible to the actor and granted to the role', async () => {
  const f = fixture();
  const original = f.module.database.unsafe;
  f.module.definitionFor = async () => ({ business: {
    roles: [{ id: 'qa', startupChecks: [{ id: 'role-ready', kind: 'role-ready' }] }],
    artifactTypes: [
      { id: 'allowed', owner: 'qa', producers: [], consumers: [] },
      { id: 'other-role', owner: 'pm', producers: [], consumers: [] },
      { id: 'restricted', owner: 'qa', producers: [], consumers: [] },
      { id: 'source-code', owner: 'qa', producers: [], consumers: [] },
    ], initialization: { workspace: { kind: 'none' }, requiredArtifacts: [] },
  } });
  const records = ['allowed', 'other-role', 'restricted', 'source-code'].map(typeKey => ({ typeKey, status: 'supplied', source: { secret: typeKey } }));
  f.module.database.unsafe = async function (sql, args = []) {
    if (sql.includes('from bp_project_vms')) return [{ providerId: 'private-vm', sourceRevision: 'private-revision', state: 'Ready' }];
    if (sql.includes('from bp_artifacts')) return sql.includes('allowed_user_ids') ? records.filter(item => !['restricted', 'source-code'].includes(item.typeKey)) : records;
    return original.call(this, sql, args);
  };
  await readinessOperations(f.module, async input => {
    assert.deepEqual(input.artifacts.map(artifact => artifact.typeKey), ['allowed']);
    assert.equal(input.workspace, null);
    return { ready: true, checks: [{ id: 'role-ready', passed: true, evidence: 'ready' }] };
  }).refresh({ id: 'owner', role: 'user' }, 'project-a');
});

test('a readiness response cannot activate a project changed during the probe', async () => {
  const f = fixture();
  await assert.rejects(readinessOperations(f.module, async () => {
    f.project.revision++;
    return { ready: true, checks: [{ id: 'role-ready', passed: true, evidence: 'checked' }] };
  }).refresh({ id: 'owner', role: 'user' }, 'project-a'), error => error.code === 'readiness_stale');
  assert.equal(f.project.state, 'Initializing');
  assert.equal(f.saved.length, 0);
});


test('native readiness addresses the assigned bot as the authenticated owner and refuses unverified VM access', async () => {
  let turn;
  const probe = createNativeReadinessProbe(async input => {
    turn = input;
    return { replyText: JSON.stringify({ ready: true, checks: [
      { id: 'role-ready', passed: true, evidence: 'I am available' },
      { id: 'source-access', passed: true, evidence: 'I can access it' },
    ] }) };
  }, () => 'fresh-thread');
  const result = await probe({ actorId: 'owner', projectId: 'p', nativeBotId: 'qa', assignmentId: 'a', roleKey: 'qa',
    checks: [{ id: 'role-ready', kind: 'role-ready' }, { id: 'source-access', kind: 'artifact-access' }], artifacts: [], workspace: null });
  assert.equal(turn.ownerUserId, 'owner');
  assert.equal(turn.agentId, 'qa');
  assert.equal(turn.threadId, 'fresh-thread');
  assert.equal(turn.workspaceRequired, true);
  assert.equal(result.ready, false);
  assert.equal(result.checks[1].passed, false);
});

test('native readiness rejects invalid or incomplete bot output', async () => {
  const input = { actorId: 'owner', projectId: 'p', nativeBotId: 'qa', assignmentId: 'a', roleKey: 'qa',
    checks: [{ id: 'role-ready', kind: 'role-ready' }], artifacts: [], workspace: null };
  for (const replyText of ['not json', '{"ready":true,"checks":[]}', '{"ready":true,"checks":[{"id":"other","passed":true,"evidence":"x"}]}']) {
    await assert.rejects(createNativeReadinessProbe(async () => ({ replyText }), () => 'thread')(input));
  }
});

test('roles without workspace checks do not receive workspace verification as a requirement', async () => {
  const input = { actorId: 'owner', projectId: 'p', nativeBotId: 'pm', assignmentId: 'a', roleKey: 'pm',
    checks: [{ id: 'role-ready', kind: 'role-ready' }], artifacts: [], workspace: null };
  let scope;
  const probe = createNativeReadinessProbe(async turn => {
    scope = turn;
    return { replyText: JSON.stringify({ ready: true, checks: [{ id: 'role-ready', passed: true, evidence: 'available' }] }) };
  }, () => 'thread');
  assert.equal((await probe(input)).ready, true);
  assert.equal(scope.workspaceRequired, false);
});

test('readiness accepts a single fenced JSON report without relaxing workspace verification', async () => {
  const input = { actorId: 'owner', projectId: 'p', nativeBotId: 'qa', assignmentId: 'a', roleKey: 'qa',
    checks: [{ id: 'source-access', kind: 'artifact-access', artifactType: 'source-code' }], artifacts: [], workspace: null };
  const report = JSON.stringify({ ready: true, checks: [{ id: 'source-access', passed: true, evidence: 'checked' }] });
  const verifier = async () => ({ verified: true, evidence: 'Verified project source.' });
  const probe = createNativeReadinessProbe(async turn => { await turn.checkWorkspace(); return { replyText: `\`\`\`json\n${report}\n\`\`\`` }; }, () => 'thread', verifier);
  assert.equal((await probe(input)).ready, true);
  const noTool = createNativeReadinessProbe(async () => ({ replyText: `\`\`\`json\n${report}\n\`\`\`` }), () => 'thread', verifier);
  assert.equal((await noTool(input)).ready, false);
  const extraText = createNativeReadinessProbe(async () => ({ replyText: `Here is the report:\n\`\`\`json\n${report}\n\`\`\`` }), () => 'thread', verifier);
  await assert.rejects(extraText(input));
});

test('a bot must invoke the bound workspace check before source access can pass', async () => {
  const input = { actorId: 'owner', projectId: 'p', nativeBotId: 'qa', assignmentId: 'a', roleKey: 'qa',
    checks: [{ id: 'source-access', kind: 'artifact-access', artifactType: 'source-code' }], artifacts: [], workspace: null };
  const report = JSON.stringify({ ready: true, checks: [{ id: 'source-access', passed: true, evidence: 'checked' }] });
  let verifies = 0;
  const verifier = async scope => { assert.equal(scope.assignmentId, 'a'); verifies++; return { verified: true, evidence: 'Read the project revision.' }; };
  const withoutTool = createNativeReadinessProbe(async () => ({ replyText: report }), () => 'thread', verifier);
  assert.equal((await withoutTool(input)).ready, false);
  const withTool = createNativeReadinessProbe(async turn => { await turn.checkWorkspace(); return { replyText: report }; }, () => 'thread', verifier);
  assert.equal((await withTool(input)).ready, true);
  assert.equal(verifies, 1);
  assert.equal((await withTool({ ...input, checks: [{ id: 'source-access', kind: 'artifact-access', artifactType: 'other' }] })).ready, false);
});
