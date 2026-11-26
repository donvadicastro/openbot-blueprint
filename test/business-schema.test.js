import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSchema } from '../dist/src/schema.js';

const schema = JSON.parse(await readFile(new URL('../schemas/blueprint.schema.json', import.meta.url), 'utf8'));
const legacy = JSON.parse(await readFile(new URL('../blueprints/software-development/blueprint.json', import.meta.url), 'utf8'));

function business() {
  return {
    teamLeadRole: 'team-lead',
    roles: [{
      id: 'team-lead', agentId: 'team-lead', responsibility: 'Clarify and coordinate the request.',
      actions: ['clarify'], startupChecks: [{ id: 'ready', kind: 'role-ready', description: 'Confirm role readiness.' }],
      viewId: 'work-summary', skills: ['feedback-memory'],
    }],
    artifactTypes: [{
      id: 'request-brief', description: 'The requested outcome and confirmed scope.', owner: 'team-lead',
      producers: ['team-lead'], consumers: ['team-lead'], states: ['draft', 'confirmed'], relationships: [],
      schema: { type: 'object', properties: { outcome: { type: 'string' } }, required: ['outcome'] },
    }],
    initialization: { requiredArtifacts: [], recommendedArtifacts: [], workspace: { kind: 'none' } },
    actions: [{
      id: 'clarify', role: 'team-lead', inputTypes: [], outputTypes: ['request-brief'], prerequisites: [],
      results: [{ status: 'succeeded', requiredOutputTypes: ['request-brief'], requiredEvidence: [] }],
      retry: { maxAttempts: 2, delaySeconds: 1 },
    }],
    workflows: [{
      id: 'discovery', description: 'Clarify a request.', outcomes: ['Understand a requested change'],
      startPhase: 'clarify', terminalPhases: ['done'],
      phases: [{ id: 'clarify', action: 'clarify' }, { id: 'done', terminal: true }],
      transitions: [
        { from: 'clarify', to: 'clarify', when: { status: 'needs-input' } },
        { from: 'clarify', to: 'done', when: { status: 'succeeded' } },
      ],
    }],
    views: [{ id: 'work-summary', role: 'team-lead', recordTypes: ['request-brief'], summaryFields: ['outcome'], detailFields: [], renderer: 'record-card' }],
  };
}

function errors(value) {
  return validateSchema({ ...legacy, business: value }, schema);
}

test('business operating contract is additive and accepts a rework transition', () => {
  assert.deepEqual(validateSchema(legacy, schema), []);
  assert.deepEqual(errors(business()), []);
});

test('business contracts reject incomplete outputs, malformed phases, and undeclared fields', () => {
  for (const change of [
    b => { delete b.actions[0].results; },
    b => { b.actions[0].results[0].status = 'looks-good'; },
    b => { b.workflows[0].phases[0].terminal = true; },
    b => { delete b.workflows[0].phases[1].terminal; },
    b => { b.roles[0].instructions = 'Unstructured extra configuration'; },
    b => { b.roles[0].startupChecks[0] = { id: 'source', description: 'Inspect source.', kind: 'artifact-access' }; },
  ]) {
    const value = business();
    change(value);
    assert.ok(errors(value).length > 0);
  }
});

test('VM workspace requires a provider, verified image identity, and resource configuration', () => {
  const value = business();
  value.initialization.workspace = {
    kind: 'vm', provider: 'lima', image: 'https://example.invalid/guest.img',
    imageDigest: `sha256:${'a'.repeat(64)}`, cpus: 2, memoryMb: 2048, diskGb: 10,
  };
  assert.deepEqual(errors(value), []);
  for (const change of [
    b => { delete b.initialization.workspace.imageDigest; },
    b => { b.initialization.workspace.imageDigest = 'latest'; },
    b => { b.initialization.workspace.memoryMb = 0; },
    b => { b.initialization.workspace.kind = 'container'; },
  ]) {
    const changed = structuredClone(value);
    change(changed);
    assert.ok(errors(changed).length > 0);
  }
});
