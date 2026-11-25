import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'openbot-candidate-test-'));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'), '--outDir', directory, resolve('deploy/openbot/product/swe-candidate.ts')]);
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { requireCandidateProvenance, verifyCandidateHead } = await import(pathToFileURL(join(directory, 'swe-candidate.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('candidate must bind the brief and source and match a clean guest commit', async () => {
  const commit = 'a'.repeat(40), source = 'b'.repeat(40);
  const request = { projectId: 'p', runId: 'r', operationKey: 'r:1' };
  const phase = { actorId: 'u', channelId: 'c', assignmentId: 'a', botId: 'engineer-bot', actionId: 'implement', occurrenceId: 'o', inputRevisions: [{ type: 'change-brief', revisionId: 'brief' }, { type: 'source-code', revisionId: 'source-record' }] };
  const candidate = { revision: commit, briefRevision: 'brief', sourceRevision: source };
  let exitCode = 0;
  const project = { id: 'p', installationId: 'i', state: 'Operational', permissions: ['read', 'work'] };
  const tx = { async unsafe(sql) {
    if (sql.includes('from bp_phase_workspace_evidence')) return [{ exitCode }];
    if (sql.includes('from bp_project_vms')) return [{ sourceRevision: source, providerId: 'vm', state: 'Ready' }];
    if (sql.includes('from bp_conversations')) return [{ projectId: 'p', assignmentId: 'a' }];
    if (sql.includes('join bp_memberships')) return [project];
    if (sql.includes('join bp_readiness')) return [{ roleKey: 'engineer', revision: 1, reportedRevision: 1, status: 'Ready' }];
    if (sql.includes('from bp_assignments where')) return [{ roleKey: 'engineer', nativeBotId: 'engineer-bot' }];
    if (sql.includes('from bp_artifacts')) return [{ id: 'source-code' }];
    throw Error(`Unexpected query: ${sql}`);
  } };
  const module = { async definitionFor() { return { agents: [{ id: 'engineer-bot', tools: ['workspace-edit'] }], business: {
    roles: [{ id: 'engineer', agentId: 'engineer-bot', actions: ['implement'] }], actions: [{ id: 'implement', role: 'engineer' }],
    artifactTypes: [{ id: 'source-code' }], initialization: { workspace: { kind: 'vm' } },
  } }; } };
  await requireCandidateProvenance(tx, request, phase, candidate);
  await assert.rejects(requireCandidateProvenance(tx, request, phase, { ...candidate, briefRevision: 'wrong' }), error => error.code === 'candidate_unverified');
  exitCode = 1;
  await assert.rejects(requireCandidateProvenance(tx, request, phase, candidate), error => error.code === 'candidate_unverified');
  exitCode = 0;
  const oldFetch = globalThis.fetch, oldUrl = process.env.WORKSPACE_PROVIDER_URL, oldToken = process.env.WORKSPACE_PROVIDER_TOKEN;
  process.env.WORKSPACE_PROVIDER_URL = 'http://provider.invalid'; process.env.WORKSPACE_PROVIDER_TOKEN = 'fixture';
  let actualCommit = commit, verificationExit = 0;
  globalThis.fetch = async url => ({ ok: true, json: async () => url.pathname === '/check' ? { id: 'vm', ready: true, isolated: true } : url.pathname === '/source' ? { hasProject: true, revision: source } : { status: 'completed', exitCode: verificationExit, stdout: actualCommit + '\n' } });
  try {
    await verifyCandidateHead(module, tx, request, phase, candidate);
    actualCommit = 'c'.repeat(40);
    await assert.rejects(verifyCandidateHead(module, tx, request, phase, candidate), error => error.code === 'candidate_unverified');
    actualCommit = commit; verificationExit = 1;
    await assert.rejects(verifyCandidateHead(module, tx, request, phase, candidate), error => error.code === 'candidate_unverified');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.WORKSPACE_PROVIDER_URL; else process.env.WORKSPACE_PROVIDER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.WORKSPACE_PROVIDER_TOKEN; else process.env.WORKSPACE_PROVIDER_TOKEN = oldToken;
  }
});
