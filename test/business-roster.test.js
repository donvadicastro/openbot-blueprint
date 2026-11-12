import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSchema } from '../dist/src/schema.js';

for (const name of ['software-development', 'software-development-custom-bot']) {
  test(`${name} declares the operational roster and structured QA evidence`, async () => {
    const base = new URL(`../blueprints/${name}/`, import.meta.url);
    const blueprint = JSON.parse(await readFile(new URL('blueprint.json', base), 'utf8'));
    const business = blueprint.business;
    assert.deepEqual(business.roles.map(role => role.id), ['team-lead', 'pm', 'engineer', 'qa', 'release']);
    assert.equal(business.teamLeadRole, 'team-lead');
    assert.deepEqual(business.initialization.requiredArtifacts, ['source-code']);
    assert.deepEqual(business.initialization.recommendedArtifacts, [
      'ci-cd', 'test-environment', 'live-environment', 'documentation', 'requirements',
    ]);
    for (const role of business.roles) {
      assert.ok(blueprint.agents.some(agent => agent.id === role.agentId));
      assert.ok(business.views.some(view => view.id === role.viewId && view.role === role.id));
      assert.ok(role.startupChecks.some(check => check.kind === 'role-ready'));
    }
    const source = business.artifactTypes.find(type => type.id === 'source-code');
    for (const role of business.roles.filter(item => item.startupChecks.some(check => check.kind === 'artifact-access' && check.artifactType === source.id))) {
      assert.ok([source.owner, ...source.consumers, ...source.producers].includes(role.id));
      assert.ok(blueprint.agents.find(agent => agent.id === role.agentId).tools.includes('repository-read'));
    }
    const qa = business.artifactTypes.find(type => type.id === 'qa-evidence');
    const evidence = {
      candidateRevision: 'candidate-1', briefRevision: 'brief-1', planRevision: 'plan-1',
      environment: 'project-vm', verdict: 'passed', passPercentage: 100,
      results: [{ id: 'scenario-1', status: 'passed', observed: 'OK', evidence: ['logs/1'] }],
    };
    assert.deepEqual(validateSchema(evidence, qa.schema), []);
    assert.ok(validateSchema({ ...evidence, results: [{ id: 'scenario-1', status: 'unknown' }] }, qa.schema).length);
    assert.ok(validateSchema({ ...evidence, planRevision: undefined }, qa.schema).length);
    assert.deepEqual(JSON.parse(await readFile(new URL('artifacts.json', base), 'utf8')), business.artifactTypes);
  });
}
