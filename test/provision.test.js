import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionOpenBot } from '../dist/bin/openbot-compose.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'blueprint-provision-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const envFile = join(directory, '.env');
  await writeFile(envFile, [
    'BOT_PROVIDER=openai', 'BOT_MODEL=test-model', 'OPENAI_API_KEY=private-test-secret',
    'CPK_INTELLIGENCE_API_KEY=private-intelligence-secret',
    'INTELLIGENCE_API_URL=https://example.com', 'INTELLIGENCE_GATEWAY_WS_URL=wss://example.com',
    `KEY_ENCRYPTION_KEY=${Buffer.alloc(32, 1).toString('base64')}`,
    `COMPUTER_TOKEN=${'a'.repeat(40)}`, `SUPERVISOR_TOKEN=${'b'.repeat(40)}`,
    `AGENT_TOOL_TOKEN=${'c'.repeat(40)}`, `WORKER_SHARED_SECRET=${'d'.repeat(40)}`,
    `MANAGED_AGENT_TOKEN=${'e'.repeat(40)}`, 'OPENBOT_SINGLE_USER=true',
    `WORKFLOW_POSTGRES_PASSWORD=${'f'.repeat(40)}`, `WORKFLOW_ACTIVITY_TOKEN=${'g'.repeat(40)}`,
    `WORKFLOW_ENGINE_TOKEN=${'h'.repeat(40)}`,
  ].join('\n'));
  return {directory, envFile, stateDirectory: join(directory, 'registry')};
}

test('provision serializes duplicate requests and retains blueprint identity across versions', async t => {
  const f = await fixture(t);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const calls = [];
  const run = async (args, env) => {
    calls.push({args,env});
    if (args.includes('up')) { entered(); await held; }
  };
  const first = provisionOpenBot('software-development', f, run, {});
  await started;
  const duplicate = await provisionOpenBot('software-development', f, run, {});
  assert.equal(duplicate.existing, true);
  assert.equal(duplicate.binding.state, 'provisioning');
  assert.equal(calls.length, 2);
  release();
  const initial = await first;
  assert.equal(initial.binding.state, 'ready');
  assert.equal(initial.binding.composeProject, duplicate.binding.composeProject);
  assert.equal(calls[0].args.at(-1), '--quiet');
  assert.equal(calls[0].args.some(value => value.endsWith('/deploy/workflow/compose.yml')), false);
  assert.equal(calls[1].env.COMPOSE_PROJECT_NAME, initial.binding.composeProject);
  assert.ok(calls[1].args.includes('--wait'));
  assert.ok(calls[1].args.includes('--wait-timeout'));
  assert.equal(calls[1].env.COMPUTER_NAMESPACE, initial.binding.composeProject);
  assert.equal(calls[1].env.OPENBOT_ENV_FILE, f.envFile);
  assert.equal(calls[1].env.IMPLEMENTER_ENV_FILE, join(f.directory, '.env.implementer'));
  const registryFile = join(f.stateDirectory,'installations.json');
  const registry = JSON.parse(await readFile(registryFile,'utf8'));
  registry[0].blueprintVersion = '0.0.1';
  await writeFile(registryFile,JSON.stringify(registry));
  const differentVersion = await provisionOpenBot('software-development', f, run, {});
  assert.equal(differentVersion.existing,true);
  assert.equal(calls.length,2);
  assert.equal(differentVersion.binding.composeProject,initial.binding.composeProject);
  assert.doesNotMatch(await readFile(registryFile,'utf8'), /private-test-secret|private-intelligence-secret|aaaaaaa/);
});

test('workflow credentials are checked before provisioning without exposing them', async t => {
  const f = await fixture(t);
  let called = false;
  await assert.rejects(provisionOpenBot('software-development', f, async () => { called = true; }, {
    WORKFLOW_ENGINE_TOKEN: 'short-secret', WORKFLOW_ACTIVITY_TOKEN: 'short-secret', WORKFLOW_POSTGRES_PASSWORD: '',
  }), error => {
    assert.match(error.message, /WORKFLOW_POSTGRES_PASSWORD/);
    assert.match(error.message, /WORKFLOW_ENGINE_TOKEN/);
    assert.match(error.message, /distinct/);
    assert.doesNotMatch(error.message, /short-secret/);
    return true;
  });
  assert.equal(called, false);
});

