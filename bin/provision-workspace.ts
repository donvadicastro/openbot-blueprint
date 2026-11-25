#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { workspaceProvisionArtifacts, workspaceProvisionBlockers, type WorkspaceProvisionReadiness } from '../src/workspace-provision.js';

type Blueprint = { business?: { roles?: { id: string }[]; initialization?: { requiredArtifacts?: string[] } } };
type ProjectResponse = { project?: { id?: string; state?: string; teamLeadChannelId?: string } };

function argumentsFrom(argv: string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!name.startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('Usage: provision-workspace --source /projects/<folder> [--name <name>] [--base-url <url>]');
    }
    options.set(name, argv[++index]);
  }
  for (const name of options.keys()) if (!['--source', '--name', '--base-url'].includes(name)) throw new Error(`Unknown option: ${name}`);
  return options;
}

async function requestJson<T>(url: URL, init: RequestInit = {}): Promise<{ status: number; value: T }> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body) headers.set('content-type', 'application/json');
  const cookie = process.env.OPENBOT_SESSION_COOKIE;
  if (cookie) headers.set('cookie', cookie);
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(10 * 60_000) });
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new Error(`OpenBot returned a non-JSON response (${response.status}).`); }
  if (!response.ok && response.status !== 409) {
    const error = value && typeof value === 'object' ? (value as Record<string, unknown>).error : undefined;
    throw new Error(`OpenBot request failed (${response.status})${typeof error === 'string' ? `: ${error}` : '.'}`);
  }
  return { status: response.status, value: value as T };
}

export async function provisionWorkspace(argv = process.argv.slice(2)) {
  const options = argumentsFrom(argv);
  const source = options.get('--source');
  if (!source) throw new Error('--source is required. Choose a folder under /projects.');
  const artifacts = workspaceProvisionArtifacts(source);
  const name = options.get('--name') ?? 'SWE workspace readiness check';
  if (!name.trim() || name.length > 120) throw new Error('Project name must contain 1–120 characters.');
  const base = new URL(options.get('--base-url') ?? process.env.OPENBOT_BASE_URL ?? 'http://127.0.0.1:3010');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Use an HTTP(S) OpenBot base URL without embedded credentials.');
  const api = (path: string) => new URL(`/api/products${path}`, base);

  const { value: blueprintValue } = await requestJson<Blueprint>(api('/blueprint'));
  const roles = blueprintValue.business?.roles?.map(role => role.id) ?? [];
  const required = blueprintValue.business?.initialization?.requiredArtifacts ?? [];
  if (!roles.length || !required.every(type => Object.hasOwn(artifacts, type))) {
    throw new Error('The selected OpenBot blueprint does not have a compatible business roster or required source artifact.');
  }
  const key = 'workspace-smoke-' + createHash('sha256').update(`${name.trim()}\0${source}`).digest('hex').slice(0, 24);
  const { value: created } = await requestJson<ProjectResponse>(api(''), {
    method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify({ name: name.trim() }),
  });
  const projectId = created.project?.id;
  if (!projectId) throw new Error('OpenBot created no project ID.');

  const initialized = await requestJson<{ readiness?: WorkspaceProvisionReadiness; error?: string; code?: string }>(
    api(`/${encodeURIComponent(projectId)}/initialization`),
    { method: 'POST', body: JSON.stringify({ artifacts }) },
  );
  let readiness = initialized.value.readiness;
  if (!readiness && initialized.status === 409) {
    const current = await requestJson<WorkspaceProvisionReadiness>(api(`/${encodeURIComponent(projectId)}/readiness`));
    readiness = current.value;
  }
  if (!readiness) throw new Error(`OpenBot did not return readiness for project ${projectId}.`);
  const evaluation = workspaceProvisionBlockers(readiness, roles);
  const result = {
    projectId,
    state: readiness.project?.state ?? 'Unknown',
    workspace: readiness.workspace ? { state: readiness.workspace.state, reason: readiness.workspace.reason } : null,
    artifacts: readiness.artifacts?.map(artifact => artifact.typeKey) ?? Object.keys(artifacts),
    roles: (readiness.reports ?? []).map(report => ({ role: report.roleKey, status: report.status })),
    blockers: evaluation.blockers,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!evaluation.operational) process.exitCode = 2;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  provisionWorkspace().catch(error => {
    console.error(error instanceof Error ? error.message : 'Workspace provisioning failed.');
    process.exitCode = 1;
  });
}
