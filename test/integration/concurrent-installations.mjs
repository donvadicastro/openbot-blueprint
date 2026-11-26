import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { provisionOpenBot } from '../../dist/bin/openbot-compose.js';

// Uses generated fixture credentials, isolated Compose projects and temporary
// databases. No running OpenBot installation or user credentials are modified.
const exec = promisify(execFile);
const root = resolve('.');
const scratch = await mkdtemp('/tmp/openbot-installations-');
const registry = join(scratch, 'registry');
const projects = join(scratch, 'projects');
await mkdir(projects);
const secret = () => randomBytes(32).toString('hex');
const port = () => new Promise((resolvePort, reject) => {
  const listener = createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => { const value = listener.address().port; listener.close(() => resolvePort(value)); });
});
const ports = [await port(), await port()];
if (ports[0] === ports[1]) ports[1] = await port();
const implementationEnv = join(scratch, 'implementer.env');
await writeFile(implementationEnv, 'BOT_PROVIDER=openai\nBOT_MODEL=fixture\nOPENAI_API_KEY=fixture\nOPENAI_BASE_URL=http://host.docker.internal:1234/v1\n', { mode: 0o600 });
const envFiles = [];
for (let index = 0; index < 2; index++) {
  const file = join(scratch, `app-${index}.env`);
  const values = { BOT_PROVIDER: 'openai', BOT_MODEL: 'fixture', OPENAI_API_KEY: 'fixture',
    OPENAI_BASE_URL: 'http://host.docker.internal:1234/v1', INTELLIGENCE_API_URL: 'http://127.0.0.1:1',
    INTELLIGENCE_GATEWAY_WS_URL: 'ws://127.0.0.1:1', CPK_INTELLIGENCE_API_KEY: 'fixture',
    POSTGRES_USER: 'openbot', POSTGRES_DB: 'openbot', POSTGRES_PASSWORD: 'fixture',
    DATABASE_URL: 'postgres://openbot:fixture@postgres:5432/openbot', KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    COMPUTER_TOKEN: secret(), SUPERVISOR_TOKEN: secret(), AGENT_TOOL_TOKEN: secret(), WORKER_SHARED_SECRET: secret(),
    WORKFLOW_POSTGRES_PASSWORD: secret(), WORKFLOW_ACTIVITY_TOKEN: secret(), WORKFLOW_ENGINE_TOKEN: secret(),
    MANAGED_AGENT_TOKEN: secret(), OPENBOT_SINGLE_USER: 'true', COMPUTER_BROWSER_MODE: 'headless',
    IMPLEMENTER_ENV_FILE: implementationEnv, PROJECTS_HOST_DIR: projects, APP_PORT: String(ports[index]) };
  await writeFile(file, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  envFiles.push(file);
}
const environment = { ...process.env, SERVER_IMAGE: 'openbot-blueprint-server:current-verify', WORKFLOW_WORKER_IMAGE: 'openbot-blueprint-workflow-worker:latest', PROJECTS_HOST_DIR: projects };
delete environment.COMPOSE_PROJECT_NAME;
const abort = new AbortController();
let cleaning = false;
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => {
  process.exitCode = code;
  abort.abort();
});
const run = async (args, env) => {
  // Exercise the provisioner's real Compose calls with prebuilt fixture images,
  // avoiding a rebuild of the shared tooling image used by an existing stack.
  const actual = args.filter(arg => arg !== '--build');
  const projectIndex = actual.indexOf('--project-name');
  if (projectIndex >= 0 && actual.includes('up')) console.log(`Starting disposable Compose project ${actual[projectIndex + 1]}.`);
  const result = await exec('docker', actual, { cwd: root, env, timeout: 300000, maxBuffer: 4 * 1024 * 1024, signal: abort.signal });
  return result.stdout;
};
const compose = binding => ['compose', '--project-name', binding.composeProject, '--env-file', binding.envFile, '-f', join(root, 'docker-compose.yml')];
const composeEnv = binding => ({ ...environment, COMPOSE_PROJECT_NAME: binding.composeProject,
  BLUEPRINT_DIR: resolve(binding.sourcePath, '..'), BLUEPRINT_ID: binding.blueprintId, BLUEPRINT_VERSION: binding.blueprintVersion,
  OPENBOT_ENV_FILE: binding.envFile, IMPLEMENTER_ENV_FILE: implementationEnv, APP_PORT: String(binding.appPort) });
