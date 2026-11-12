import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checked, validate, scaffold, exportOpenBot, readAsset, root, createOutput } from '../dist/src/blueprints.js';
import { handoffReadinessError } from '../dist/src/readiness.js';
import { setupQuestions, validateSetup } from '../dist/src/setup-form.js';

const { blueprint, path } = await checked('software-development');
const directory = dirname(path);
const copy = () => structuredClone(blueprint);
async function temp(t) {
  const path = await mkdtemp(join(tmpdir(), 'blueprint-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
test('catalog baseline is valid and keeps optional specialists outside the core workflow', async () => {
  assert.deepEqual(await validate(blueprint, directory), []);
  assert.equal(blueprint.agents.filter(a => a.tier === 'core').length, 8);
  assert.equal(blueprint.agents.filter(a => a.tier === 'optional').length, 4);
});
test('schema rejects malformed nested definitions before semantic traversal', async () => {
  for (const mutate of [b => b.agents = null, b => b.agents[0].tools = 'everything', b => b.executionPolicy.maxConcurrentAgents = 0, b => b.workflow[0].typo = true]) {
    const b = copy(); mutate(b);
    assert.ok((await validate(b, directory)).length);
  }
});
test('unknown references, duplicate IDs, unreachable specialists and missing prompts fail', async () => {
  for (const [mutate, pattern] of [
    [b => b.agents[0].tools.push('unknown'), /unknown tools/],
    [b => b.agents.push({ ...b.agents[0], name: 'Duplicate lead' }), /duplicate id/],
    [b => b.connections = b.connections.filter(c => c.to !== 'qa'), /unreachable/],
    [b => b.agents[0].prompt = 'missing.md', /ENOENT/],
    [b => b.intake.handoffTo = 'architect', /intake.handoffTo must be a connected core agent/],
    [b => b.agents.find(agent => agent.id === 'lead').readiness.push(b.agents.find(agent => agent.id === 'lead').readiness[0]), /duplicate readiness field ID/],
    [b => delete b.agents.find(a => a.tier === 'optional').activateWhen, /activateWhen/],
    [b => b.entrypoint = 'security', /entrypoint must be a core/]
  ]) {
    const b = copy(); mutate(b);
    assert.match((await validate(b, directory)).join('\n'), pattern);
  }
});
test('workflow cycles, optional owners and unaccountable gates fail', async () => {
  for (const [mutate, pattern] of [
    [b => b.workflow[0].dependsOn = ['deliver'], /dependency cycle/],
    [b => b.workflow[0].owner = 'security', /owner must be core/],
    [b => b.qualityGates[0].owner = 'qa', /owner must own/],
    [b => b.workflow[0].gates = [], /requires a quality gate/]
  ]) {
    const b = copy(); mutate(b);
    assert.match((await validate(b, directory)).join('\n'), pattern);
  }
});
test('assets cannot escape through traversal or symlinks', async t => {
  const dir = await temp(t);
  const secret = join(dir, 'secret');
  await writeFile(secret, 'do not copy');
  await symlink(secret, join(directory, 'test-escape-link'));
  t.after(() => rm(join(directory, 'test-escape-link'), { force: true }));
  await assert.rejects(readAsset(directory, 'test-escape-link'), /escapes/);
  await assert.rejects(readAsset(directory, '../../package.json'), /escapes/);
  await assert.rejects(readAsset(directory, secret), /relative/);
});
test('scaffold is portable, validates, and refuses overwrites and invalid IDs', async t => {
  const dir = await temp(t), out = join(dir, 'my-project');
  await scaffold('software-development', out, 'my-project');
  const b = JSON.parse(await readFile(join(out, 'blueprint.json')));
  assert.equal(b.id, 'my-project');
  assert.equal(b.$schema, './blueprint.schema.json');
  assert.ok(JSON.parse(await readFile(join(out, 'blueprint.schema.json'))).$defs.agent);
  assert.deepEqual(await validate(b, out), []);
  await assert.rejects(scaffold('software-development', out, 'my-project'), /EEXIST/);
  await assert.rejects(scaffold('software-development', join(dir, 'invalid'), '../bad'), /kebab-case/);
  await assert.rejects(createOutput(join(directory, 'new-output'), [directory]), /outside/);
});
test('OpenBot export emits required tenant files, embeds prompts and explains runtime gaps', async t => {
  const dir = await temp(t);
  for (const includeOptional of [false, true]) {
    const out = join(dir, String(includeOptional));
    await exportOpenBot('software-development', out, includeOptional);
    for (const name of ['brand', 'agents', 'channels', 'model', 'knowledge']) {
      assert.ok(JSON.parse(await readFile(join(out, name + '.yaml'))));
    }
    const { agents } = JSON.parse(await readFile(join(out, 'agents.yaml')));
    assert.equal(agents.length, includeOptional ? 12 : 9);
    assert.ok(agents.some(agent => agent.id === "operations"));
    assert.ok(agents.every(a => a.type === 'built-in' && a.system_prompt.length > 100));
    const exported = JSON.parse(await readFile(join(out, 'blueprint.json')));
    assert.equal(exported.entrypoint, 'team-lead');
    assert.equal(exported.intake.handoffTo, 'lead');
    assert.equal(exported.intake.form, true);
    assert.ok(agents.some(agent => agent.id === exported.entrypoint && agent.name === 'Team Lead'));
    const lead = agents.find(agent => agent.id === exported.entrypoint);
    assert.match(lead.system_prompt, /project.*intake/);
    assert.match(lead.system_prompt, /source-access.*assignment/);
    assert.equal(lead.system_prompt.includes('document-source'), includeOptional);
    const { channels } = JSON.parse(await readFile(join(out, 'channels.yaml')));
    assert.deepEqual(channels[0].permitted_agents, agents.map(a => a.id));
    assert.match(await readFile(join(out, 'INTEGRATION.md'), 'utf8'), /Prompts alone do not enforce/);
  }
});
test('handoff readiness requires named values for the recipient', () => {
  const { readiness } = blueprint.agents.find(agent => agent.id === 'implementer');
  const values = Object.fromEntries(readiness.map(({ id }) => [id, 'supplied value']));
  assert.equal(handoffReadinessError(readiness, JSON.stringify(values)), undefined);
  assert.match(handoffReadinessError(readiness, 'a plain text brief'), /JSON object/);
  assert.match(handoffReadinessError(readiness, JSON.stringify({ ...values, 'source-access': 'pending' })), /source-access/);
  delete values.project;
  assert.match(handoffReadinessError(readiness, JSON.stringify(values)), /project/);
  assert.equal(handoffReadinessError(undefined, 'a plain text brief'), undefined);
});
test('setup requires a project folder or a GitHub repository URL before discovery', () => {
  const coreFields = blueprint.agents.filter(agent => agent.tier === 'core').flatMap(agent => agent.readiness ?? []);
  const form = { questions: setupQuestions(coreFields) };
  assert.deepEqual(form.questions.map(question => question.id), ['project']);
  assert.deepEqual(validateSetup(form, { answers: {} }).missing, ['project']);
  assert.deepEqual(validateSetup(form, { answers: { project: 'a project description' } }).missing, ['project']);
  const result = validateSetup(form, { answers: { project: '/workspace/project', 'document-source': 'API v2' } });
  assert.deepEqual(result.value, { answers: { project: '/workspace/project' } });
  const github = { project: 'https://github.com/example/project.git' };
  assert.deepEqual(validateSetup(form, { answers: github }).value, { answers: github });
  for (const project of ['https://github.com/example', 'https://github.com/example/project/issues', 'https://github.com.example.org/example/project']) {
    assert.deepEqual(validateSetup(form, { answers: { project } }).missing, ['project']);
  }
});
test('CLI reports errors with nonzero status and supports custom files', async t => {
  const dir = await temp(t);
  const invalid = join(dir, 'invalid.json');
  await writeFile(invalid, '{');
  for (const args of [['validate', invalid], ['oops'], ['export-openbot', 'software-development', dir, '--unknown']]) {
    const result = spawnSync(process.execPath, [join(root, 'dist/bin/blueprint.js'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.trim());
  }
  const result = spawnSync(process.execPath, [join(root, 'dist/bin/blueprint.js'), 'validate', path], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Valid/);
});
