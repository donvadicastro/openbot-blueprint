import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Disposable staging fixture; the durable row represents the committed target effect.
export function stagingFixture(file, token, { dropFirstReceipt = false } = {}) {
  const database = new DatabaseSync(file);
  database.exec('create table if not exists effects (operation_id text primary key, project_id text not null, candidate_digest text not null, target text not null, receipt_id text not null)');
  let drop = dropFirstReceipt;
  const server = createServer(async (request, response) => {
    const received = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) { response.writeHead(401).end(); return; }
    if (request.method !== 'POST' || !['/internal/staging/deploy', '/internal/staging/lookup'].includes(request.url)) { response.writeHead(404).end(); return; }
    try {
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 4096) throw new Error('oversized'); }
      const operation = JSON.parse(body);
      if (!['operationId', 'projectId', 'candidateDigest', 'target'].every(key => typeof operation[key] === 'string' && operation[key].length > 0 && operation[key].length <= 300)) throw new Error('invalid');
      let row = database.prepare('select * from effects where operation_id=?').get(operation.operationId);
      if (row && (row.project_id !== operation.projectId || row.candidate_digest !== operation.candidateDigest || row.target !== operation.target)) { response.writeHead(409).end(); return; }
      if (!row && request.url.endsWith('/lookup')) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'not-found', ...operation })); return;
      }
      if (!row) {
        const receiptId = randomUUID();
        database.prepare('insert into effects values (?,?,?,?,?)').run(operation.operationId, operation.projectId, operation.candidateDigest, operation.target, receiptId);
        row = { receipt_id: receiptId };
        if (drop) { drop = false; request.socket.destroy(); return; }
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'confirmed', receipt: { ...operation, receiptId: row.receipt_id } }));
    } catch { response.writeHead(400).end(); }
  });
  return { server, count: () => database.prepare('select count(*) as count from effects').get().count, close: () => database.close() };
}
