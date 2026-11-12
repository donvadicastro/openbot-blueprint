import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { PhaseOutcome, PhaseRequest, RunInput, WorkflowActivities, WorkflowSnapshot } from './contracts.js';

const activities = proxyActivities<WorkflowActivities>({
  startToCloseTimeout: '5 minutes',
  // Unknown effects are reconciled explicitly; Temporal must not repeat them.
  retry: { maximumAttempts: 1 },
});

export const answerDecision = defineSignal<[string, unknown]>('answerDecision');
export const reconcileUncertain = defineSignal('reconcileUncertain');
export const snapshotQuery = defineQuery<WorkflowSnapshot>('snapshot');
export const bindingQuery = defineQuery<RunInput>('binding');

/** The activity boundary must enforce OpenBot project policy and validate all outcomes. */
export async function businessWorkflow(input: RunInput): Promise<WorkflowSnapshot> {
  if (!input.phaseIds.includes(input.initialPhase) || new Set(input.phaseIds).size !== input.phaseIds.length) throw new Error('Invalid pinned plan phases.');
  let state: WorkflowSnapshot = { phase: input.initialPhase, occurrence: 1, state: 'running' };
  let answer: { id: string; value: unknown } | undefined;
  const answered = new Set<string>();
  let reconcileRequested = false;
  setHandler(snapshotQuery, () => ({ ...state }));
  setHandler(bindingQuery, () => input);
  setHandler(answerDecision, (id, value) => {
    if (state.state === 'waiting' && state.decisionId === id && !answer && !answered.has(id)) {
      answer = { id, value };
      answered.add(id);
    }
  });
  setHandler(reconcileUncertain, () => { if (state.state === 'uncertain') reconcileRequested = true; });

  while (state.occurrence <= 10000) {
    const request: PhaseRequest = { installationId: input.installationId, projectId: input.projectId,
      runId: input.runId, planDigest: input.planDigest, phase: state.phase, occurrence: state.occurrence,
      operationKey: `${input.runId}:${state.occurrence}`, ...(answer ? { decision: answer } : {}) };
    answer = undefined;
    state = { phase: state.phase, occurrence: state.occurrence, state: 'running' };
    let outcome: PhaseOutcome;
    try { outcome = await activities.executePhase(request); }
    catch { outcome = { kind: 'uncertain', reason: 'The phase result was not confirmed.' }; }
    while (outcome.kind === 'uncertain') {
      state = { phase: request.phase, occurrence: request.occurrence, state: 'uncertain', reason: outcome.reason };
      await condition(() => reconcileRequested);
      reconcileRequested = false;
      try {
        const reconciled = await activities.reconcilePhase(request);
        if (reconciled.kind === 'not-started') {
          try { outcome = await activities.executePhase(request); }
          catch { outcome = { kind: 'uncertain', reason: 'The phase result was not confirmed.' }; }
        } else outcome = reconciled;
      } catch { outcome = { kind: 'uncertain', reason: 'The phase could not be reconciled.' }; }
    }
    if (outcome.kind === 'wait') {
      state = { phase: request.phase, occurrence: request.occurrence, state: 'waiting', decisionId: outcome.decisionId, reason: outcome.question };
      await condition(() => answer !== undefined);
      continue;
    }
    if (outcome.kind === 'blocked') return state = { phase: request.phase, occurrence: request.occurrence, state: 'blocked', reason: outcome.reason };
    if (outcome.kind === 'complete') return state = { phase: request.phase, occurrence: request.occurrence, state: 'complete', result: outcome.result };
    if (!input.phaseIds.includes(outcome.nextPhase)) return state = { phase: request.phase, occurrence: request.occurrence, state: 'blocked', reason: 'The outcome referenced a phase outside the pinned plan.' };
    state = { phase: outcome.nextPhase, occurrence: request.occurrence + 1, state: 'running' };
  }
  return state = { ...state, state: 'blocked', reason: 'The workflow exceeded its phase limit.' };
}