const call = async (binding, ...args) => (await exec('docker', [...compose(binding), ...args], { cwd: root, env: composeEnv(binding), timeout: 180000, maxBuffer: 4 * 1024 * 1024, ...(cleaning ? {} : { signal: abort.signal }) })).stdout.trim();
const healthy = async appPort => {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (abort.signal.aborted) throw Error('Disposable installation test interrupted.');
    try { if ((await fetch(`http://127.0.0.1:${appPort}/health`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  }
  throw Error(`Disposable app on port ${appPort} did not become healthy.`);
};
try {
  const starts = await Promise.allSettled([
    provisionOpenBot('software-development', { envFile: envFiles[0], appPort: ports[0], stateDirectory: registry }, run, environment),
    provisionOpenBot(join(root, 'test/fixtures/blueprints/distinct-business/blueprint.json'), { envFile: envFiles[1], appPort: ports[1], stateDirectory: registry }, run, environment),
  ]);
  const failed = starts.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  const [first, second] = starts.map(result => result.value.binding);
  if (first.composeProject === second.composeProject || first.appPort === second.appPort) throw Error('Installations did not receive distinct bindings.');
  const defaultImages = [];
  for (const binding of [first, second]) {
    const env = composeEnv(binding);
    delete env.WORKFLOW_WORKER_IMAGE;
    const { stdout } = await exec('docker', [...compose(binding), 'config', '--images'], { cwd: root, env, timeout: 30000, signal: abort.signal });
    const expected = `${binding.composeProject}-workflow-worker:local`;
    if (!stdout.split(/\s+/).includes(expected)) throw Error('The default workflow image is not isolated by installation.');
    defaultImages.push(expected);
  }
  if (defaultImages[0] === defaultImages[1]) throw Error('Installations share the default workflow image tag.');
  await Promise.all([healthy(first.appPort), healthy(second.appPort)]);
  for (const binding of [first, second]) {
    const id = await call(binding, 'exec', '-T', 'server', 'bun', '-e', 'const b=await Bun.file("/tenant/current/blueprint.json").json(); console.log(b.id)');
    if (id !== binding.blueprintId) throw Error('An installation loaded the wrong blueprint.');
    const gateway = await call(binding, 'exec', '-T', 'server', 'bun', '-e', 'const r=await fetch("http://workflow-worker:4310/"); console.log(r.status)');
    if (gateway !== '401') throw Error('The private workflow gateway is unavailable or did not reject an unauthenticated request.');
    await call(binding, 'exec', '-T', 'postgres', 'psql', '-U', 'openbot', '-d', 'openbot', '-v', 'ON_ERROR_STOP=1', '-c', `create table fixture_isolation_marker (value text); insert into fixture_isolation_marker values ('${binding.blueprintId}');`);
  }
  // The gateway is private, and OpenBot must refuse an unknown project. Start
  // an intentionally unbound run to exercise the durable fail-closed state.
  const probeRun = { installationId: 'fixture-install', projectId: 'missing-project', runId: 'fixture-held-run', planDigest: 'a'.repeat(64), initialPhase: 'initial', phaseIds: ['initial'] };
  const gatewayCall = async (binding, endpoint) => {
    const script = `const r=await fetch('http://workflow-worker:4310/${endpoint}',{method:'POST',headers:{authorization:'Bearer '+process.env.WORKFLOW_ENGINE_TOKEN,'content-type':'application/json'},body:JSON.stringify({run:${JSON.stringify(probeRun)}})}); console.log(JSON.stringify({status:r.status,body:await r.json()}));`;
    return JSON.parse(await call(binding, 'exec', '-T', 'server', 'bun', '-e', script));
  };
  const started = await gatewayCall(first, 'start');
  if (started.status !== 201) throw Error('The provisioned workflow gateway did not start the isolated probe.');
  const otherInstallation = await gatewayCall(second, 'status');
  if (otherInstallation.status !== 404) throw Error('The second installation could access a workflow belonging to the first.');
  const held = async () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const state = await gatewayCall(first, 'status');
        if (state.status === 200 && state.body.snapshot?.state === 'uncertain') return;
      } catch { /* The worker can still be starting after a restart. */ }
      await new Promise(resolveWait => setTimeout(resolveWait, 1000));
    }
    throw Error('An unknown project did not reach the durable uncertain state.');
  };
  await held();
  await call(first, 'restart', 'workflow-worker');
  await held();
  console.log('The provisioned workflow remained safely held for an unknown project after worker restart.');
  const duplicate = await provisionOpenBot('software-development', { envFile: envFiles[0], appPort: ports[0], stateDirectory: registry }, run, environment);
  if (!duplicate.existing || duplicate.binding.composeProject !== first.composeProject) throw Error('Duplicate provisioning did not reuse its installation.');
  await call(first, 'stop', 'server');
  await healthy(second.appPort);
  await call(first, 'start', 'server');
  await healthy(first.appPort);
  for (const binding of [first, second]) {
    const marker = await call(binding, 'exec', '-T', 'postgres', 'psql', '-U', 'openbot', '-d', 'openbot', '-Atqc', 'select value from fixture_isolation_marker');
    if (marker !== binding.blueprintId) throw Error('An installation lost or shared its database after restart.');
  }
  console.log('Two disposable blueprint installations ran concurrently, reused the SWE binding, and retained separate data across one server restart.');
} catch (error) {
  if (!abort.signal.aborted) throw error;
  console.error('Disposable installation test interrupted; cleaning its projects.');
} finally {
  cleaning = true;
  let bindings = [];
  try { bindings = JSON.parse(await readFile(join(registry, 'installations.json'), 'utf8')); } catch {}
  let cleaned = true;
  for (const binding of bindings) {
    try {
      // Docker may finish an in-flight create after its CLI was interrupted.
      // Require two consecutive empty checks and repeat teardown if it appears.
      let emptyChecks = 0;
      for (let attempt = 0; attempt < 10 && emptyChecks < 2; attempt++) {
        await call(binding, 'down', '-v', '--remove-orphans');
        await new Promise(resolveWait => setTimeout(resolveWait, 1000));
        const { stdout } = await exec('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${binding.composeProject}`], { cwd: root, env: environment, timeout: 30000 });
        emptyChecks = stdout.trim() ? 0 : emptyChecks + 1;
      }
      if (emptyChecks < 2) throw Error('Disposable containers remained after cleanup.');
    } catch { cleaned = false; console.error(`Could not clean disposable Compose project ${binding.composeProject}.`); }
  }
  if (cleaned) await rm(scratch, { recursive: true, force: true });
  else console.error(`Fixture metadata retained at ${scratch} for cleanup.`);
}
