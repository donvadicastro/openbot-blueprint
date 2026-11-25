import { HttpAgent } from '@ag-ui/client';
import { createTurnRunner } from '/app/toolkit/src/run-turn.ts';
import { Observable } from 'rxjs';
import { HeadlessToolsMiddleware } from '/app/toolkit/src/headless-tools.ts';

let requests = 0, toolCalls = 0, refused = false;
const server = Bun.serve({ port: 0, async fetch(request) {
  const input = await request.json() as any;
  requests++;
  if (!input.tools?.some((tool: any) => tool.name === 'project_phase_output')) return new Response('Missing scoped tool', { status: 400 });
  const events: any[] = [{type:'RUN_STARTED',threadId:input.threadId,runId:input.runId}];
  if (!input.messages.some((message: any) => message.role === 'tool')) {
    events.push({type:'TOOL_CALL_START',toolCallId:'call-1',toolCallName:'project_phase_output',parentMessageId:'assistant-1'},
      {type:'TOOL_CALL_ARGS',toolCallId:'call-1',delta:'{"type":"fixture"}'},{type:'TOOL_CALL_END',toolCallId:'call-1'},
      {type:'TOOL_CALL_START',toolCallId:'call-2',toolCallName:'computer_shell',parentMessageId:'assistant-1'},
      {type:'TOOL_CALL_ARGS',toolCallId:'call-2',delta:'{}'},{type:'TOOL_CALL_END',toolCallId:'call-2'});
  } else {
    refused = input.messages.some((message: any) => message.role === 'tool' && message.toolCallId === 'call-2' && /unavailable|not available|not offered|refus/i.test(String(message.content)));
    events.push({type:'TEXT_MESSAGE_START',messageId:'assistant-2',role:'assistant'},
      {type:'TEXT_MESSAGE_CONTENT',messageId:'assistant-2',delta:'done'}, {type:'TEXT_MESSAGE_END',messageId:'assistant-2'});
  }
  events.push({type:'RUN_FINISHED',threadId:input.threadId,runId:input.runId});
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
} });
const agent = new HttpAgent({url:`http://127.0.0.1:${server.port}`,agentId:'fixture'});
agent.use(new HeadlessToolsMiddleware([{definition:{name:'project_phase_output',description:'fixture',parameters:{type:'object',properties:{type:{type:'string'}}}},async execute(args: any){
  if (args.type !== 'fixture') throw Error('wrong tool argument'); toolCalls++; return { revisionId:'fixture-revision' };
}}]));
const result = await agent.runAgent({runId:'run-1',tools:[],context:[],forwardedProps:{}});
if (!refused || toolCalls !== 1 || requests !== 2 || !result.newMessages.some((message: any) => message.role === 'assistant' && message.content === 'done')) throw Error(`Remote AG-UI tool exchange failed: ${requests}/${toolCalls}`);
// Exercise the same createTurnRunner entry point used by the workflow adapter.
// Persistence and the event runner are isolated fakes; the agent and HTTP transport are real.
const intelligence = { async getOrCreateThread() {}, async getThreadMessages() { return {messages:[]}; },
  async ɵacquireThreadLock() {}, async ɵrenewThreadLock() {}, async ɵcleanupThreadLock() {} };
const runner = { run({agent, input}: any) { return new Observable(subscriber => {
  agent.runAgent(input).then(() => subscriber.complete(), (error: unknown) => subscriber.error(error));
}); }, async stop() { return true; } };
const turn = createTurnRunner({ intelligence, runner, turnTimeoutMs:5000, abortGraceMs:1000, admission: async ({signal}: any) => signal,
  buildAgentFor: async () => new HttpAgent({url:`http://127.0.0.1:${server.port}`,agentId:'fixture'}),
  toolsForTurn: async () => [{definition:{name:'project_phase_output',description:'fixture',parameters:{type:'object',properties:{type:{type:'string'}}}},
    async execute(args: any) { if (args.type !== 'fixture') throw Error('wrong tool argument'); toolCalls++; return {revisionId:'fixture-revision'}; }}] });
let nativeTurn;
try { nativeTurn = await turn({ownerUserId:'owner',agentId:'fixture',routineId:'fixture',threadId:'native-thread',instruction:'Run the fixture.'}); }
catch (error) { server.stop(); throw error; }
if (nativeTurn.replyText !== 'done' || toolCalls !== 2 || requests !== 4) throw Error('Native headless runner did not complete the remote scoped tool turn');
server.stop();
console.log('Remote AG-UI service and native headless runner each completed a scoped tool turn.');
