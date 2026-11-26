import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';


const directory = await mkdtemp(join(tmpdir(), 'blueprint-product-store-'));
execFileSync(resolve('node_modules/.bin/tsc'), [
  '--ignoreConfig', '--strict', '--skipLibCheck', '--types', 'node',
  '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
  '--rootDir', resolve('deploy/openbot/product'), '--outDir', directory,
  resolve('deploy/openbot/product/access.ts'), resolve('deploy/openbot/product/store.ts'),
], { stdio: 'pipe' });
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { requireProject, requireBotProject } = await import(pathToFileURL(join(directory, 'access.js')).href);
const { createProductStore, contentDigest, productDatabaseFromNative } = await import(pathToFileURL(join(directory, 'store.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

const actor = { id: 'member-a', role: 'user' };
const project = { id: 'project-a', permissions: ['read', 'work'], state: 'Operational' };

test('bot callbacks resolve their project from a joined native conversation and membership', async () => {
  const database = { async unsafe(sql, args) {
    if (sql.includes('from bp_conversations')) {
      assert.match(sql, /channel_memberships/);
      assert.deepEqual(args, ['channel-a', 'member-a', 'qa', null]);
      return [{ projectId: 'project-a', assignmentId: 'assignment-a' }];
    }
    return [project];
  } };
  assert.deepEqual(await requireBotProject(database, actor, 'channel-a', 'qa', 'work'), { project, assignmentId: 'assignment-a' });
  await assert.rejects(requireBotProject({ unsafe: async () => [] }, actor, 'foreign-channel', 'qa'), error => error.status === 404);
  const ambiguous = { unsafe: async () => [{ projectId: 'project-a', assignmentId: 'one' }, { projectId: 'project-a', assignmentId: 'two' }] };
  await assert.rejects(requireBotProject(ambiguous, actor, 'channel-a', 'shared-bot'), error => error.status === 404);
});

test('project lookup always checks membership and does not give global admins an implicit project grant', async () => {
  const database = { unsafe: async (query, parameters) => {
    assert.match(query, /join bp_memberships/);
    assert.match(query, /m.user_id = \$2/);
    assert.deepEqual(parameters, ['private-project', 'admin']);
    return [];
  } };
  await assert.rejects(requireProject(database, { id: 'admin', role: 'admin' }, 'private-project'), error => error.status === 404);
  await assert.rejects(requireProject({ unsafe: async () => [project] }, actor, project.id, 'approve'), error => error.status === 403);
});

test('idempotent project mutations replay once and reject changed payloads before running another effect', async () => {
  const rows = new Map();
  const database = {
    async unsafe(query, parameters) {
      if (query.includes('from bp_projects')) return [project];
      if (query.includes('select digest, response from bp_mutations')) return rows.has(parameters[2]) ? [rows.get(parameters[2])] : [];
      if (query.includes('insert into bp_mutations')) rows.set(parameters[2], { digest: parameters[3], response: JSON.parse(parameters[4]) });
      return [];
    },
    async begin(callback) { return callback(this); },
  };
  const store = createProductStore(database);
  let count = 0;
  const effect = async transaction => {
    assert.equal(transaction, database);
    count += 1;
    return { accepted: true };
  };
  assert.deepEqual(await store.mutate(actor, project.id, 'work', 'same-operation', { a: 1, b: 2 }, effect), { accepted: true });
  assert.deepEqual(await store.mutate(actor, project.id, 'work', 'same-operation', { b: 2, a: 1 }, effect), { accepted: true });
  await assert.rejects(store.mutate(actor, project.id, 'work', 'same-operation', { a: 2 }, effect), error => error.status === 409);
  assert.equal(count, 1);
});

test('mutation replay rechecks nested resource authorization', async () => {
  let allowed = true, effects = 0, row;
  const database = { async begin(callback) { return callback(this); }, async unsafe(query, parameters) {
    if (query.includes('from bp_projects')) return [project];
    if (query.includes('select digest, response from bp_mutations')) return row ? [row] : [];
    if (query.includes('insert into bp_mutations')) row = { digest: parameters[3], response: JSON.parse(parameters[4]) };
    return [];
  } };
  const store = createProductStore(database);
  const authorize = async () => { if (!allowed) throw new Error('conversation access revoked'); };
  const action = async () => { effects++; return { id: 'work' }; };
  assert.deepEqual(await store.mutate(actor, project.id, 'work', 'key', { request: 'x' }, action, authorize), { id: 'work' });
  allowed = false;
  await assert.rejects(store.mutate(actor, project.id, 'work', 'key', { request: 'x' }, action, authorize), /revoked/);
  assert.equal(effects, 1);
});

test('artifact lookup binds project and viewer and filters restricted records in SQL', async () => {
  const database = { unsafe: async (query, parameters) => {
    if (query.includes('from bp_projects')) return [project];
    assert.match(query, /a.project_id = \$1 and a.id = \$2/);
    assert.match(query, /allowed_user_ids is null or \$3 = any/);
    assert.match(query, /join bp_memberships/);
    assert.deepEqual(parameters, [project.id, 'known-foreign-artifact', actor.id, null]);
    return [];
  }, begin: async callback => callback(database) };
  await assert.rejects(createProductStore(database).resolveArtifact(actor, project.id, 'known-foreign-artifact'), error => error.status === 404);
});

test('bot artifact lookup checks conversation, assignment, actor and pinned role grants', async () => {
  const scopedProject = { ...project, blueprintKey: 'swe', blueprintVersion: '1' };
  let type = { id: 'evidence', owner: 'qa', producers: ['qa'], consumers: ['lead'] };
  const database = { async begin(callback) { return callback(this); }, async unsafe(query, parameters) {
    if (query.includes('from bp_conversations')) return [{ projectId: project.id, assignmentId: 'assignment' }];
    if (query.includes('from bp_projects')) return [scopedProject];
    assert.match(query, /allowed_user_ids is null or \$5=any/);
    assert.deepEqual(parameters, ['project-a', 'artifact', 'assignment', 'qa-bot', 'member-a', 'swe', '1', 'revision']);
    return [{ id: 'revision', artifactId: 'artifact', typeKey: 'evidence', payload: { result: 'passed' }, roleKey: 'qa', definition: { business: { artifactTypes: [type] } } }];
  } };
  const store = createProductStore(database);
  const result = await store.resolveBotArtifact(actor, 'channel', 'qa-bot', 'artifact', 'revision');
  assert.equal(result.id, 'revision');
  assert.equal(result.definition, undefined);
  type = { id: 'evidence', owner: 'pm', producers: ['pm'], consumers: ['lead'] };
  await assert.rejects(store.resolveBotArtifact(actor, 'channel', 'qa-bot', 'artifact', 'revision'), error => error.code === 'artifact_not_found');
  database.unsafe = async query => query.includes('from bp_conversations') ? [] : [scopedProject];
  await assert.rejects(store.resolveBotArtifact(actor, 'other-channel', 'qa-bot', 'artifact', 'revision'), error => error.code === 'project_not_found');
});

test('publication requires a publisher and detects changed content even when a supplied digest is reused', async () => {
  const definition = { roles: ['qa'] };
  const input = { key: 'swe', version: '1.0.0', digest: contentDigest(definition), definition };
  const database = { unsafe: async query => query.includes('from bp_blueprint_versions') ? [input] : [], begin: async callback => callback(database) };
  const store = createProductStore(database);
  await assert.rejects(store.registerBlueprint(actor, input), error => error.status === 403);
  await assert.rejects(store.registerBlueprint({ id: 'admin', role: 'admin' }, { ...input, definition: { roles: ['se'] } }), error => error.status === 409);
});

test('native SQL adapter keeps mutations on the transaction client', async () => {
  const calls = [];
  const transaction = { unsafe: async (...args) => { calls.push(args); return [{ ok: true }]; } };
  const native = { unsafe: async () => [], begin: async callback => callback(transaction) };
  const database = productDatabaseFromNative({ $client: native });
  assert.deepEqual(await database.begin(client => client.unsafe('select $1', ['x'])), [{ ok: true }]);
  assert.deepEqual(calls, [['select $1', ['x']]]);
});
