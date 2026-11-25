import { HttpAgent } from '/app/server/node_modules/@ag-ui/client/dist/index.js';
import { HeadlessToolsMiddleware } from '/app/toolkit/src/headless-tools.ts';
import { SQL } from 'bun';
import { Hono } from '/app/server/node_modules/hono/dist/index.js';
import { createProductModule } from '/app/server/src/product/module.ts';
import { productDatabaseFromNative } from '/app/server/src/product/store.ts';
import { projectOperations } from '/app/server/src/product/projects.ts';
import { saveWorkflowSelection } from '/app/server/src/product/workflow-routing.ts';
import { createPhaseExecutor } from '/app/server/src/product/phase-executor.ts';
import { createWorkflowActivityRoutes } from '/app/server/src/product/workflow-activity-routes.ts';
import { createDispatchScheduler } from '/app/server/src/product/dispatch-scheduler.ts';
import { answerWorkflowDecision } from '/app/server/src/product/workflow-decision.ts';
import { recordGuidance } from '/app/server/src/product/feedback.ts';

const client = new SQL({ hostname: 'project-postgres', port: 5432, username: 'postgres', password: 'fixture', database: 'postgres' });
const database = productDatabaseFromNative({ $client: client });
for (let attempt = 0;; attempt++) {
  try { await database.unsafe('select 1'); break; }
  catch (error) { if (attempt >= 60) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
}
await database.unsafe('create table users (id text primary key)');
await database.unsafe('create table channels (id text primary key, deleted_at timestamptz)');
await database.unsafe('create table channel_memberships (channel_id text, user_id text)');
await database.unsafe('create table channel_agents (channel_id text, agent_id text)');
await database.unsafe('create table group_messages (id text primary key, channel_id text, owner_user_id text, agent_id text, status text)');
await database.unsafe('create table fixture_turns (id serial primary key)');
await database.unsafe('create table fixture_effects (operation_key text primary key)');
await database.unsafe('create table fixture_retry_turns (id serial primary key)');
await database.unsafe("insert into users values ('owner')");
const actor = { id: 'owner', role: 'admin' } as const;
const module = await createProductModule(database, '/fixture');
if (!module) throw Error('Fixture blueprint missing.');
const workspaceDefinition = structuredClone(module.definition);
workspaceDefinition.version = '1.0.2';
workspaceDefinition.agents.find(agent => agent.id === 'lead')!.tools.push('test-runner');
workspaceDefinition.business!.actions.find(action => action.id === 'clarify')!.results.push({ status: 'needs-input', requiredOutputTypes: [], requiredEvidence: [] });
workspaceDefinition.business!.workflows[0].transitions = [
  { from: 'clarify', to: 'done', when: { status: 'succeeded', decision: 'accept' } },
  { from: 'clarify', to: 'done', when: { status: 'succeeded', decision: 'defer' } },
];
await module.publish(actor, workspaceDefinition);
const retryDefinition = structuredClone(module.definition);
retryDefinition.version = '1.0.3';
retryDefinition.agents.find(agent => agent.id === 'lead')!.runtime = { kind: 'remote', protocol: 'ag-ui', endpointEnv: 'FIXTURE_REMOTE_AGENT_URL' };
retryDefinition.business!.actions.find(action => action.id === 'clarify')!.results.push({ status: 'failed', requiredOutputTypes: [], requiredEvidence: [] }, { status: 'needs-input', requiredOutputTypes: [], requiredEvidence: [] });
retryDefinition.business!.workflows[0].transitions = structuredClone(workspaceDefinition.business!.workflows[0].transitions);
retryDefinition.business!.actions.find(action => action.id === 'clarify')!.retry = { maxAttempts: 2, delaySeconds: 20 };
await module.publish(actor, retryDefinition);
const projects = projectOperations(module, async input => {
  const channel = `channel-${input.projectId}`;
  await database.begin(async tx => {
    await tx.unsafe('insert into channels(id) values($1)', [channel]);
    await tx.unsafe('insert into channel_memberships(channel_id,user_id) values($1,$2)', [channel, actor.id]);
    await tx.unsafe('insert into channel_agents(channel_id,agent_id) values($1,$2)', [channel, input.nativeBotId]);
    await tx.unsafe('insert into bp_conversations(project_id,native_channel_id,team_lead_assignment_id) values($1,$2,$3)', [input.projectId, channel, input.assignmentId]);
  });
});
const project = await projects.create(actor, { name: 'Worker fixture', blueprintVersion: '1.0.2' }, 'fixture-project');
await database.unsafe("update bp_projects set state='Operational' where id=$1", [project.id]);
await database.unsafe("update bp_project_vms set provider_id='fixture-vm',state='Ready' where project_id=$1", [project.id]);
await database.unsafe("insert into bp_readiness(project_id,assignment_id,assignment_revision,input_digest,status,evidence) select project_id,id,revision,'fixture','Ready','{}'::jsonb from bp_assignments where project_id=$1", [project.id]);
const selection = await saveWorkflowSelection(module, actor, project.id, { channelId: project.teamLeadChannelId,
  request: 'Handle a service request.', interpretation: { workflowId: 'service-request' } }, 'fixture-work', module.schema);
const [assignment] = await database.unsafe<{ id: string }>("select id from bp_assignments where project_id=$1 and role_key='coordinator'", [project.id]);
for (const id of ['feedback-initial', 'feedback-conflict', 'feedback-clarified']) await database.unsafe("insert into group_messages values($1,$2,'owner',null,'completed')", [id, project.teamLeadChannelId]);
const originalGuidance = await recordGuidance(module, actor, project.id, assignment.id, { guidance: 'Use brief updates.', source: { conversationId: project.teamLeadChannelId, messageId: 'feedback-initial' } }, 'fixture-guidance');
const conflict = await recordGuidance(module, actor, project.id, assignment.id, { guidance: 'Use detailed updates.', source: { conversationId: project.teamLeadChannelId, messageId: 'feedback-conflict' }, entryId: originalGuidance.id, expectedRevision: 1, conflict: true }, 'fixture-conflict');
const handler = createPhaseExecutor(module, async turn => {
  if (turn.agentId !== 'lead' || turn.ownerUserId !== 'owner') throw Error('Wrong specialist.');
  if (turn.instruction.includes('Retry-proof fixture request')) {
    await database.unsafe('insert into fixture_retry_turns default values');
    const [count] = await database.unsafe<{ count: number }>('select count(*)::int as count from fixture_retry_turns');
    if (count.count >= 3 && !turn.instruction.includes('Temporary audience')) throw Error('Temporary clarification was not preserved');
    const remote = Bun.serve({ port: 0, async fetch(request) {
      console.log('Fixture remote request for turn', count.count);
      const input = await request.json() as any;
      const events: any[] = [{type:'RUN_STARTED',threadId:input.threadId,runId:input.runId}];
      const toolResult = input.messages.find((message: any) => message.role === 'tool');
      if (count.count >= 3 && !toolResult) {
        events.push({type:'TOOL_CALL_START',toolCallId:'remote-output',toolCallName:'project_phase_output',parentMessageId:'remote-assistant'},
          {type:'TOOL_CALL_ARGS',toolCallId:'remote-output',delta:JSON.stringify({type:'service-request',payload:{status:'ready'}})},
          {type:'TOOL_CALL_END',toolCallId:'remote-output'});
      } else {
        const output = toolResult && JSON.parse(toolResult.content);
        const answer = count.count === 1 ? {status:'failed',outputs:[],evidence:{}} : count.count === 2 ?
          {status:'needs-input',question:'Who should receive the result?',outputs:[],evidence:{}} :
          {status:'succeeded',outputs:[{type:'service-request',revisionId:output.revisionId}],evidence:{confirmed:output.revisionId}};
        events.push({type:'TEXT_MESSAGE_START',messageId:'remote-reply',role:'assistant'},
          {type:'TEXT_MESSAGE_CONTENT',messageId:'remote-reply',delta:JSON.stringify(answer)}, {type:'TEXT_MESSAGE_END',messageId:'remote-reply'});
      }
      events.push({type:'RUN_FINISHED',threadId:input.threadId,runId:input.runId});
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
    } });
    try {
      const agent = new HttpAgent({url:`http://127.0.0.1:${remote.port}`,agentId:'lead'});
      agent.use(new HeadlessToolsMiddleware(turn.tools.map(tool => ({definition:{name:tool.name,description:tool.description,parameters:{type:'object'}},execute:tool.execute}))));
      const result = await Promise.race([agent.runAgent({runId:`fixture-${count.count}`,tools:[],context:[],forwardedProps:{}}),
        new Promise<never>((_, reject) => setTimeout(() => reject(Error('Fixture remote turn timed out')), 15000))]);
      console.log('Fixture remote reply received for turn', count.count);
      const reply = result.newMessages.find((message: any) => message.role === 'assistant' && typeof message.content === 'string' && message.content);
      if (!reply || typeof reply.content !== 'string') throw Error('Remote fixture returned no result');
      return {replyText:reply.content};
    } catch (error) { console.error('Fixture remote turn failed:', error); throw error; }
    finally { remote.stop(); }

  }
  await database.unsafe('insert into fixture_turns default values');
  if (!turn.instruction.includes('Use detailed updates for failures.') || turn.instruction.includes('Use brief updates.')) throw Error('Corrected project guidance was not injected into the specialist turn');
  if (!turn.instruction.includes('Small business owners')) return { replyText: JSON.stringify({ status: 'needs-input', question: 'Who is the target audience?', outputs: [], evidence: {} }) };
  const workspace = turn.tools.find(tool => tool.name === 'project_phase_workspace');
  if (!workspace) throw Error('Workspace tool missing.');
  const evidence = JSON.parse(await workspace.execute({ tool: 'test-runner', argv: ['true'] }));
  if (!evidence.evidenceId || evidence.status !== 'completed') throw Error('Workspace effect was not confirmed.');
  const output = JSON.parse(await turn.tools[0].execute({ type: 'service-request', payload: { status: 'ready' } }));
  return { replyText: JSON.stringify({ status: 'succeeded', outputs: [{ type: 'service-request', revisionId: output.revisionId }], evidence: { confirmed: output.revisionId } }) };
});
process.env.WORKSPACE_PROVIDER_URL = 'http://127.0.0.1:4321';
process.env.WORKSPACE_PROVIDER_TOKEN = 'fixture-token';
Bun.serve({ port: 4321, async fetch(request) {
  const path = new URL(request.url).pathname, payload = await request.json() as { operationKey?: string; projectId?: string };
  if (path === '/check') {
    const [vm] = await database.unsafe<{ id: string }>('select provider_id as id from bp_project_vms where project_id=$1', [payload.projectId]);
    return Response.json({ id: vm?.id ?? 'fixture-vm', ready: true, isolated: true });
  }
  if (path === '/run' && payload.operationKey) await database.unsafe('insert into fixture_effects(operation_key) values($1) on conflict do nothing', [payload.operationKey]);
  return Response.json({ status: 'completed', exitCode: 0, stdout: 'fixture completed', stderr: '' });
} });
const app = new Hono();
app.route('/internal/workflow-activities', createWorkflowActivityRoutes(process.env.WORKFLOW_ACTIVITY_TOKEN!, {
  ...handler,
  async execute(request) {
    try { return await handler.execute(request); }
    catch (error) { console.error('Fixture activity failed:', error); throw error; }
  },
}));
let retryFixture: { projectId: string; runId: string; itemId: string } | undefined;
app.post('/fixture-start-safe-retry', async context => {
  if (retryFixture) return context.json({ error: 'Already started.' }, 409);
  const retryProject = await projects.create(actor, { name: 'Retry fixture', blueprintVersion: '1.0.3' }, 'retry-fixture-project');
  await database.unsafe("update bp_projects set state='Operational' where id=$1", [retryProject.id]);
  await database.unsafe("insert into bp_readiness(project_id,assignment_id,assignment_revision,input_digest,status,evidence) select project_id,id,revision,'fixture','Ready','{}'::jsonb from bp_assignments where project_id=$1", [retryProject.id]);
  const retrySelection = await saveWorkflowSelection(module, actor, retryProject.id, { channelId: retryProject.teamLeadChannelId,
    request: 'Retry-proof fixture request', interpretation: { temporary: {
      workflow: { ...structuredClone(retryDefinition.business!.workflows[0]), id: 'temporary-service-request' }, rationale: 'Exercise a temporary recovery plan', guidance: ['Fixture engineering guidance'],
    } } }, 'retry-fixture-work', module.schema);
  if (retrySelection.status !== 'saved' || retrySelection.temporary !== true) throw Error('Temporary retry fixture plan unavailable.');
  const [pinned] = await database.unsafe<{ workflow: string | null; rationale: string; guidance: string }>(`select workflow_key as workflow,plan->>'rationale' as rationale,plan->'guidance'->>0 as guidance
    from bp_workflow_runs where project_id=$1 and id=$2`, [retryProject.id,retrySelection.runId]);
  if (pinned?.workflow !== null || pinned.rationale !== 'Exercise a temporary recovery plan' || pinned.guidance !== 'Fixture engineering guidance') throw Error('Temporary retry plan was not pinned');
  const pinnedDefinition = await module.definitionFor(retryProject);
  if (pinnedDefinition.business?.workflows.some(workflow => workflow.id === 'temporary-service-request')) throw Error('Temporary plan changed the published catalog');
  retryFixture = { projectId: retryProject.id, runId: retrySelection.runId as string, itemId: retrySelection.itemId as string };
  return context.json({ ok: true });
});
app.get('/fixture-safe-retry-status', async context => {
  if (!retryFixture) return context.json({ state: 'not-started' });
  const [run] = await database.unsafe<{ state: string }>('select state from bp_workflow_runs where project_id=$1 and id=$2', [retryFixture.projectId,retryFixture.runId]);
  const [turns] = await database.unsafe<{ count: number }>('select count(*)::int as count from fixture_retry_turns');
  const [lineage] = await database.unsafe<{ count: number }>('select count(*)::int as count from bp_phase_retry_lineage where project_id=$1 and run_id=$2', [retryFixture.projectId,retryFixture.runId]);
  const [decision] = await database.unsafe<{ id: string; kind: string }>(`select d.id,case when c.decision_id is not null then 'clarification' else 'choice' end as kind
    from bp_workflow_decisions d left join bp_phase_clarifications c on (c.project_id,c.run_id,c.decision_id)=(d.project_id,d.run_id,d.id)
    where d.project_id=$1 and d.run_id=$2 and d.state='Pending' order by d.created_at limit 1`, [retryFixture.projectId,retryFixture.runId]);
  return context.json({ state: run?.state, turns: turns.count, retries: lineage.count, decision: decision?.id, kind: decision?.kind });
});
app.post('/fixture-safe-retry-answer', async context => {
  if (!retryFixture) return context.json({ error: 'Not started' }, 409);
  const [decision] = await database.unsafe<{ id: string; kind: string }>(`select d.id,case when c.decision_id is not null then 'clarification' else 'choice' end as kind
    from bp_workflow_decisions d left join bp_phase_clarifications c on (c.project_id,c.run_id,c.decision_id)=(d.project_id,d.run_id,d.id)
    where d.project_id=$1 and d.run_id=$2 and d.state='Pending' order by d.created_at limit 1`, [retryFixture.projectId,retryFixture.runId]);
  if (!decision) return context.json({ error: 'Decision unavailable' }, 409);
  return context.json(await answerWorkflowDecision(module, actor, retryFixture.projectId, retryFixture.itemId, retryFixture.runId, decision.id, decision.kind === 'clarification' ? 'Temporary audience' : 'accept'));
});
app.get('/fixture-status', async context => {
  const [run] = await database.unsafe<{ state: string }>('select state from bp_workflow_runs where project_id=$1 and id=$2', [project.id, selection.runId]);
  const [turns] = await database.unsafe<{ count: number }>('select count(*)::int as count from fixture_turns');
  const [effects] = await database.unsafe<{ count: number }>('select count(*)::int as count from fixture_effects');
  const [decision] = await database.unsafe<{ state: string; kind: string }>(`select d.state,case when c.decision_id is not null then 'clarification' else 'choice' end as kind
    from bp_workflow_decisions d left join bp_phase_clarifications c on (c.project_id,c.run_id,c.decision_id)=(d.project_id,d.run_id,d.id)
    where d.project_id=$1 and d.run_id=$2 and d.state='Pending' order by d.created_at limit 1`, [project.id, selection.runId]);
  let engineState: string | undefined;
  try {
    const [projectBinding] = await database.unsafe<{ installationId: string }>('select installation_id as "installationId" from bp_projects where id=$1', [project.id]);
    const response = await fetch(new URL('/status', process.env.WORKFLOW_ENGINE_URL!), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.WORKFLOW_ENGINE_TOKEN}` }, body: JSON.stringify({ run: { installationId: projectBinding.installationId, projectId: project.id, runId: selection.runId } }) });
    engineState = ((await response.json()) as { snapshot?: { state?: string } }).snapshot?.state;
  } catch { /* Engine may still be starting. */ }
  return context.json({ state: run?.state, decision: decision?.state, decisionKind: decision?.kind, engineState, turns: turns.count, effects: effects.count });
});
app.post('/fixture-clarify', async context => {
  await recordGuidance(module, actor, project.id, assignment.id, { guidance: 'Use detailed updates for failures.', source: { conversationId: project.teamLeadChannelId, messageId: 'feedback-clarified' }, entryId: originalGuidance.id, expectedRevision: 1, resolveConflictId: conflict.conflictId }, 'fixture-clarify');
  return context.json({ ok: true });
});
app.post('/fixture-answer', async context => {
  const [decision] = await database.unsafe<{ id: string; kind: string }>(`select d.id,case when c.decision_id is not null then 'clarification' else 'choice' end as kind
    from bp_workflow_decisions d left join bp_phase_clarifications c on (c.project_id,c.run_id,c.decision_id)=(d.project_id,d.run_id,d.id)
    where d.project_id=$1 and d.run_id=$2 and d.state='Pending' order by d.created_at limit 1`, [project.id, selection.runId]);
  if (!decision) return context.json({ error: 'Decision unavailable.' }, 409);
  return context.json(await answerWorkflowDecision(module, actor, project.id, selection.itemId, selection.runId, decision.id, decision.kind === 'clarification' ? 'Small business owners' : 'accept'));
});
app.post('/fixture-retry', async context => {
  await database.unsafe("update bp_decision_signal_intents set next_attempt_at=now() where project_id=$1 and run_id=$2 and state='Pending'", [project.id, selection.runId]);
  return context.json({ ok: true });
});
Bun.serve({ port: 4320, fetch: app.fetch });
createDispatchScheduler(module, { intervalMs: 1000, onError: error => console.error('Dispatch held', error instanceof Error ? error.name : 'unknown') }).start();
