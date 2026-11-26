import { createServer } from 'node:http';
import { appendFile, readFile } from 'node:fs/promises';

const token = process.env.WORKFLOW_ACTIVITY_TOKEN;
createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}` || request.method !== 'POST') { response.writeHead(401).end(); return; }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    let outcome;
    if (input.runId === 'wait-run') {
      outcome = input.decision ? { kind: 'complete', result: 'answered' } : { kind: 'wait', decisionId: 'decision-1', question: 'Continue?' };
    } else if (input.runId === 'effect-run' && request.url.endsWith('/execute')) {
      await appendFile('/data/effects', 'effect\n');
      request.socket.destroy();
      return;
    } else if (input.runId === 'effect-run' && request.url.endsWith('/reconcile')) {
      const effects = await readFile('/data/effects', 'utf8').catch(() => '');
      outcome = effects ? { kind: 'complete', result: 'reconciled' } : { kind: 'not-started' };
    } else { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(outcome));
  } catch { response.writeHead(500).end(); }
}).listen(4320, '0.0.0.0');
