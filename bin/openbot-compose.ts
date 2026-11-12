#!/usr/bin/env node
import { rename, rm, access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { checked, errorMessage, exportOpenBot, includedAgents, root } from '../src/blueprints.js';
import { validateOpenBotEnvironment } from '../src/openbot-environment.js';
import { processExists, registryTransaction } from '../src/file-lock.js';

export async function prepareOpenBot(
  source = '/definition/blueprint.json',
  destination = '/tenant/current',
  env: Record<string, string | undefined> = process.env,
) {
  const { blueprint } = await checked(source);
  const flag = env.BLUEPRINT_INCLUDE_OPTIONAL ?? 'true';
  if (!['true', 'false'].includes(flag)) throw new Error('BLUEPRINT_INCLUDE_OPTIONAL must be true or false');
  const included = includedAgents(blueprint, flag === 'true');
  const errors = validateOpenBotEnvironment(env, { ...blueprint, agents: included });
  if (errors.length) throw new Error(`OpenBot startup blocked:\n${errors.map(message => `  ${message}`).join('\n')}`);

  const staging = join(dirname(destination), `.staging-${randomUUID()}`);
  const previous = join(dirname(destination), `.previous-${randomUUID()}`);
  await exportOpenBot(source, staging, flag === 'true');
  let hadPrevious = false;
  try {
    await access(destination);
    hadPrevious = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    if (hadPrevious) await rename(destination, previous);
    try { await rename(staging, destination); }
    catch (error) {
      if (hadPrevious) await rename(previous, destination);
      throw error;
    }
    if (hadPrevious) await rm(previous, { recursive: true });
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { id: blueprint.id, version: blueprint.version, agents: included.length };
}

export type ProvisionOptions = {
  envFile: string;
  appPort?: number;
  stateDirectory?: string;
};
export type DeploymentBinding = {
  blueprintId: string;
  blueprintVersion: string;
  sourcePath: string;
  composeProject: string;
  envFile: string;
  appPort: number;
  state: 'provisioning' | 'ready' | 'failed';
  ownerPid?: number;
};
export type ComposeRunner = (args: string[], env: Record<string, string | undefined>) => Promise<string | void>;

async function runCompose(args: string[], env: Record<string, string | undefined>): Promise<string> {
  return new Promise<string>((resolveRun, reject) => {
    const child = spawn('docker', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', () => reject(new Error('Cannot start Docker Compose. Check that Docker is installed and available.')));
    child.once('exit', code => code === 0 ? resolveRun(output) : reject(new Error(`Docker Compose exited with status ${code ?? 'unknown'}`)));
  });
}

async function readBindings(file: string): Promise<DeploymentBinding[]> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(value) || !value.every(binding => binding && typeof binding === 'object'
      && typeof binding.blueprintId === 'string' && typeof binding.blueprintVersion === 'string'
      && typeof binding.sourcePath === 'string' && typeof binding.composeProject === 'string'
      && typeof binding.envFile === 'string' && Number.isInteger(binding.appPort)
      && binding.appPort >= 1024 && binding.appPort <= 65535
      && /^[a-z0-9][a-z0-9_-]*$/.test(binding.composeProject)
      && (binding.ownerPid === undefined || (Number.isSafeInteger(binding.ownerPid) && binding.ownerPid > 0))
      && ['provisioning', 'ready', 'failed'].includes(binding.state))) {
      throw new Error('Invalid deployment registry');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('Cannot read the deployment registry. Preserve the registry and check its format before retrying.');
  }
}

async function writeBindings(file: string, bindings: DeploymentBinding[]) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(bindings, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

async function discoverExistingProject(
  blueprintId: string,
  envFile: string,
  native: Record<string, string | undefined>,
  run: ComposeRunner,
  environment: Record<string, string | undefined>,
): Promise<string | undefined> {
  const project = native.COMPOSE_PROJECT_NAME;
  if (!project) return;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error('COMPOSE_PROJECT_NAME must be a valid Compose project name');
  const output = await run(['compose', 'ls', '--all', '--format', 'json'], environment);
  if (!output) return;
  const deployments: unknown = JSON.parse(output);
  if (!Array.isArray(deployments)) throw new Error('Unexpected Docker Compose deployment list');
  const candidate = deployments.find(item => item.Name === project && typeof item.ConfigFiles === 'string'
    && item.ConfigFiles.split(',').includes(join(root, 'docker-compose.yml')));
  if (!candidate) return;
  const identity = await run([
    'compose', '--project-name', project, '--env-file', envFile, '-f', join(root, 'docker-compose.yml'),
    'exec', '-T', 'server', 'bun', '-e',
    'const b = await Bun.file("/tenant/current/blueprint.json").json(); console.log(JSON.stringify({ id: b.id }));',
  ], environment);
  if (!identity) throw new Error('Cannot verify the existing deployment blueprint identity');
  const tenant: unknown = JSON.parse(identity);
  if (tenant && typeof tenant === 'object' && 'id' in tenant && tenant.id === blueprintId) return project;
}

/** Provision or resume the single installation bound to this blueprint in the registry. */
export async function provisionOpenBot(
  source: string,
  options: ProvisionOptions,
  run: ComposeRunner = runCompose,
  environment: Record<string, string | undefined> = process.env,
): Promise<{ binding: DeploymentBinding; existing: boolean }> {
  const { blueprint, path } = await checked(source);
  const envFile = resolve(options.envFile);
  const native = { ...parseEnv(await readFile(envFile, 'utf8')), ...Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)) };
  const requestedPort = options.appPort ?? Number(native.APP_PORT || 3010);
  if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) throw new Error('App port must be an integer from 1024 to 65535');
  const selected = {
    ...native,
    POSTGRES_USER: native.POSTGRES_USER || 'openbot', POSTGRES_DB: native.POSTGRES_DB || 'openbot',
    POSTGRES_PASSWORD: native.POSTGRES_PASSWORD || 'openbot',
    DATABASE_URL: native.DATABASE_URL || 'postgres://openbot:openbot@postgres:5432/openbot',
    MANAGED_AGENT_AG_UI_URL: native.MANAGED_AGENT_AG_UI_URL || 'http://implementer-bot:4201/ag-ui',
  };
  const errors = validateOpenBotEnvironment(selected, blueprint);
  if (errors.length) throw new Error(`OpenBot startup blocked:\n${errors.map(message => `  ${message}`).join('\n')}`);
  const directory = resolve(options.stateDirectory ?? join(root, '.openbot', 'deployments'));
  const file = join(directory, 'installations.json');
  const existingProject = await discoverExistingProject(blueprint.id, envFile, native, run, environment);
  const reservation = await registryTransaction(directory, async () => {
    const bindings = await readBindings(file);
    let binding = bindings.find(item => item.blueprintId === blueprint.id);
    const existing = Boolean(binding);
    if (binding) {
      if (options.appPort !== undefined && binding.appPort !== options.appPort) {
        if (binding.state !== 'failed') throw new Error('This blueprint already has a different app port in the deployment registry');
        if (bindings.some(item => item.blueprintId !== blueprint.id && item.appPort === options.appPort)) throw new Error('App port is already reserved by another blueprint');
        binding.appPort = options.appPort;
      }
      if (binding.envFile !== envFile) throw new Error('This blueprint already has a different environment file in the deployment registry');
      if (binding.blueprintVersion !== blueprint.version || (binding.state === 'provisioning' && processExists(binding.ownerPid))) {
        return { binding, existing, start: false };
      }
    } else {
      let appPort = requestedPort;
      const occupied = new Set(bindings.map(item => item.appPort));
      if (options.appPort !== undefined && occupied.has(appPort)) throw new Error('App port is already reserved by another blueprint');
      while (occupied.has(appPort) && appPort < 65535) appPort++;
      if (occupied.has(appPort)) throw new Error('No app port is available in the deployment registry');
      const suffix = createHash('sha256').update(`${directory}/${blueprint.id}`).digest('hex').slice(0, 10);
      binding = {
        blueprintId: blueprint.id, blueprintVersion: blueprint.version,
        sourcePath: resolve(path), composeProject: existingProject ?? `openbot-${blueprint.id.slice(0, 35)}-${suffix}`,
        envFile, appPort, state: 'provisioning',
      };
      bindings.push(binding);
    }
    binding.state = 'provisioning';
    binding.ownerPid = process.pid;
    await writeBindings(file, bindings);
    return { binding, existing, start: true };
  });
  const { binding, existing } = reservation;
  if (!reservation.start) return { binding, existing };
  const composeEnv: Record<string, string | undefined> = {
    ...environment,
    COMPOSE_PROJECT_NAME: binding.composeProject,
    COMPUTER_NAMESPACE: binding.composeProject,
    BLUEPRINT_ID: binding.blueprintId,
    BLUEPRINT_VERSION: binding.blueprintVersion,
    BLUEPRINT_DIR: dirname(binding.sourcePath),
    OPENBOT_ENV_FILE: binding.envFile,
    IMPLEMENTER_ENV_FILE: native.IMPLEMENTER_ENV_FILE ? resolve(root, native.IMPLEMENTER_ENV_FILE) : join(dirname(binding.envFile), '.env.implementer'),
    APP_PORT: String(binding.appPort),
  };
  const compose = ['compose', '--project-name', binding.composeProject, '--env-file', binding.envFile, '-f', join(root, 'docker-compose.yml')];
  let state: DeploymentBinding['state'] = 'failed';
  try {
    await run([...compose, 'config', '--quiet'], composeEnv);
    await run([...compose, 'up', '--build', '-d'], composeEnv);
    state = 'ready';
  } finally {
    await registryTransaction(directory, async () => {
      const bindings = await readBindings(file);
      const current = bindings.find(item => item.blueprintId === binding.blueprintId);
      if (!current || current.ownerPid !== process.pid) throw new Error('Deployment binding changed during provisioning');
      current.state = state;
      delete current.ownerPid;
      await writeBindings(file, bindings);
      binding.state = state;
      delete binding.ownerPid;
    });
  }
  return { binding, existing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareOpenBot().then(result => {
    console.log(`Native OpenBot environment verified. Prepared ${result.id}@${result.version}: ${result.agents} coworkers.`);
  }).catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
}
