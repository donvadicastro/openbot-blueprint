import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'openbot-routing-test-'));
const source = join(directory, 'source');
await mkdir(join(source, 'contract'), { recursive: true });
await writeFile(join(source, 'package.json'), '{"type":"module"}');
for (const name of ['workflow-routing.ts', 'workflow-inputs.ts', 'access.ts', 'store.ts', 'readiness-gate.ts', 'workspace.ts']) await copyFile(resolve('deploy/openbot/product', name), join(source, name));
for (const name of ['blueprint-contract.ts', 'business.ts', 'schema.ts', 'types.ts', 'readiness.ts']) await copyFile(resolve('src', name), join(source, 'contract', name));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', source, '--outDir', join(directory, 'out'), join(source, 'workflow-routing.ts')], { stdio: 'pipe' });
await writeFile(join(directory, 'out', 'package.json'), '{"type":"module"}');
const { selectWorkflow, saveWorkflowSelection } = await import(pathToFileURL(join(directory, 'out', 'workflow-routing.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));
const blueprint = JSON.parse(await readFile('blueprints/software-development/blueprint.json', 'utf8'));
const schema = JSON.parse(await readFile('schemas/blueprint.schema.json', 'utf8'));

test('workflow routing prefers a known interpretation and holds ambiguous requests', () => {
  const published = blueprint.business.workflows[0];
  assert.equal(selectWorkflow(blueprint, schema, { workflowId: published.id }).workflow.id, published.id);
  assert.equal(selectWorkflow(blueprint, schema, { needsClarification: 'Which outcome?' }).status, 'needs-input');
  assert.throws(() => selectWorkflow(blueprint, schema, { workflowId: 'missing' }), error => error.code === 'unknown_workflow');
});

test('malformed workflow interpretations produce a structured validation error', () => {
  for (const interpretation of [{ needsClarification: 42 }, { workflowId: {} }, { needsClarification: '' },
    { needsClarification: 'x'.repeat(4001) }, { needsClarification: 'a\0b' }, { workflowId: 'x'.repeat(201) }, { workflowId: 'x\0y' },
    { workflowId: 'first', needsClarification: 'Which one?' }, { workflowId: 'first', unexpected: true }, {}, null, []]) {
    assert.throws(() => selectWorkflow(blueprint, schema, interpretation), error => error.status === 422 && error.code === 'invalid_workflow_interpretation');
  }
});

test('temporary workflows require guidance and obey published contract validation', () => {
  const workflow = structuredClone(blueprint.business.workflows[0]);
  const selected = selectWorkflow(blueprint, schema, { temporary: { workflow, rationale: 'A focused request', guidance: ['internal-guide'] } });
  assert.equal(selected.temporary, true);
  assert.equal(selected.digest.length, 64);
  assert.throws(() => selectWorkflow(blueprint, schema, { temporary: { workflow, rationale: 'Reason', guidance: [] } }), error => error.code === 'workflow_guidance_required');
  assert.throws(() => selectWorkflow(blueprint, schema, { temporary: { workflow, rationale: 'x'.repeat(4001), guidance: ['guide'] } }), error => error.code === 'workflow_guidance_required');
  assert.throws(() => selectWorkflow(blueprint, schema, { temporary: { workflow, rationale: 'Reason', guidance: Array(51).fill('guide') } }), error => error.code === 'workflow_guidance_required');
  assert.throws(() => selectWorkflow(blueprint, schema, { temporary: { workflow, rationale: 'Reason', guidance: ['x'.repeat(2001)] } }), error => error.code === 'workflow_guidance_required');
  assert.throws(() => selectWorkflow(blueprint, schema, { temporary: { workflow, rationale: 'Reason', guidance: ['a\0b'] } }), error => error.code === 'workflow_guidance_required');
  workflow.startPhase = 'missing';
  assert.throws(() => selectWorkflow(blueprint, schema, { temporary: { workflow, rationale: 'Reason', guidance: ['guide'] } }), error => error.code === 'invalid_workflow');
});

test('temporary SWE releases use the supported staging gate', () => {
  const workflow = structuredClone(blueprint.business.workflows.find(item => item.id === 'feature-development'));
  const choose = workflow => selectWorkflow(blueprint, schema, { temporary: { workflow, rationale: 'A focused delivery', guidance: ['engineering guide'] } });
  assert.equal(choose(workflow).temporary, true);
  const wrongPhase = structuredClone(workflow);
  wrongPhase.phases.find(phase => phase.id === 'deploy').action = 'prepare-release';
  wrongPhase.phases.find(phase => phase.id === 'prepare-release').action = 'deploy';
  assert.throws(() => choose(wrongPhase), error => ['release_gate_unavailable', 'invalid_workflow'].includes(error.code));
  const bypass = structuredClone(workflow);
  bypass.transitions.push({ from: 'verify', to: 'deploy', when: { status: 'succeeded' } });
  assert.throws(() => choose(bypass), error => ['release_gate_unavailable', 'invalid_workflow'].includes(error.code));
  const unsupported = structuredClone(blueprint);
  unsupported.business.actions.find(action => action.id === 'implement').approvalRequired = true;
  assert.throws(() => selectWorkflow(unsupported, schema, { temporary: { workflow, rationale: 'Delivery', guidance: ['guide'] } }),
    error => ['release_gate_unavailable', 'invalid_workflow'].includes(error.code));
});

test('saving a selection requires project and conversation access and pins the plan', async () => {
  const writes = [];
  let allowed = true;
  let readiness = 'Ready';
  let assigned = true;
  const transaction = { async unsafe(sql, values) {
    if (sql.includes('from bp_conversations')) return allowed ? [{ id: 'channel' }] : [];
    if (sql.includes('join bp_readiness')) return blueprint.business.roles.map(role => ({ roleKey: role.id, revision: 1, reportedRevision: 1, status: readiness }));
    if (sql.includes('from bp_assignments')) {
      const action = blueprint.business.actions.find(item => item.id === blueprint.business.workflows[0].phases.find(phase => phase.id === blueprint.business.workflows[0].startPhase).action);
      assert.equal(values[2], blueprint.business.roles.find(role => role.id === action.role).agentId);
      return assigned ? [{ id: 'assignment' }] : [];
    }
    writes.push({ sql, values }); return [];
  } };
  const project = { id: 'project', state: 'Operational', blueprintKey: blueprint.id, blueprintVersion: blueprint.version };
  const definition = structuredClone(blueprint);
  definition.business.initialization.workspace = { kind: 'none' };
  const module = { store: { async mutate(_actor, _project, _permission, _key, _payload, action, authorize) { await authorize(transaction, project); return action(transaction, project); } }, async definitionFor() { return definition; } };
  const input = { channelId: 'channel', request: 'Help with the product', interpretation: { workflowId: blueprint.business.workflows[0].id } };
  await assert.rejects(saveWorkflowSelection(module, { id: 'owner', role: 'user' }, 'project', { ...input, request: 'x'.repeat(20001) }, 'oversized', schema), error => error.code === 'invalid_request');
  await assert.rejects(saveWorkflowSelection(module, { id: 'owner', role: 'user' }, 'project', { ...input, request: 'a\0b' }, 'nul', schema), error => error.code === 'invalid_request');
  assert.equal(writes.length, 0);
  let bindingChecks = 0;
  const result = await saveWorkflowSelection(module, { id: 'owner', role: 'user' }, 'project', input, 'stable', schema, async tx => {
    assert.equal(tx, transaction); bindingChecks++;
  });
  assert.equal(bindingChecks, 1);
  assert.equal(result.status, 'saved');
  assert.equal(writes.length, 5);
  await assert.rejects(saveWorkflowSelection(module, { id: 'owner', role: 'user' }, 'project', input, 'revoked-binding', schema,
    async () => { throw new Error('binding revoked'); }), /binding revoked/);
  assert.equal(writes.length, 5);
  assert.match(writes[1].sql, /'Pending'/);
  assert.equal(JSON.parse(writes[1].values[7]).workflow.id, input.interpretation.workflowId);
  assert.equal(writes[2].values[6], `${result.runId}:1`);
  assert.equal(writes[4].values[3], `${result.runId}:1`);
  readiness = 'Blocked';
  await assert.rejects(saveWorkflowSelection(module, { id: 'owner', role: 'user' }, 'project', input, 'blocked', schema), error => error.code === 'readiness_stale');
  assert.equal(writes.length, 5);
  readiness = 'Ready';
  assigned = false;
  await assert.rejects(saveWorkflowSelection(module, { id: 'owner', role: 'user' }, 'project', input, 'unassigned', schema), error => error.code === 'assignment_unavailable');
  assert.equal(writes.length, 5);
  assigned = true;
  allowed = false;
  await assert.rejects(saveWorkflowSelection(module, { id: 'owner', role: 'user' }, 'project', input, 'other', schema), error => error.code === 'conversation_not_found');
  allowed = true;
  project.state = 'Initializing';
  await assert.rejects(saveWorkflowSelection(module, { id: 'owner', role: 'user' }, 'project', input, 'third', schema), error => error.code === 'project_not_operational');
});
