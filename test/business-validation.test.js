import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validate } from '../dist/src/blueprints.js';
import { validateContract } from '../dist/src/blueprint-contract.js';

const fixtureDirectory = new URL('../blueprints/software-development/', import.meta.url);
const directory = fileURLToPath(fixtureDirectory);
const legacy = JSON.parse(await readFile(new URL('blueprint.json', fixtureDirectory), 'utf8'));
const contractSchema = JSON.parse(await readFile(new URL('../schemas/blueprint.schema.json', import.meta.url), 'utf8'));

function fixture() {
  const b = structuredClone(legacy);
  b.business = {
    teamLeadRole: 'team-lead',
    roles: [{ id: 'team-lead', agentId: b.entrypoint, responsibility: 'Clarify requests.', actions: ['clarify'], startupChecks: [], viewId: 'brief-view' }],
    artifactTypes: [{
      id: 'brief', description: 'Confirmed request.', owner: 'team-lead', producers: ['team-lead'], consumers: ['team-lead'],
      schema: { type: 'object', properties: { accepted: { type: 'boolean' }, status: { type: 'string', enum: ['ready', 'revise'] } }, required: ['accepted', 'status'], additionalProperties: false },
      states: ['draft', 'confirmed'], relationships: [],
    }],
    initialization: { requiredArtifacts: [], recommendedArtifacts: [], workspace: { kind: 'none' } },
    actions: [{ id: 'clarify', role: 'team-lead', inputTypes: [], outputTypes: ['brief'], prerequisites: [], results: [
      { status: 'succeeded', requiredOutputTypes: ['brief'], requiredEvidence: ['confirmed-scope'] },
      { status: 'needs-input', requiredOutputTypes: [], requiredEvidence: [] },
    ], retry: { maxAttempts: 1, delaySeconds: 0 } }],
    workflows: [{ id: 'discovery', description: 'Clarify a request.', outcomes: ['Discover scope'], startPhase: 'clarify', terminalPhases: ['done'], phases: [{ id: 'clarify', action: 'clarify' }, { id: 'done', terminal: true }], transitions: [
      { from: 'clarify', to: 'clarify', when: { status: 'needs-input' } },
      { from: 'clarify', to: 'done', when: { status: 'succeeded' } },
    ] }],
    views: [{ id: 'brief-view', role: 'team-lead', recordTypes: ['brief'], summaryFields: ['status'], detailFields: ['accepted'], renderer: 'record-card' }],
  };
  return b;
}

async function rejected(change, match) {
  const b = fixture();
  change(b.business, b);
  const errors = await validate(b, directory);
  assert.ok(errors.some(error => match.test(error)), errors.join('\n'));
}

test('business validation accepts a declared rework cycle and local data schema definitions', async () => {
  const b = fixture();
  b.business.artifactTypes[0].schema = {
    type: 'object', properties: { accepted: { $ref: '#/$defs/flag' } }, required: ['accepted'],
    $defs: { flag: { type: 'boolean' } },
  };
  assert.deepEqual(await validate(b, directory), []);
});

test('business validation rejects unresolved roles, actions, types, and Team Lead bindings', async () => {
  await rejected(b => { b.teamLeadRole = 'unknown'; }, /Team Lead/);
  await rejected((b, bp) => { b.roles[0].agentId = bp.agents.find(a => a.id !== bp.entrypoint).id; }, /Team Lead.*entrypoint/);
  await rejected(b => { b.roles[0].actions.push('unknown'); }, /action.*missing owner/);
  await rejected(b => { b.actions[0].role = 'unknown'; }, /not assigned/);
  await rejected(b => { b.actions[0].inputTypes.push('unknown'); }, /unknown artifact type/);
  await rejected(b => { b.artifactTypes[0].relationships.push({ field: 'source', targetType: 'unknown', many: false }); }, /relationship type/);
  await rejected(b => { b.initialization.requiredArtifacts.push('unknown'); }, /initialization.*unknown artifact/);
  await rejected(b => { b.artifactTypes[0].producers = []; }, /cannot produce/);
  await rejected(b => { b.actions[0].inputTypes = ['brief']; b.artifactTypes[0].consumers = []; }, /cannot consume/);
  await rejected(b => { b.views[0].role = 'unknown'; }, /view.*unknown role/);
});

test('a startup artifact check requires its role to have declared artifact access', () => {
  const blueprint = structuredClone(legacy);
  const source = blueprint.business.artifactTypes.find(type => type.id === 'source-code');
  source.consumers = source.consumers.filter(role => role !== 'qa');
  assert.ok(validateContract(blueprint, contractSchema).some(error => /qa startup check lacks access to source-code/.test(error)));
});

test('business workflow rejects unreachable phases and overlapping guards', async () => {
  await rejected(b => { b.workflows[0].phases.push({ id: 'unused', action: 'clarify' }); }, /unreachable/);
  await rejected(b => { b.workflows[0].transitions.push({ from: 'clarify', to: 'clarify', when: { status: 'succeeded' } }); }, /overlapping/);
  await rejected(b => { b.workflows[0].transitions[1].to = 'missing'; }, /unknown phase/);
  await rejected(b => { b.workflows[0].transitions[1].when.status = 'failed'; }, /undeclared result status/);
});

test('business workflow guards reference a declared output and its field', async () => {
  const b = fixture();
  b.business.workflows[0].transitions = [
    { from: 'clarify', to: 'clarify', when: { status: 'needs-input' } },
    { from: 'clarify', to: 'done', when: { status: 'succeeded', recordType: 'brief', field: 'status', equals: 'ready' } },
    { from: 'clarify', to: 'clarify', when: { status: 'succeeded', recordType: 'brief', field: 'status', equals: 'revise' } },
  ];
  assert.deepEqual(await validate(b, directory), []);
  await rejected(b => { b.workflows[0].transitions[1].when.recordType = 'unknown'; }, /condition.*record type/);
  await rejected(b => { Object.assign(b.workflows[0].transitions[1].when, { recordType: 'brief', field: 'missing', equals: 'ready' }); }, /condition.*field/);
});

test('embedded schemas reject malformed definitions, dangling references, and unsupported assertions', async () => {
  for (const schema of [
    { type: 'object', properties: { field: { $ref: '#/$defs/missing' } } },
    { type: 'object', properties: { field: { type: 'unknown' } } },
    { type: 'object', properties: { field: { pattern: '[' } } },
    { type: 'object', required: 'field' },
    { type: ['object'] },
    { type: 'object', properties: { field: { type: 'string', format: 'email' } } },
    { type: 'object', properties: { field: { enum: [{ value: true }] } } },
    { $defs: { one: { $ref: '#/$defs/two' }, two: { $ref: '#/$defs/one' } }, $ref: '#/$defs/one' },
  ]) {
    await rejected(b => { b.artifactTypes[0].schema = schema; }, /schema/);
  }
});


test('CLI and native publication share legacy semantic validation', async () => {
  for (const change of [
    b => { b.agents[0].tools.push('unknown-tool'); },
    b => { b.agents[0].resources.push('unknown-resource'); },
    b => { b.agents[0].environment = 'unknown-environment'; },
    b => { b.connections[0].to = 'unknown-agent'; },
    b => { b.agents.push(structuredClone(b.agents[0])); },
    b => { b.qualityGates[0].owner = 'unknown-agent'; },
  ]) {
    const value = fixture();
    change(value);
    const pureErrors = validateContract(value, contractSchema);
    assert.ok(pureErrors.length > 0);
    assert.deepEqual(await validate(value, directory), pureErrors);
  }
});