test('workflow tokens cannot reuse native service credentials', async t => {
  const f = await fixture(t);
  let called = false;
  await assert.rejects(provisionOpenBot('software-development', f, async () => { called = true; }, {
    WORKFLOW_ENGINE_TOKEN: 'a'.repeat(40),
  }), error => {
    assert.match(error.message, /distinct/);
    assert.doesNotMatch(error.message, /a{40}/);
    return true;
  });
  assert.equal(called, false);
});

test('provisioning keeps a failed binding when workflow health does not become ready', async t => {
  const f = await fixture(t);
  const calls = [];
  await assert.rejects(provisionOpenBot('software-development', f, async args => {
    calls.push(args);
    if (args.includes('up')) throw new Error('health check failed');
  }, {}), /health check failed/);
  assert.ok(calls[1].includes('--wait'));
  const registry = JSON.parse(await readFile(join(f.stateDirectory, 'installations.json'), 'utf8'));
  assert.equal(registry[0].state, 'failed');
  const retried = await provisionOpenBot('software-development', f, async () => {}, {});
  assert.equal(retried.binding.composeProject, registry[0].composeProject);
  assert.equal(retried.binding.state, 'ready');
});

test('different blueprints reserve different ports and failed provisioning retries the original binding', async t => {
  const f = await fixture(t);
  const calls=[];
  const run=async(args,env)=>{calls.push({args,env});};
  const first=await provisionOpenBot('software-development',f,run,{});
  const second=await provisionOpenBot('software-development-custom-bot',f,run,{});
  assert.notEqual(first.binding.composeProject,second.binding.composeProject);
  assert.equal(first.binding.appPort,3010);
  assert.equal(second.binding.appPort,3011);
  await assert.rejects(provisionOpenBot('software-development', {...f,appPort:3012},run,{}),/different app port/);
  const otherState=join(f.directory,'failure');
  await assert.rejects(provisionOpenBot('software-development',{...f,stateDirectory:otherState},async()=>{throw Error('failed probe');},{}),/failed probe/);
  const failed=JSON.parse(await readFile(join(otherState,'installations.json'),'utf8'))[0];
  assert.equal(failed.state,'failed');
  const retried=await provisionOpenBot('software-development',{...f,stateDirectory:otherState},run,{});
  assert.equal(retried.existing,true);
  assert.equal(retried.binding.state,'ready');
  assert.equal(retried.binding.composeProject,failed.composeProject);
  assert.equal(retried.binding.appPort,failed.appPort);
});

test('native credential validation fails before provisioning and registry does not store credentials', async t => {
  const f=await fixture(t);
  await writeFile(f.envFile,'BOT_PROVIDER=openai\nBOT_MODEL=test-model\nOPENAI_API_KEY=private-test-secret\n');
  let called=false;
  await assert.rejects(provisionOpenBot('software-development',f,async()=>{called=true;},{}),error=>{
    assert.match(error.message,/OpenBot startup blocked/);
    assert.doesNotMatch(error.message,/private-test-secret/);
    return true;
  });
  assert.equal(called,false);
});

test('provision adopts a matching legacy installation after verifying its exported blueprint', async t => {
  const fixtureData = await fixture(t);
  await writeFile(fixtureData.envFile, '\nCOMPOSE_PROJECT_NAME=openbot-blueprint\n', { flag: 'a' });
  const calls = [];
  const run = async (args, env) => {
    calls.push({ args, env });
    if (args.includes('ls')) {
      return JSON.stringify([{ Name: 'openbot-blueprint', ConfigFiles: join(process.cwd(), 'docker-compose.yml') }]);
    }
    if (args.includes('exec')) return JSON.stringify({ id: 'software-development' });
  };
  const result = await provisionOpenBot('software-development', fixtureData, run, {});
  assert.equal(result.binding.composeProject, 'openbot-blueprint');
  assert.equal(calls.find(call => call.args.includes('up')).env.COMPOSE_PROJECT_NAME, 'openbot-blueprint');
});

