import type { PhaseOutcome, PhaseRequest, WorkflowActivities } from './contracts.js';

function parseOutcome(value: unknown, reconcile: boolean): PhaseOutcome | { kind: 'not-started' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workflow activity response.');
  const item = value as Record<string, unknown>;
  const text = (key: string) => typeof item[key] === 'string' && (item[key] as string).trim().length > 0 && (item[key] as string).length <= 4000;
  if (item.kind === 'advance' && text('nextPhase') && (item.delaySeconds === undefined ||
      (Number.isSafeInteger(item.delaySeconds) && (item.delaySeconds as number) >= 0 && (item.delaySeconds as number) <= 31536000))) {
    return { kind: 'advance', nextPhase: item.nextPhase as string, ...(item.delaySeconds !== undefined ? { delaySeconds: item.delaySeconds as number } : {}) };
  }
  if (item.kind === 'wait' && text('decisionId') && text('question')) return { kind: 'wait', decisionId: item.decisionId as string, question: item.question as string };
  if (item.kind === 'complete' && text('result')) return { kind: 'complete', result: item.result as string };
  if ((item.kind === 'blocked' || item.kind === 'uncertain') && text('reason')) return { kind: item.kind, reason: item.reason as string };
  if (reconcile && item.kind === 'not-started') return { kind: 'not-started' };
  throw new Error('Invalid workflow activity response.');
}

/** The endpoint is a private OpenBot policy adapter, never a model-provided URL. */
export function createActivities(endpoint: string, token: string): WorkflowActivities {
  const base = new URL(endpoint);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || token.length < 32) throw new Error('Configure the private workflow activity endpoint and token.');
  async function call(operation: 'execute' | 'reconcile', request: PhaseRequest) {
    const response = await fetch(new URL(`/internal/workflow-activities/${operation}`, base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(240000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error('The OpenBot workflow activity was not confirmed.');
    return parseOutcome(await response.json(), operation === 'reconcile');
  }
  return {
    async executePhase(request) {
      const outcome = await call('execute', request);
      if (outcome.kind === 'not-started') throw new Error('Invalid execution response.');
      return outcome;
    },
    reconcilePhase: request => call('reconcile', request),
  };
}
