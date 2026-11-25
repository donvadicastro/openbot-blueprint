import { SQL } from 'bun';
import { Hono } from '/app/server/node_modules/hono/dist/index.js';
import { createProductModule } from '/app/server/src/product/module.ts';
import { productDatabaseFromNative } from '/app/server/src/product/store.ts';
import { createPhaseExecutor } from '/app/server/src/product/phase-executor.ts';
import { createWorkflowActivityRoutes } from '/app/server/src/product/workflow-activity-routes.ts';
import { answerWorkflowDecision, dispatchPendingDecision } from '/app/server/src/product/workflow-decision.ts';

const client = new SQL({ hostname: 'restore-project-postgres', port: 5432, username: 'postgres', password: 'fixture', database: 'project_restore_probe' });
const database = productDatabaseFromNative({ $client: client });
const module = await createProductModule(database, '/fixture');
if (!module) throw Error('Restored fixture blueprint missing');
const [binding] = await database.unsafe<{ projectId: string; workItemId: string; runId: string }>(`select r.project_id as "projectId",r.work_item_id as "workItemId",r.id as "runId"
  from bp_workflow_runs r join bp_work_items w on (w.project_id,w.id)=(r.project_id,r.work_item_id)
  where w.request='Handle a service request.'`);
if (!binding) throw Error('Restored work not found');
const realProvider = process.env.RESTORED_VM_PROVIDER_URL || undefined;
process.env.WORKSPACE_PROVIDER_URL = realProvider ?? 'http://127.0.0.1:4321';
process.env.WORKSPACE_PROVIDER_TOKEN = realProvider ? 'restore-fixture-provider-token-0123456789' : 'fixture-token';
if (!realProvider) Bun.serve({ port: 4321, async fetch(request) {
  const path = new URL(request.url).pathname, payload = await request.json() as { operationKey?: string };
  if (path === '/check') return Response.json({ id: 'fixture-vm', ready: true, isolated: true });
  if (path === '/run' && payload.operationKey) await database.unsafe('insert into fixture_effects(operation_key) values($1) on conflict do nothing', [payload.operationKey]);
  return Response.json({ status: 'completed', exitCode: 0, stdout: 'fixture completed', stderr: '' });
} });
const handler = createPhaseExecutor(module, async turn => {
  if (turn.agentId !== 'lead' || !turn.instruction.includes('Small business owners')) throw Error('Restored specialist input mismatch');
  await database.unsafe('insert into fixture_turns default values');
  const workspace = turn.tools.find(tool => tool.name === 'project_phase_workspace');
  if (!workspace) throw Error('Restored workspace tool missing');
  const evidence = JSON.parse(await workspace.execute({ tool: 'test-runner', argv: realProvider ? ['sh','-c','printf x >> restored-workflow'] : ['true'] }));
  if (!evidence.evidenceId || evidence.status !== 'completed') throw Error('Restored workspace effect not confirmed');
  if (realProvider) await database.unsafe("insert into fixture_effects(operation_key) values('restored-real-workflow') on conflict do nothing");
  const output = JSON.parse(await turn.tools[0].execute({ type: 'service-request', payload: { status: 'ready' } }));
  return { replyText: JSON.stringify({ status: 'succeeded', outputs: [{ type: 'service-request', revisionId: output.revisionId }], evidence: { confirmed: output.revisionId } }) };
});
const app = new Hono();
app.route('/internal/workflow-activities', createWorkflowActivityRoutes(process.env.WORKFLOW_ACTIVITY_TOKEN!, handler));
app.get('/fixture-status', async c => {
  const [run] = await database.unsafe<{ state: string }>('select state from bp_workflow_runs where project_id=$1 and id=$2', [binding.projectId,binding.runId]);
  const [turns] = await database.unsafe<{ count: number }>('select count(*)::int as count from fixture_turns');
  const [effects] = await database.unsafe<{ count: number }>('select count(*)::int as count from fixture_effects');
  const [decision] = await database.unsafe<{ id: string; kind: string }>(`select d.id,case when c.decision_id is not null then 'clarification' else 'choice' end as kind
    from bp_workflow_decisions d left join bp_phase_clarifications c on (c.project_id,c.run_id,c.decision_id)=(d.project_id,d.run_id,d.id)
    where d.project_id=$1 and d.run_id=$2 and d.state='Pending' order by d.created_at limit 1`, [binding.projectId,binding.runId]);
  return c.json({ state: run?.state, turns: turns.count, effects: effects.count, decision: decision?.id, kind: decision?.kind });
});
app.post('/fixture-answer', async c => {
  const [decision] = await database.unsafe<{ id: string; kind: string }>(`select d.id,case when clar.decision_id is not null then 'clarification' else 'choice' end as kind
    from bp_workflow_decisions d left join bp_phase_clarifications clar on (clar.project_id,clar.run_id,clar.decision_id)=(d.project_id,d.run_id,d.id)
    where d.project_id=$1 and d.run_id=$2 and d.state='Pending' order by d.created_at limit 1`, [binding.projectId,binding.runId]);
  if (!decision) return c.json({ error: 'Decision unavailable' }, 409);
  await answerWorkflowDecision(module, { id: 'owner', role: 'admin' }, binding.projectId, binding.workItemId, binding.runId, decision.id, decision.kind === 'clarification' ? 'Small business owners' : 'accept');
  await dispatchPendingDecision(module);
  return c.json({ ok: true });
});
Bun.serve({ port: 4320, fetch: app.fetch });
