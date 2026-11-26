import { SQL } from 'bun';
import { Hono } from '/app/server/node_modules/hono/dist/index.js';
import { contentDigest, productDatabaseFromNative } from '/app/server/src/product/store.ts';
import { createProductModule } from '/app/server/src/product/module.ts';
import { projectOperations } from '/app/server/src/product/projects.ts';
import { readinessOperations } from '/app/server/src/product/readiness.ts';
import { createPhaseExecutor } from '/app/server/src/product/phase-executor.ts';
import { createWorkflowActivityRoutes } from '/app/server/src/product/workflow-activity-routes.ts';
import { answerWorkflowDecision } from '/app/server/src/product/workflow-decision.ts';
import { requireReleaseInputs } from '/app/server/src/product/release-preflight.ts';

/*
 * Disposable SWE project that reaches an approved deploy phase for two workflow
 * kinds (published and temporary), then lets a real Temporal worker dispatch the
 * staging effect. The staging service commits the effect before its first
 * response is lost, so this fixture can verify worker interruption and
 * reconciliation without repeating the deployment.
 */

const client = new SQL({ hostname: 'project-postgres', port: 5432, username: 'postgres', password: 'fixture', database: 'postgres' });
const database = productDatabaseFromNative({ $client: client });
for (let attempt = 0; ; attempt++) {
  try { await database.unsafe('select 1'); break; }
  catch (error) { if (attempt >= 60) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
}
await database.unsafe('create table users (id text primary key)');
await database.unsafe('create table channels (id text primary key, deleted_at timestamptz)');
await database.unsafe('create table channel_memberships (channel_id text, user_id text)');
await database.unsafe('create table channel_agents (channel_id text, agent_id text)');
await database.unsafe('create table group_messages (id text primary key, channel_id text, owner_user_id text, agent_id text, status text)');
await database.unsafe("insert into users values ('owner')");

process.env.COMPOSE_PROJECT_NAME = 'release-recovery-fixture';
const actor = { id: 'owner', role: 'admin' } as const;
const module = await createProductModule(database, '/swe-fixture');
if (!module?.definition.business) throw Error('SWE blueprint did not load');

const defer = (error: unknown) => { console.error('Release recovery fixture held', error instanceof Error ? error.message : error); };

/* The activity listener never runs a specialist turn for deployment. */
const executor = createPhaseExecutor(module, async () => { throw Error('A deployment phase must not call a specialist turn.'); });

let guestRevision = 'source-1';
const workspaceProvider = Bun.serve({
  port: 4321,
  async fetch(request) {
    const input = await request.json() as { projectId: string };
    const path = new URL(request.url).pathname;
    if (path === '/check') return Response.json({ id: `vm-${input.projectId}`, ready: true, isolated: true, qaSandbox: 'git-readonly-v1' });
    if (path === '/source') return Response.json({ revision: guestRevision, hasProject: true });
    if (path === '/run' || path === '/reconcile') return Response.json({ status: 'completed', exitCode: 0, stdout: 'fixture passes\nsecond fixture passes', stderr: '' });
    if (path === '/import') return Response.json({ revision: guestRevision });
    return Response.json({ id: `vm-${input.projectId}`, ready: true, isolated: true });
  },
});
process.env.WORKSPACE_PROVIDER_URL = `http://127.0.0.1:${workspaceProvider.port}`;
process.env.WORKSPACE_PROVIDER_TOKEN = 'fixture-token';

const projects = projectOperations(module, async input => {
  const channel = `channel-${input.projectId}`;
  await database.begin(async tx => {
    await tx.unsafe('insert into channels(id) values($1)', [channel]);
    await tx.unsafe('insert into channel_memberships(channel_id,user_id) values($1,$2)', [channel, actor.id]);
    await tx.unsafe('insert into channel_agents(channel_id,agent_id) values($1,$2)', [channel, input.nativeBotId]);
    await tx.unsafe('insert into bp_conversations(project_id,native_channel_id,team_lead_assignment_id) values($1,$2,$3)', [input.projectId, channel, input.assignmentId]);
  });
});
const project = await projects.create(actor, { name: 'Release recovery' }, 'release-recovery-project');
await projects.initialize(actor, project.id, { 'source-code': { path: '/projects/source' } });
await projects.initialize(actor, project.id, {
  'release-runbook': { procedure: 'Deploy the verified candidate to the disposable staging target.' },
  'release-target': { url: 'staging-fixture' },
});
await database.unsafe("update bp_projects set state='Operational' where id=$1", [project.id]);
await database.unsafe("update bp_project_vms set provider_id=$2,state='Ready',source_revision='source-1' where project_id=$1", [project.id, `vm-${project.id}`]);
const readiness = readinessOperations(module, async input => ({
  ready: true,
  checks: input.checks.map(check => ({ id: check.id, passed: true, evidence: 'fixture readiness' })),
}));
const report = await readiness.refresh(actor, project.id);
if (report.project.state !== 'Operational' || report.reports.length !== module.definition.business.roles.length) {
  throw Error('The fixture project did not become Operational.');
}

const briefPayload = {
  scope: 'Exercise the release recovery fixture',
  scenarios: [
    { id: 'scenario-one', expected: 'fixture passes' },
    { id: 'scenario-two', expected: 'second fixture passes' },
  ],
};
const candidatePayload = { revision: 'a'.repeat(40), briefRevision: 'brief-record-revision', sourceRevision: 'source-1' };
for (const [id, type, payload] of [
  ['brief-record', 'change-brief', briefPayload],
  ['candidate-record', 'candidate', candidatePayload],
] as const) {
  await database.unsafe("insert into bp_artifacts(project_id,id,type_key,source,status) values($1,$2,$3,'{}'::jsonb,'supplied')", [project.id, id, type]);
  await database.unsafe('insert into bp_artifact_revisions(project_id,artifact_id,id,digest,payload,created_by) values($1,$2,$3,$4,$5::text::jsonb,$6)', [
    project.id, id, `${id}-revision`, contentDigest(payload), JSON.stringify(payload), actor.id,
  ]);
}
const qaPlan = { workflow: module.definition.business.workflows.find(workflow => workflow.id === 'feature-development')!, guidance: [] };
const qaDigest = contentDigest(qaPlan as any);
const planPayload = {
  candidateRevision: 'candidate-record-revision',
  briefRevision: 'brief-record-revision',
  environment: 'test',
  prerequisites: [],
  scenarios: [
    { id: 'scenario-one', steps: ['Run fixture'], expected: 'fixture passes' },
    { id: 'scenario-two', steps: ['Run second fixture'], expected: 'second fixture passes' },
  ],
};
const qaInputs = [
  { type: 'candidate', revisionId: 'candidate-record-revision' },
  { type: 'change-brief', revisionId: 'brief-record-revision' },
];
const [qaAssignment] = await database.unsafe<{ id: string }>("select id from bp_assignments where project_id=$1 and role_key='qa'", [project.id]);

function temporaryPlan() {
  return { ...structuredClone(qaPlan), rationale: 'Exercise a temporary release recovery plan', guidance: ['Fixture release guidance'] };
}

async function prepareRelease(name: string, temporary: boolean) {
  const plan = temporary ? temporaryPlan() : qaPlan;
  const digest = contentDigest(plan as any);
  const runId = `release-${name}`;
  const itemId = `release-${name}-item`;
  const channel = `channel-${project.id}`;
  await database.unsafe('insert into bp_work_items(project_id,id,native_channel_id,requested_by,request) values($1,$2,$3,$4,$5)', [project.id, itemId, channel, actor.id, 'Prepare a staging release']);
  await database.unsafe("insert into bp_workflow_runs(project_id,id,work_item_id,blueprint_key,blueprint_version,workflow_key,plan_digest,plan,current_phase,state,revision) values($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb,'verify','Running',2)", [
    project.id, runId, itemId, project.blueprintKey, project.blueprintVersion, temporary ? null : 'feature-development', digest, JSON.stringify(plan),
  ]);
  // The release phase reads the candidate and brief from this run's prior output.
  const prior = { outputs: qaInputs };
  await database.unsafe("insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,$2,$3,'implement',100,'implement',$4,$5)", [project.id, runId, `${runId}-prior`, qaAssignment.id, `${runId}:100`]);
  await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state) values($1,$2,$3,1,'Completed')", [project.id, runId, `${runId}-prior`]);
  await database.unsafe("insert into bp_phase_results(project_id,run_id,occurrence_id,attempt,result_digest,result) values($1,$2,$3,1,$4,$5::text::jsonb)", [project.id, runId, `${runId}-prior`, contentDigest(prior), JSON.stringify(prior)]);
  await database.unsafe("insert into bp_phase_occurrences(project_id,run_id,id,phase_key,occurrence,action_key,assignment_id,operation_key) values($1,$2,$3,'verify',1,'verify',$4,$5)", [project.id, runId, `${runId}-verify`, qaAssignment.id, `${runId}:1`]);
  await database.unsafe("insert into bp_action_attempts(project_id,run_id,occurrence_id,attempt,state,input_revisions) values($1,$2,$3,1,'Pending',$4::text::jsonb)", [project.id, runId, `${runId}-verify`, JSON.stringify(qaInputs)]);
  await database.unsafe("insert into bp_dispatch_intents(project_id,run_id,occurrence_id,attempt,operation_key,state) values($1,$2,$3,1,$4,'Dispatched')", [project.id, runId, `${runId}-verify`, `${runId}:1`]);
  const verifyRequest = { installationId: project.installationId, projectId: project.id, runId, planDigest: digest, phase: 'verify', occurrence: 1, operationKey: `${runId}:1` };
  const invoke = async (turn: any, name: string, args: unknown) => {
    const tool = turn.tools.find((item: any) => item.name === name);
    if (!tool) throw Error(`Missing QA tool: ${name}`);
    const result = await tool.execute(args);
    if (result.startsWith('Refused:')) throw Error(result);
    return JSON.parse(result);
  };
  const qaExecutor = createPhaseExecutor(module, async turn => {
    const planOutput = await invoke(turn, 'project_phase_output', { type: 'test-plan', payload: planPayload });
    for (const scenarioId of ['scenario-one', 'scenario-two']) await invoke(turn, 'project_qa_progress', { planRevision: planOutput.revisionId, scenarioId, status: 'queued' });
    for (const scenarioId of ['scenario-one', 'scenario-two']) await invoke(turn, 'project_qa_progress', { planRevision: planOutput.revisionId, scenarioId, status: 'running' });
    const execution = await invoke(turn, 'project_phase_workspace', { tool: 'test-runner', argv: ['true'] });
    const results = [
      { id: 'scenario-one', status: 'passed', observed: 'fixture passes', evidence: [execution.evidenceId] },
      { id: 'scenario-two', status: 'passed', observed: 'second fixture passes', evidence: [execution.evidenceId] },
    ];
    for (const result of results) await invoke(turn, 'project_qa_progress', { planRevision: planOutput.revisionId, scenarioId: result.id, status: result.status, observed: result.observed, evidenceId: execution.evidenceId });
    const qaOutput = await invoke(turn, 'project_phase_output', { type: 'qa-evidence', payload: {
      candidateRevision: 'candidate-record-revision', briefRevision: 'brief-record-revision', planRevision: planOutput.revisionId,
      environment: 'test', verdict: 'passed', passPercentage: 100, results,
    } });
    return { replyText: JSON.stringify({ status: 'succeeded', outputs: [{ type: 'test-plan', revisionId: planOutput.revisionId }, { type: 'qa-evidence', revisionId: qaOutput.revisionId }], evidence: { result: qaOutput.revisionId } }) };
  });
  const qaWait = await qaExecutor.execute(verifyRequest);
  if (qaWait.kind !== 'wait') throw Error(`Release QA did not wait for delivery: ${JSON.stringify(qaWait)}`);
  await answerWorkflowDecision(module, actor, project.id, itemId, runId, qaWait.decisionId, 'ship');
  const qaAdvance = await qaExecutor.execute({ ...verifyRequest, decision: { id: qaWait.decisionId, value: 'ship' } });
  if (qaAdvance.kind !== 'advance' || qaAdvance.nextPhase !== 'prepare-release') throw Error(`Release QA did not reach preparation: ${JSON.stringify(qaAdvance)}`);

  const prepareRequest = { ...verifyRequest, phase: 'prepare-release', occurrence: 2, operationKey: `${runId}:2` };
  const binding = await database.begin(tx => requireReleaseInputs(tx, prepareRequest));
  const prepareExecutor = createPhaseExecutor(module, async () => ({ replyText: JSON.stringify({ status: 'succeeded', outputs: [], evidence: { result: binding.qaEvidenceRevision } }) }));
  const prepareWait = await prepareExecutor.execute(prepareRequest);
  if (prepareWait.kind !== 'wait') throw Error(`Release preparation did not request approval: ${JSON.stringify(prepareWait)}`);
  await answerWorkflowDecision(module, actor, project.id, itemId, runId, prepareWait.decisionId, 'approve');
  const deployAdvance = await prepareExecutor.execute({ ...prepareRequest, decision: { id: prepareWait.decisionId, value: 'approve' } });
  if (deployAdvance.kind !== 'advance' || deployAdvance.nextPhase !== 'deploy') throw Error(`Approved release did not reach deployment: ${JSON.stringify(deployAdvance)}`);

  return {
    runId, itemId, digest,
    request: { installationId: project.installationId, projectId: project.id, runId, planDigest: digest, initialPhase: 'verify', phaseIds: ['verify', 'prepare-release', 'deploy', 'released'] },
    deployRequest: { ...prepareRequest, phase: 'deploy', occurrence: 3, operationKey: `${runId}:3` },
  };
}

