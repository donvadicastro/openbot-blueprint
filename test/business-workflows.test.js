import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validate } from '../dist/src/blueprints.js';

for (const name of ['software-development', 'software-development-custom-bot']) {
  test(`${name} defines a discoverable feature workflow with QA rework and approved release`, async () => {
    const base = new URL(`../blueprints/${name}/`, import.meta.url);
    const blueprint = JSON.parse(await readFile(new URL('blueprint.json', base), 'utf8'));
    assert.deepEqual(await validate(blueprint, base.pathname), []);
    const { business } = blueprint;
    assert.deepEqual(JSON.parse(await readFile(new URL('workflows.json', base), 'utf8')), business.workflows);
    assert.ok(business.workflows.some(workflow => workflow.id === 'product-discovery'));
    const feature = business.workflows.find(workflow => workflow.id === 'feature-development');
    const transition = (from, to) => feature.transitions.find(item => item.from === from && item.to === to);
    assert.equal(feature.startPhase, 'clarify');
    assert.equal(transition('verify', 'implement').when.equals, 'failed');
    assert.equal(transition('verify', 'verified').when.decision, 'verify-only');
    assert.equal(transition('verify', 'prepare-release').when.decision, 'ship');
    assert.equal(transition('verify', 'prepare-release').when.equals, 'passed');
    assert.ok(!feature.transitions.some(item => item.from === 'verify' && item.when.equals === 'pending'));
    assert.equal(business.actions.find(action => action.id === 'deploy').approvalRequired, true);
    assert.ok(transition('prepare-release', 'deploy'));
    assert.ok(transition('deploy', 'released'));
  });
}
