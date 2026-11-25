import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDependencyEgressPolicy } from '../dist/deploy/workspace-provider/egress-policy.js';

test('dependency egress policy requires explicit, unique HTTPS DNS names', () => {
  assert.deepEqual(parseDependencyEgressPolicy({destinations:[{hostname:'registry.example.org',port:443}]}), {destinations:[{hostname:'registry.example.org',port:443}]});
  assert.deepEqual(parseDependencyEgressPolicy({destinations:[]}), {destinations:[]});
  for (const hostname of ['localhost','host.local','service.internal','127.0.0.1','::1','*.example.org','Example.org','example.org.','-bad.example.org','example.org/path']) {
    assert.throws(() => parseDependencyEgressPolicy({destinations:[{hostname,port:443}]}));
  }
  assert.throws(() => parseDependencyEgressPolicy({destinations:[{hostname:'registry.example.org',port:80}]}));
  assert.throws(() => parseDependencyEgressPolicy({destinations:[{hostname:'registry.example.org',port:443},{hostname:'registry.example.org',port:443}]}));
  assert.throws(() => parseDependencyEgressPolicy({destinations:[],unexpected:true}));
});

test('dependency resolution rejects private, special, mixed and unauthorized addresses', async () => {
  const { isPublicDependencyAddress, resolveDependencyDestination } = await import('../dist/deploy/workspace-provider/egress-policy.js');
  for (const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','192.0.2.1','198.51.100.1','203.0.113.1','224.0.0.1','::1','::ffff:127.0.0.1']) assert.equal(isPublicDependencyAddress(address), false, address);
  assert.equal(isPublicDependencyAddress('8.8.8.8'), true);
  assert.equal(isPublicDependencyAddress('192.0.3.1'), true);
  assert.equal(isPublicDependencyAddress('192.0.0.1'), false);
  const policy = parseDependencyEgressPolicy({destinations:[{hostname:'registry.example.org',port:443}]});
  assert.deepEqual(await resolveDependencyDestination(policy, 'registry.example.org', 443, async () => [{address:'8.8.8.8',family:4}]), ['8.8.8.8']);
  await assert.rejects(resolveDependencyDestination(policy, 'other.example.org', 443, async () => [{address:'8.8.8.8',family:4}]));
  await assert.rejects(resolveDependencyDestination(policy, 'registry.example.org', 443, async () => [{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]));
  await assert.rejects(resolveDependencyDestination(policy, 'registry.example.org', 443, async () => []));
});

test('destination protection fails closed for missing or malformed address lists', async () => {
  const { requireUnprotectedDestination } = await import('../dist/deploy/workspace-provider/egress-policy.js');
  assert.throws(() => requireUnprotectedDestination([], ['8.8.8.8']));
  assert.throws(() => requireUnprotectedDestination(['127.0.0.1'], ['8.8.8.8']));
  assert.throws(() => requireUnprotectedDestination(['8.8.8.8'], []));
  assert.throws(() => requireUnprotectedDestination(['8.8.8.8'], ['8.8.8.8']));
  assert.doesNotThrow(() => requireUnprotectedDestination(['1.1.1.1'], ['8.8.8.8']));
});

test('protected address discovery combines current host interfaces with explicitly configured public addresses', async () => {
  const { discoverProtectedAddresses } = await import('../dist/deploy/workspace-provider/egress-policy.js');
  const host = { en0: [{ address: '192.168.1.2', family: 'IPv4' }, { address: '2001:db8::1', family: 'IPv6' }], lo0: [{ address: '127.0.0.1', family: 'IPv4' }] };
  assert.deepEqual(discoverProtectedAddresses(['8.8.8.8'], host), ['127.0.0.1', '192.168.1.2', '8.8.8.8']);
  assert.throws(() => discoverProtectedAddresses([], host));
  assert.throws(() => discoverProtectedAddresses(['127.0.0.1'], host));
  assert.throws(() => discoverProtectedAddresses(['8.8.8.8'], {}));
  assert.throws(() => discoverProtectedAddresses(['8.8.8.8'], { en0: [{address:'bad',family:'IPv4'}] }));
  assert.throws(() => discoverProtectedAddresses(['8.8.8.8'], { lo: [{address:'127.0.0.1',family:'IPv4'}], en0: [{address:'8.8.4.4',family:'unexpected'}] }));
  assert.throws(() => discoverProtectedAddresses(['8.8.8.8'], { lo: [{address:'127.0.0.1',family:'IPv4'}], en0: [{address:'bad',family:'IPv6'}] }));
});
