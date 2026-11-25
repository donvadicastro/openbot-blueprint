import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WorkflowExecutionAlreadyStartedError, type WorkflowClient } from '@temporalio/client';
import type { RunInput, WorkflowSnapshot } from './contracts.js';

function workflowId(input: Pick<RunInput, 'installationId' | 'projectId' | 'runId'>) {
  return 'openbot-' + createHash('sha256').update(JSON.stringify([input.installationId, input.projectId, input.runId])).digest('hex');
}
function identity(value: unknown): value is RunInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ['installationId', 'projectId', 'runId'].every(key => typeof item[key] === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(item[key] as string));
}
function plan(value: RunInput) {
  return typeof value.planDigest === 'string' && /^[a-f0-9]{64}$/.test(value.planDigest)
    && typeof value.initialPhase === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value.initialPhase)
    && Array.isArray(value.phaseIds) && value.phaseIds.length > 0 && value.phaseIds.length <= 200
    && value.phaseIds.every(id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id))
    && value.phaseIds.includes(value.initialPhase) && new Set(value.phaseIds).size === value.phaseIds.length;
}
function samePlan(left: RunInput, right: RunInput) {
  return left.installationId === right.installationId && left.projectId === right.projectId && left.runId === right.runId
    && left.planDigest === right.planDigest && left.initialPhase === right.initialPhase
    && Array.isArray(left.phaseIds) && left.phaseIds.length === right.phaseIds.length
    && left.phaseIds.every((id, index) => id === right.phaseIds[index]);
}
function reply(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/** Private transport: only OpenBot is given the token and must authorize the actor first. */
export function workflowGateway(client: WorkflowClient, token: string, taskQueue: string) {
  if (token.length < 32) throw new Error('Configure a workflow gateway token of at least 32 characters.');
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const supplied = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(response, 401, { error: 'Unauthorized.' });
    if (request.method !== 'POST') return reply(response, 405, { error: 'Method not allowed.' });
    try {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) {
        const data = Buffer.from(chunk); length += data.length;
        if (length > 65536) return reply(response, 413, { error: 'Request too large.' });
        chunks.push(data);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(response, 422, { error: 'Invalid request.' });
      const payload = body as Record<string, unknown>;
      if (!identity(payload.run)) return reply(response, 422, { error: 'Invalid run binding.' });
      const run = payload.run;
      const id = workflowId(run);
      if (request.url === '/start') {
        if (!plan(run)) return reply(response, 422, { error: 'Invalid pinned plan.' });
        try {
          await client.start('businessWorkflow', { taskQueue, workflowId: id, workflowIdReusePolicy: 'REJECT_DUPLICATE', args: [run] });
          return reply(response, 201, { workflowId: id, existing: false });
        } catch (error) {
          if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
          const existing = await client.getHandle(id).query<RunInput>('binding');
          if (!samePlan(existing, run)) return reply(response, 409, { error: 'Run identity is already bound to another plan.' });
          return reply(response, 200, { workflowId: id, existing: true });
        }
      }
      const handle = client.getHandle(id);
      const binding = await handle.query<RunInput>('binding');
      if (binding.installationId !== run.installationId || binding.projectId !== run.projectId || binding.runId !== run.runId) return reply(response, 404, { error: 'Run not found.' });
      const snapshot = await handle.query<WorkflowSnapshot>('snapshot');
      if (request.url === '/status') return reply(response, 200, { snapshot });
      if (request.url === '/decision') {
        if (typeof payload.decisionId !== 'string' || !('value' in payload)) return reply(response, 409, { error: 'This run is not waiting for that decision.' });
        const previous = await handle.query<{ found: boolean; value?: unknown }, [string]>('decision', payload.decisionId);
        if (previous.found) return JSON.stringify(previous.value) === JSON.stringify(payload.value)
          ? reply(response, 202, { accepted: true }) : reply(response, 409, { error: 'The decision already has a different answer.' });
        // The answer may have been committed while a lost activity response
        // left the run uncertain. Reconciliation verifies it in OpenBot.
        if (snapshot.state === 'uncertain') {
          await handle.signal('reconcileUncertain');
          return reply(response, 202, { accepted: true });
        }
        if (snapshot.state !== 'waiting' || snapshot.decisionId !== payload.decisionId) return reply(response, 409, { error: 'This run is not waiting for that decision.' });
        await handle.signal('answerDecision', payload.decisionId, payload.value);
        return reply(response, 202, { accepted: true });
      }
      if (request.url === '/reconcile') {
        if (snapshot.state !== 'uncertain') return reply(response, 409, { error: 'This run does not require reconciliation.' });
        await handle.signal('reconcileUncertain');
        return reply(response, 202, { accepted: true });
      }
      return reply(response, 404, { error: 'Not found.' });
    } catch (error) {
      if (error instanceof Error && error.name === 'WorkflowNotFoundError') return reply(response, 404, { error: 'Run not found.' });
      return reply(response, 503, { error: 'The workflow service could not confirm the request.' });
    }
  });
}