test('provision recovers a transaction claim left by a killed owner', async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { mkdir, readdir } = await import('node:fs/promises');
  const fixtureData = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000);']);
  await once(child.stdout, 'data');
  const locks = join(fixtureData.stateDirectory, '.lock');
  await mkdir(locks, { recursive: true });
  const claimName = `${child.pid}-01234567-89ab-cdef-0123-456789abcdef.json`;
  await writeFile(join(locks, claimName), JSON.stringify({ choosing: true, ticket: 0 }));
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const result = await provisionOpenBot('software-development', fixtureData, async () => {}, {});
  assert.equal(result.binding.state, 'ready');
  assert.deepEqual(await readdir(locks), []);
});

test('separate processes reserve distinct blueprints concurrently without losing a binding', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const fixtureData = await fixture(t);
  const execute = promisify(execFile);
  const moduleUrl = new URL('../dist/bin/openbot-compose.js', import.meta.url).href;
  const script = [
    `import { provisionOpenBot } from ${JSON.stringify(moduleUrl)};`,
    'const options = JSON.parse(process.argv[2]);',
    'const result = await provisionOpenBot(process.argv[1], options, async () => { await new Promise(resolve => setTimeout(resolve, 40)); }, {});',
    'process.stdout.write(JSON.stringify(result.binding));',
  ].join('\n');
  const results = await Promise.all(['software-development', 'software-development-custom-bot'].map(id =>
    execute(process.execPath, ['--input-type=module', '-e', script, id, JSON.stringify(fixtureData)])));
  const bindings = results.map(result => JSON.parse(result.stdout));
  assert.notEqual(bindings[0].composeProject, bindings[1].composeProject);
  assert.notEqual(bindings[0].appPort, bindings[1].appPort);
  const stored = JSON.parse(await readFile(join(fixtureData.stateDirectory, 'installations.json'), 'utf8'));
  assert.equal(stored.length, 2);
  assert.ok(stored.every(binding => binding.state === 'ready'));
});

test('separate processes targeting one blueprint share one active provision operation', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { access } = await import('node:fs/promises');
  const fixtureData = await fixture(t);
  const execute = promisify(execFile);
  const moduleUrl = new URL('../dist/bin/openbot-compose.js', import.meta.url).href;
  const started = join(fixtureData.directory, 'started');
  const released = join(fixtureData.directory, 'released');
  const script = [
    `import { provisionOpenBot } from ${JSON.stringify(moduleUrl)};`,
    'import { writeFile, access } from "node:fs/promises";',
    'const options = JSON.parse(process.argv[1]);',
    'const run = async args => {',
    '  if (!args.includes("up")) return;',
    '  await writeFile(process.argv[2], "started");',
    '  for (let attempt = 0; attempt < 100; attempt++) {',
    '    try { await access(process.argv[3]); return; } catch {}',
    '    await new Promise(resolve => setTimeout(resolve, 20));',
    '  }',
    '  throw Error("test release timeout");',
    '};',
    'const result = await provisionOpenBot("software-development", options, run, {});',
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  const args = ['--input-type=module', '-e', script, JSON.stringify(fixtureData), started, released];
  const first = execute(process.execPath, args);
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await access(started); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const second = JSON.parse((await execute(process.execPath, args)).stdout);
  assert.equal(second.existing, true);
  assert.equal(second.binding.state, 'provisioning');
  await writeFile(released, 'released');
  const owner = JSON.parse((await first).stdout);
  assert.equal(owner.binding.state, 'ready');
  assert.equal(owner.binding.composeProject, second.binding.composeProject);
  const stored = JSON.parse(await readFile(join(fixtureData.stateDirectory, 'installations.json'), 'utf8'));
  assert.equal(stored.length, 1);
});
