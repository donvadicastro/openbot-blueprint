import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checked, exportOpenBot } from '../dist/src/blueprints.js';
import { validateContract } from '../dist/src/blueprint-contract.js';

test('a distinct service blueprint validates for publication and exports its own team', async t => {
  const path = resolve('test/fixtures/blueprints/distinct-business/blueprint.json');
  const { blueprint } = await checked(path);
  const schema = JSON.parse(await readFile('schemas/blueprint.schema.json', 'utf8'));
  assert.deepEqual(validateContract(blueprint, schema), []);
  assert.deepEqual(blueprint.business.roles.map(role => role.id), ['team-lead', 'coordinator']);
  assert.equal(blueprint.business.workflows[0].id, 'service-request');
  const directory = await mkdtemp(join(tmpdir(), 'service-blueprint-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'tenant');
  await exportOpenBot(path, output);
  const brand = JSON.parse(await readFile(join(output, 'brand.yaml'), 'utf8'));
  const agents = JSON.parse(await readFile(join(output, 'agents.yaml'), 'utf8'));
  assert.equal(brand.tenant.id, 'service-operations');
  assert.deepEqual(agents.agents.map(agent => agent.id), ['team-lead', 'lead']);
});
