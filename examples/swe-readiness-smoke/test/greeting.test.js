import test from 'node:test';
import assert from 'node:assert/strict';
import { greeting } from '../src/greeting.js';

test('greets a trimmed name', () => {
  assert.equal(greeting('  OpenBot  '), 'Hello, OpenBot!');
});

test('rejects an empty name', () => {
  assert.throws(() => greeting('  '), { name: 'TypeError' });
});