const runs = {
  published: await prepareRelease('published', false),
  temporary: await prepareRelease('temporary', true),
};

const engineUrl = process.env.WORKFLOW_ENGINE_URL!;
const engineToken = process.env.WORKFLOW_ENGINE_TOKEN!;
async function gateway(path: string, body: unknown) {
  const response = await fetch(new URL(path, engineUrl), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${engineToken}` }, body: JSON.stringify(body),
  });
  const value = await response.json() as any;
  if (!response.ok) throw Error(`${path} returned ${response.status}: ${value?.error ?? 'unknown'}`);
  return value;
}
const binding = (run: { request: { installationId: string; projectId: string; runId: string } }) => ({
  installationId: run.request.installationId, projectId: run.request.projectId, runId: run.request.runId,
});

async function status() {
  const out: Record<string, unknown> = {};
  for (const [name, run] of Object.entries(runs)) out[name] = (await gateway('/status', { run: binding(run) })).snapshot;
  return out;
}

const app = new Hono();
app.onError((error, context) => {
  console.error('Release recovery fixture request failed', error);
  return context.json({ error: error instanceof Error ? error.message : 'unknown' }, 500);
});
app.route('/internal/workflow-activities', createWorkflowActivityRoutes(process.env.WORKFLOW_ACTIVITY_TOKEN!, executor));
app.get('/fixture-ready', context => context.json({ ready: true, projectId: project.id, runs: Object.keys(runs) }));
app.post('/fixture-start', async context => {
  for (const run of Object.values(runs)) await gateway('/start', { run: run.request });
  return context.json({ started: true });
});
app.get('/fixture-status', async context => context.json(await status()));
app.post('/fixture-reconcile', async context => {
  const current = await status() as Record<string, { state?: string }>;
  for (const [name, run] of Object.entries(runs)) {
    if (current[name]?.state === 'uncertain') await gateway('/reconcile', { run: binding(run) });
  }
  return context.json({ reconciled: true });
});
app.get('/fixture-verify', async context => {
  const current = await status() as Record<string, { state?: string }>;
  const evidence: Record<string, unknown> = {};
  for (const [name, run] of Object.entries(runs)) {
    const effects = await database.unsafe<{ state: string; receipt: any; verification: any }>('select state,receipt,verification from bp_release_effects where project_id=$1 and run_id=$2', [project.id, run.runId]);
    if (current[name]?.state !== 'complete') return context.json({ error: `Run ${name} did not complete.`, state: current[name] }, 409);
    if (effects.length !== 1 || effects[0].state !== 'Confirmed' || !effects[0].receipt?.receiptId || !effects[0].verification?.verificationId) {
      return context.json({ error: `Run ${name} did not record exactly one verified effect.`, effects }, 409);
    }
    const operation = { operationId: effects[0].receipt.operationId, projectId: effects[0].receipt.projectId, candidateDigest: effects[0].receipt.candidateDigest, target: effects[0].receipt.target };
    const response = await fetch(new URL('/internal/staging/lookup', process.env.STAGING_TARGET_URL!), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.STAGING_TARGET_TOKEN}` }, body: JSON.stringify(operation),
    });
    const lookup = await response.json() as any;
    if (!response.ok || lookup.status !== 'confirmed' || lookup.receipt?.receiptId !== effects[0].receipt.receiptId) {
      return context.json({ error: `Run ${name} could not confirm its staging receipt.`, lookup }, 409);
    }
    evidence[name] = { state: current[name]?.state, effectState: effects[0].state, receiptId: effects[0].receipt.receiptId };
  }
  return context.json({ verified: true, evidence });
});
Bun.serve({ port: 4320, fetch: app.fetch });

process.on('unhandledRejection', error => defer(error));
