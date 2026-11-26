// Optional live smoke test: the model endpoint and model ID are supplied by the operator.
import { createActorAgentResolver } from '/app/server/src/agents/agent-resolver.ts';
import { createTurnRunner } from '/app/toolkit/src/run-turn.ts';
import { Observable } from 'rxjs';

const model = process.env.LIVE_MODEL;
if (!model || !process.env.OPENAI_BASE_URL) throw Error('Set LIVE_MODEL and OPENAI_BASE_URL.');
const resolver = createActorAgentResolver({
  loadAgents: async () => [{ id: 'specialist', name: 'Fixture Specialist', type: 'built_in',
    systemPrompt: 'You are a fixture specialist. Follow the user instruction exactly.' }],
  model: { provider: 'openai', defaultModel: model }, resolveModelApiKey: async () => 'local-test',
  loadToolsForActor: () => async () => [], handoffForActor: () => async () => [],
});
const intelligence = { async getOrCreateThread() {}, async getThreadMessages() { return { messages: [] }; },
  async ɵacquireThreadLock() {}, async ɵrenewThreadLock() {}, async ɵcleanupThreadLock() {} };
const runner = { run({ agent, input }: any) { return new Observable(subscriber => {
  agent.runAgent(input).then(() => subscriber.complete(), (error: unknown) => subscriber.error(error));
}); }, async stop() { return true; } };
let calls = 0;
const turn = createTurnRunner({ intelligence, runner, turnTimeoutMs: 120000, abortGraceMs: 1000,
  admission: async ({ signal }: any) => signal,
  buildAgentFor: async () => resolver.resolveAgentForActor({ id: 'owner', role: 'admin' }, 'specialist'),
  toolsForTurn: async () => [{ definition: { name: 'project_phase_output', description: 'Save the requested structured result.',
    parameters: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'], additionalProperties: false } },
    async execute(args: any) { if (args.type !== 'fixture') throw Error('Unexpected output type'); calls++; return { revisionId: 'saved-fixture' }; } }],
});
const result = await turn({ ownerUserId: 'owner', agentId: 'specialist', routineId: 'fixture', threadId: 'fixture',
  instruction: 'Call project_phase_output exactly once with type "fixture". After it succeeds, reply with the returned revision ID.' });
if (calls !== 1 || !result.replyText.includes('saved-fixture')) throw Error(`Live model did not complete the scoped tool turn (calls=${calls}).`);
console.log('Live built-in model completed a scoped OpenBot headless tool turn.');
