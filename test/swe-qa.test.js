import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'openbot-swe-qa-'));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--noCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'), '--outDir', directory, resolve('deploy/openbot/product/swe-qa.ts')]);
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { requireQaOutput } = await import(pathToFileURL(join(directory, 'swe-qa.js')).href);
const { contentDigest } = await import(pathToFileURL(join(directory, 'store.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('QA binds scenarios to the brief and results to actual workspace evidence', async () => {
  const request = { projectId: 'p', runId: 'r' };
  const phase = { actorId: 'u', occurrenceId: 'o', attempt: 1, inputRevisions: [{ type: 'candidate', revisionId: 'candidate' }, { type: 'change-brief', revisionId: 'brief' }] };
  const scenarios = [{ id: 'one', expected: 'works' }, { id: 'two', expected: 'rejects' }];
  const plan = { candidateRevision: 'candidate', briefRevision: 'brief', environment: 'test', prerequisites: [],
    scenarios: scenarios.map(item => ({ ...item, steps: ['exercise'] })) };
  const report = { candidateRevision: 'candidate', briefRevision: 'brief', planRevision: 'plan', environment: 'test', verdict: 'failed', passPercentage: 50,
    results: [{ id: 'one', status: 'passed', observed: 'one passed', evidence: ['receipt'] }, { id: 'two', status: 'failed', observed: 'two failed', evidence: ['receipt'] }] };
  const candidatePayload = { revision: 'a'.repeat(40) };
  let briefDigest = contentDigest({ scenarios });
  let receipt = { id: 'receipt', exitCode: 1, stdout: 'one passed\ntwo failed', stderr: '', qaRevision: candidatePayload.revision };
  receipt.digest = contentDigest({ exitCode: receipt.exitCode, stdout: receipt.stdout, stderr: receipt.stderr, qaRevision: receipt.qaRevision });
  const tx = { async unsafe(sql) {
    if (sql.includes("a.type_key='change-brief'")) return [{ payload: { scenarios }, digest: briefDigest }];
    if (sql.includes("a.type_key='candidate'")) return [{ payload: candidatePayload, digest: contentDigest(candidatePayload) }];
    if (sql.includes('from bp_phase_workspace_evidence')) return receipt ? [receipt] : [];
    if (sql.includes('from bp_qa_scenario_events')) return report.results.map(item => ({ scenarioId: item.id, status: item.status, planRevision: 'plan', candidateRevision: 'candidate', observed: item.observed ?? null, reason: item.reason ?? null, evidenceId: 'receipt' }));
    if (sql.includes('from bp_artifacts')) return [{ id: 'plan', digest: contentDigest(plan), payload: plan }];
    throw Error(`Unexpected query: ${sql}`);
  } };
  await requireQaOutput(tx, request, phase, 'test-plan', plan);
  await requireQaOutput(tx, request, phase, 'qa-evidence', report);
  await assert.rejects(requireQaOutput(tx, request, phase, 'test-plan', { ...plan, candidateRevision: candidatePayload.revision }),
    error => error.code === 'qa_evidence_unverified' && error.message.includes('not the Git commit'));
  briefDigest = 'corrupted';
  await assert.rejects(requireQaOutput(tx, request, phase, 'test-plan', plan), error => error.code === 'qa_evidence_unverified');
  await assert.rejects(requireQaOutput(tx, request, phase, 'qa-evidence', report), error => error.code === 'qa_evidence_unverified');
  briefDigest = contentDigest({ scenarios });
  await assert.rejects(requireQaOutput(tx, request, phase, 'test-plan', { ...plan, scenarios: [{ ...plan.scenarios[0], expected: 'changed' }, plan.scenarios[1]] }), error => error.code === 'qa_evidence_unverified');
  await assert.rejects(requireQaOutput(tx, request, phase, 'qa-evidence', { ...report, candidateRevision: 'wrong' }), error => error.code === 'qa_evidence_unverified');
  await assert.rejects(requireQaOutput(tx, request, phase, 'qa-evidence', { ...report, results: [{ ...report.results[0], observed: 'invented' }, report.results[1]] }), error => error.code === 'qa_evidence_unverified');
  receipt = null;
  await assert.rejects(requireQaOutput(tx, request, phase, 'qa-evidence', report), error => error.code === 'qa_evidence_unverified');
});
