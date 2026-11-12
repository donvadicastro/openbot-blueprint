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
for (const name of ['workflow-routing.ts', 'access.ts', 'store.ts']) await copyFile(resolve('deploy/openbot/product', name), join(source, name));
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

test('temporary workflows require guidance and obey published contract validation', () => {
  const workflow = structuredClone(blueprint.business.workflows[0]);
  const selected = selectWorkflow(blueprint, schema, { temporary: { workflow, rationale: 'A focused request', guidance: ['internal-guide'] } });
  assert.equal(selected.temporary, true);
  assert.equal(selected.digest.length, 64);
  assert.throws(() => selectWorkflow(blueprint, schema, { temporary: { workflow, rationale: 'Reason', guidance: [] } }), error => error.code === 'workflow_guidance_required');
  workflow.startPhase = 'missing';
  assert.throws(() => selectWorkflow(blueprint, schema, { temporary: { workflow, rationale: 'Reason', guidance: ['guide'] } }), error => error.code === 'invalid_workflow');
});

test('saving a selection requires project and conversation access and pins the plan', async () => {
  const writes = [];
  let allowed = true;
  const transaction = { async unsafe(sql, values) {
    if (sql.includes('from bp_conversations')) return allowed ? [{ id: 'channel' }] : [];
    if (sql.includes('from bp_assignments')) return [{ id: 'assignment' }];
    writes.push({ sql, values }); return [];
  } };
  const project = { id: 'project', state: 'Operational', blueprintKey: blueprint.id, blueprintVersion: blueprint.version };
  const module = { store: { async mutate(_actor, _project, _permission, _key, _payload, action) { return action(transaction, project); } }, async definitionFor() { return blueprint; } };
  const input = { channelId: 'channel', request: 'Help with the product', interpretation: { workflowId: blueprint.business.workflows[0].id } };
  const result = await saveWorkflowSelection(module, { id: 'owner', role: 'user' }, 'project', input, 'stable', schema);
  assert.equal(result.status, 'saved');
  assert.equal(writes.length, 5);
  assert.match(writes[1].sql, /'Pending'/);
  assert.equal(JSON.parse(writes[1].values[7]).workflow.id, input.interpretation.workflowId);
  assert.equal(writes[2].values[6], `${result.runId}:1`);
  assert.equal(writes[4].values[3], `${result.runId}:1`);
  allowed = false;
  await assert.rejects(saveWorkflowSelection(module, { id: 'owner', role: 'user' }, 'project', input, 'other', schema), error => error.code === 'conversation_not_found');
  project.state = 'Initializing';
  await assert.rejects(saveWorkflowSelection(module, { id: 'owner', role: 'user' }, 'project', input, 'third', schema), error => error.code === 'project_not_operational');
});
