import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { dependencyAuthorityGateway } from '../../dist/deploy/workspace-provider/authority-gateway.js';
import { prepareDependencyAuthority } from '../../dist/deploy/workspace-provider/dependency-authority.js';
import { dependencyEgressProxy } from '../../dist/deploy/workspace-provider/egress-proxy.js';
import { parseDependencyEgressPolicy } from '../../dist/deploy/workspace-provider/egress-policy.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
const fetchFixture = (port, ca, host, options = {}) => new Promise((resolve, reject) => {
  const request = httpsRequest({ hostname: '127.0.0.1', port, servername: options.servername ?? 'packages.example.org', ca,
    method: options.method ?? 'GET', path: '/package', headers: { host, ...(options.headers ?? {}) }, agent: options.agent ?? false }, response => {
    let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body, ...(options.includeHeaders ? { headers: response.headers } : {}) }));
  });
  request.on('error', reject); request.end();
});
const tunnelFixture = (port, ca, host) => new Promise((resolve, reject) => {
  const socket = tcpConnect(port, '127.0.0.1');
  let header = '';
  socket.setTimeout(5000, () => { socket.destroy(); reject(Error('CONNECT fixture timed out')); });
  socket.once('error', reject);
  socket.once('connect', () => socket.write('CONNECT packages.example.org:443 HTTP/1.1\r\nHost: packages.example.org\r\n\r\n'));
  const receive = chunk => {
    header += chunk.toString('latin1');
    if (!header.includes('\r\n\r\n')) return;
    socket.removeListener('data', receive);
    if (!header.startsWith('HTTP/1.1 200 ')) { socket.destroy(); return reject(Error('CONNECT was refused')); }
    const tls = tlsConnect({ socket, servername: 'packages.example.org', ca });
    let result = '';
    tls.once('error', reject);
    tls.once('secureConnect', () => tls.write(`GET /package HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    tls.on('data', data => { result += data.toString(); });
    tls.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(result)?.[1])));
  };
  socket.on('data', receive);
});

test('HTTPS gateway rejects shared-IP authority changes and pins the validated upstream', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openbot-authority-'));
  const policy = parseDependencyEgressPolicy({ destinations: [{ hostname: 'packages.example.org', port: 443 }] });
  const authority = await prepareDependencyAuthority(directory, policy), ca = authority.caCertificate;
  const leafDir = join(directory, 'leaves', createHash('sha256').update('packages.example.org').digest('hex'));
  const key = await readFile(join(leafDir, 'leaf.key')), cert = await readFile(join(leafDir, 'leaf.crt'));
  let upstreamCalls = 0, seenHeaders, trustedUpstream = true;
  const upstream = createHttpsServer({ key, cert }, (request, response) => { upstreamCalls++; seenHeaders = request.headers; response.setHeader('connection', 'x-private-hop'); response.setHeader('x-private-hop', 'do-not-forward'); response.setHeader('te', 'trailers'); response.setHeader('proxy-authorization', 'do-not-forward'); response.end('package fixture'); });
  const upstreamPort = await listen(upstream);
  let records = [{ address: '8.8.8.8', family: 4 }], protectedAddresses = ['1.1.1.1'];
  const gateway = dependencyAuthorityGateway(policy, {
    certificates: authority.certificates,
    lookup: async () => records, protectedAddresses: async () => protectedAddresses,
    requestUpstream(options, callback) {
      assert.equal(options.hostname, '8.8.8.8'); assert.equal(options.servername, 'packages.example.org');
      assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
      return httpsRequest({ hostname: '127.0.0.1', port: upstreamPort, servername: options.servername,
        rejectUnauthorized: options.rejectUnauthorized, ca: trustedUpstream ? ca : [], method: options.method, path: options.path, headers: options.headers, agent: false }, callback);
    },
  });
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); };
  gateway.on('connection', track);
  const port = await listen(gateway);
  const proxy = dependencyEgressProxy(policy, { lookup: async () => records, protectedAddresses: async () => protectedAddresses,
    connect: () => tcpConnect(port, '127.0.0.1') });
  proxy.on('connection', track);
  const proxyPort = await listen(proxy);
  const agent = new Agent({ keepAlive: true, maxSockets: 1, ca });
  try {
    const first = await fetchFixture(port, ca, 'packages.example.org', { agent, headers: { 'proxy-authorization': 'private-token' } });
    assert.deepEqual(first, { status: 200, body: 'package fixture' });
    assert.equal(seenHeaders.host, 'packages.example.org');
    assert.equal(seenHeaders['proxy-authorization'], undefined);
    const hop = await fetchFixture(port, ca, 'packages.example.org', { includeHeaders: true });
    assert.equal(hop.headers['x-private-hop'], undefined);
    assert.equal(hop.headers.te, undefined);
    assert.equal(hop.headers['proxy-authorization'], undefined);
    assert.equal((await fetchFixture(port, ca, 'packages.example.org', { headers: { connection: 'host' } })).status, 200);
    assert.equal(seenHeaders.host, 'packages.example.org');
    assert.equal((await fetchFixture(port, ca, 'unapproved.example.org', { agent })).status, 403);
    assert.equal((await fetchFixture(port, ca, 'packages.example.org:444')).status, 403);
    assert.equal((await fetchFixture(port, ca, 'packages.example.org', { method: 'POST' })).status, 403);
    records = [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }];
    assert.equal((await fetchFixture(port, ca, 'packages.example.org')).status, 403);
    records = [{ address: '8.8.8.8', family: 4 }]; protectedAddresses = ['8.8.8.8'];
    assert.equal((await fetchFixture(port, ca, 'packages.example.org')).status, 403);
    protectedAddresses = ['1.1.1.1']; trustedUpstream = false;
    assert.equal((await fetchFixture(port, ca, 'packages.example.org')).status, 502);
    trustedUpstream = true;
    protectedAddresses = [];
    assert.equal((await fetchFixture(port, ca, 'packages.example.org')).status, 403);
    await assert.rejects(fetchFixture(port, ca, 'packages.example.org', { servername: 'unapproved.example.org' }));
    protectedAddresses = ['1.1.1.1'];
    assert.equal(await tunnelFixture(proxyPort, ca, 'packages.example.org'), 200);
    assert.equal(await tunnelFixture(proxyPort, ca, 'unapproved.example.org'), 403);
    assert.equal(upstreamCalls, 4);
  } finally {
    agent.destroy(); for (const socket of sockets) socket.destroy(); await close(proxy); await close(gateway); await close(upstream); await rm(directory, { recursive: true, force: true });
  }
});
