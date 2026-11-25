import { createActorAgentResolver } from '/app/server/src/agents/agent-resolver.ts';
import { createTurnRunner } from '/app/toolkit/src/run-turn.ts';
import { Observable } from 'rxjs';

/** Live model with the production actor resolver and turn runner, scoped to phase tools. */
export async function runLiveWorkflowTurn(input: any) {
  const phaseSchema = (kind: string) => kind === 'workspace' ? { type: 'object', properties: {
    tool: { type: 'string', enum: ['workspace-edit','test-runner'] }, argv: { type: 'array', items: { type: 'string' } },
  }, required: ['tool','argv'], additionalProperties: false } : kind === 'reconcile' ? { type: 'object', properties: {
    tool: { type: 'string', enum: ['workspace-edit','test-runner'] },
  }, required: ['tool'], additionalProperties: false } : kind === 'qa-progress' ? { type: 'object', properties: {
    planRevision: { type: 'string' }, scenarioId: { type: 'string' }, status: { type: 'string' }, observed: { type: 'string' },
    reason: { type: 'string' }, evidenceId: { type: 'string' },
  }, required: ['planRevision','scenarioId','status'], additionalProperties: false } : { type: 'object', properties: {
    type: { type: 'string' }, payload: { type: 'object', additionalProperties: true },
  }, required: ['type','payload'], additionalProperties: false };
  const resolver = createActorAgentResolver({
    loadAgents: async () => [{ id: input.agentId, name: 'Service Coordinator', type: 'built_in',
      systemPrompt: input.systemPrompt ?? 'You are a service coordinator. Follow the assigned action and return the required structured result.' }],
    model: { provider: 'openai', defaultModel: process.env.LIVE_WORKFLOW_MODEL! }, resolveModelApiKey: async () => 'local-test',
    loadToolsForActor: () => async () => [], handoffForActor: () => async () => [],
  });
  const intelligence = { async getOrCreateThread() {}, async getThreadMessages() { return { messages: [] }; },
    async ɵacquireThreadLock() {}, async ɵrenewThreadLock() {}, async ɵcleanupThreadLock() {} };
  const runner = { run({ agent, input: runInput }: any) { return new Observable(subscriber => {
    agent.runAgent(runInput).then(() => subscriber.complete(), (error: unknown) => subscriber.error(error));
  }); }, async stop() { return true; } };
  const turn = createTurnRunner({ intelligence, runner, turnTimeoutMs: 120000, abortGraceMs: 1000,
    admission: async ({ signal }: any) => signal,
    buildAgentFor: async () => resolver.resolveAgentForActor({ id: input.ownerUserId, role: 'admin' }, input.agentId),
    toolsForTurn: async () => input.tools.map((tool: any) => ({ definition: { name: tool.name, description: tool.description,
      parameters: tool.parameters ?? phaseSchema(tool.kind) }, async execute(args: unknown) {
          const result = await tool.execute(args);
          console.log('Live fixture tool:', tool.name, JSON.stringify(args), result);
          return result;
        } })) });
  try {
    const result = await turn({ ownerUserId: input.ownerUserId, agentId: input.agentId, routineId: 'project-workflow',
      threadId: crypto.randomUUID(), instruction: input.instruction });
    console.log('Live fixture specialist reply:', result.replyText);
    return result;
  } catch (error) {
    console.error('Live fixture specialist failed:', error instanceof Error ? error.message : String(error));
    throw error;
  }
}
