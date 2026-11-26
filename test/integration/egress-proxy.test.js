import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { dependencyEgressProxy } from '../../dist/deploy/workspace-provider/egress-proxy.js';
import { parseDependencyEgressPolicy } from '../../dist/deploy/workspace-provider/egress-policy.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
const hello = (name, extra = Buffer.alloc(0)) => {
  const n = Buffer.from(name), sni = Buffer.concat([Buffer.from([0, n.length+3, 0, 0, n.length]), n]);
  const extensions = Buffer.concat([Buffer.from([0,0,0,sni.length]),sni,extra]);
  const body = Buffer.concat([Buffer.from([3,3]),Buffer.alloc(32),Buffer.from([0,0,2,0x13,1,1,0,0,extensions.length]),extensions]);
  return Buffer.concat([Buffer.from([22,3,3,0,body.length+4,1,0,0,body.length]),body]);
};
const exchange = (port, request, payload) => new Promise((resolve, reject) => {
  const socket = connect(port, '127.0.0.1'); let text = '';
  socket.on('connect', () => socket.write(request));
  socket.on('data', chunk => { text += chunk; if (text.includes('200 Connection Established') && payload) { socket.write(payload); payload=undefined; } if (text.includes('403 Forbidden') || text.includes('echo:')) { socket.destroy(); resolve(text); } });
  socket.on('close', () => resolve(text)); socket.on('error', reject); socket.setTimeout(3000, () => { socket.destroy(); reject(Error('timeout')); });
});

test('CONNECT gate pins authorized public DNS answers and refuses private or unlisted targets', async () => {
  const upstream = createServer(socket => socket.on('data', chunk => socket.write('echo:' + chunk)));
  const upstreamPort = await listen(upstream); let connects = 0;
  const policy = parseDependencyEgressPolicy({destinations:[{hostname:'packages.example.org',port:443},{hostname:'private.example.org',port:443},{hostname:'host.example.org',port:443}]});
  let protectedUnavailable = false, protectedList = ['1.1.1.1'];
  const proxy = dependencyEgressProxy(policy, { lookup: async name => [{address: name === 'private.example.org' ? '127.0.0.1' : name === 'host.example.org' ? '1.1.1.1' : '8.8.8.8',family:4}],
    protectedAddresses: async () => { if (protectedUnavailable) throw Error('address discovery failed'); return protectedList; },
    connect: address => { assert.equal(address, '8.8.8.8'); connects++; return connect(upstreamPort,'127.0.0.1'); } });
  const port = await listen(proxy);
  try {
    assert.match(await exchange(port, 'CONNECT packages.example.org:443 HTTP/1.1\r\nHost: packages.example.org\r\n\r\n', hello('packages.example.org')), /200 Connection Established[\s\S]*echo:/);
    assert.match(await exchange(port, 'CONNECT private.example.org:443 HTTP/1.1\r\n\r\n'), /403 Forbidden/);
    assert.match(await exchange(port, 'CONNECT host.example.org:443 HTTP/1.1\r\n\r\n'), /403 Forbidden/);
    protectedUnavailable = true;
    assert.match(await exchange(port, 'CONNECT packages.example.org:443 HTTP/1.1\r\n\r\n'), /403 Forbidden/);
    protectedUnavailable = false;
    protectedList = [];
    assert.match(await exchange(port, 'CONNECT packages.example.org:443 HTTP/1.1\r\n\r\n'), /403 Forbidden/);
    protectedList = ['invalid'];
    assert.match(await exchange(port, 'CONNECT packages.example.org:443 HTTP/1.1\r\n\r\n'), /403 Forbidden/);
    protectedList = ['::ffff:8.8.8.8'];
    assert.match(await exchange(port, 'CONNECT packages.example.org:443 HTTP/1.1\r\n\r\n'), /403 Forbidden/);
    protectedList = ['1.1.1.1'];
    assert.match(await exchange(port, 'CONNECT other.example.org:443 HTTP/1.1\r\n\r\n'), /403 Forbidden/);
    assert.match(await exchange(port, 'GET https://packages.example.org/ HTTP/1.1\r\n\r\n'), /403 Forbidden/);
    await exchange(port, 'CONNECT packages.example.org:443 HTTP/1.1\r\n\r\n', hello('other.example.org'));
    await exchange(port, 'CONNECT packages.example.org:443 HTTP/1.1\r\n\r\n', hello('packages.example.org', Buffer.from([0xfe,0x0d,0,0])));
    assert.equal(connects, 1);
  } finally { await close(proxy); await close(upstream); }
});
