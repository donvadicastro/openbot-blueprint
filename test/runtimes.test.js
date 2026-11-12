import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold, load, validate, exportOpenBot } from '../dist/src/blueprints.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'blueprint-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source');
  await scaffold('software-development', source, 'mixed-language');
  const { blueprint } = await load(join(source, 'blueprint.json'));
  return { dir, source, blueprint };
}

test('both language definitions validate and scaffold all declared runtime files', async t => {
  const { dir, source, blueprint } = await fixture(t);
  for (const [id, language, framework, extension, dependencyFile] of [
    ['architect', 'typescript', 'openai-agents', 'ts', 'package.json'],
    ['implementer', 'python', 'langchain', 'py', 'pyproject.toml']
  ]) {
    const base = `bots/${language}`;
    await mkdir(join(source, base), { recursive: true });
    const entrypoint = `${base}/agent.${extension}`;
    const manifest = `${base}/${dependencyFile}`;
    const extra = `${base}/instructions.md`;
    const content = language === 'typescript' ? 'export const createAgent = () => ({fixture: true});\n' : 'def create_agent():\n    return {"fixture": True}\n';
    await writeFile(join(source, entrypoint), content);
    await writeFile(join(source, manifest), language === 'typescript' ? '{"private": true}\n' : '[project]\nname = "fixture"\n');
    await writeFile(join(source, extra), 'Additional packaged instructions\n');
    blueprint.agents.find(agent => agent.id === id).runtime = {
      kind: 'local', language, framework, entrypoint,
      dependencyFile: manifest, exportName: language === 'typescript' ? 'createAgent' : 'create_agent', files: [extra]
    };
  }
  assert.deepEqual(await validate(blueprint, source), []);
  await writeFile(join(source, 'blueprint.json'), JSON.stringify(blueprint));
  const out = join(dir, 'copy');
  await scaffold(join(source, 'blueprint.json'), out, 'copied-project');
  const { blueprint: copied } = await load(join(out, 'blueprint.json'));
  assert.deepEqual(await validate(copied, out), []);
  for (const agent of copied.agents.filter(a => a.runtime.kind === 'local')) {
    for (const path of [agent.runtime.entrypoint, agent.runtime.dependencyFile, ...agent.runtime.files]) {
      assert.equal(await readFile(join(out, path), 'utf8'), await readFile(join(source, path), 'utf8'));
    }
  }
  const rejected = join(dir, 'rejected-export');
  await assert.rejects(exportOpenBot(join(source, 'blueprint.json'), rejected), /Cannot export local bots directly/);
  await assert.rejects(access(rejected), /ENOENT/);
});

test('runtime schema rejects incomplete, mixed and unsupported variants', async t => {
  const { source, blueprint } = await fixture(t);
  for (const runtime of [
    { kind: 'local', language: 'ruby', framework: 'custom' },
    { kind: 'local', language: 'python', framework: 'langchain' },
    { kind: 'remote', protocol: 'unknown', endpointEnv: 'BOT_URL' },
    { kind: 'remote', protocol: 'ag-ui', endpointEnv: 'https://example.com' },
    { kind: 'builtin', language: 'typescript' },
    null
  ]) {
    const b = structuredClone(blueprint);
    b.agents[0].runtime = runtime;
    assert.match((await validate(b, source)).join('\n'), /runtime/);
  }
});

test('local runtime rejects mismatched extensions, missing assets and traversal', async t => {
  const { source, blueprint } = await fixture(t);
  for (const [entrypoint, pattern] of [
    ['prompts/lead.md', /incompatible file extension/],
    ['missing.py', /ENOENT/],
    ['../outside.py', /escapes/]
  ]) {
    const b = structuredClone(blueprint);
    b.agents[0].runtime = { kind: 'local', language: 'python', framework: 'custom', entrypoint, dependencyFile: 'blueprint.json', exportName: 'create_agent' };
    assert.match((await validate(b, source)).join('\n'), pattern);
  }
});

test('remote AG-UI runtimes export endpoints without silently becoming built-in', async t => {
  const { dir, source, blueprint } = await fixture(t);
  blueprint.agents.find(agent => agent.id === 'architect').runtime = { kind: 'remote', protocol: 'ag-ui', endpointEnv: 'ARCHITECT_BOT_URL' };
  await writeFile(join(source, 'blueprint.json'), JSON.stringify(blueprint));
  const out = join(dir, 'tenant');
  await exportOpenBot(join(source, 'blueprint.json'), out);
  const { agents } = JSON.parse(await readFile(join(out, 'agents.yaml'), 'utf8'));
  const remote = agents.find(a => a.id === 'architect');
  assert.equal(remote.type, 'remote-ag-ui');
  assert.equal(remote.endpoint, '${ARCHITECT_BOT_URL}');
  assert.equal(remote.system_prompt, undefined);
  assert.match(await readFile(join(out, '.env.example'), 'utf8'), /ARCHITECT_BOT_URL=/);
});

test('omitted runtimes remain backward compatible with builtin definitions', async t => {
  const { dir, source, blueprint } = await fixture(t);
  blueprint.agents.forEach(agent => delete agent.runtime);
  assert.deepEqual(await validate(blueprint, source), []);
  await writeFile(join(source, 'blueprint.json'), JSON.stringify(blueprint));
  const out = join(dir, 'legacy-tenant');
  await exportOpenBot(join(source, 'blueprint.json'), out);
  const { agents } = JSON.parse(await readFile(join(out, 'agents.yaml'), 'utf8'));
  assert.ok(agents.every(a => a.type === 'built-in'));
});
