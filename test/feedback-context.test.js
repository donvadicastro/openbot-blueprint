import test from 'node:test';
import assert from 'node:assert/strict';
import { boundGuidance } from '../dist/src/feedback-context.js';

test('specialist memory is bounded and favors the newest project guidance', () => {
  const entries = [
    { id: 'old', guidance: 'older'.repeat(1200) },
    { id: 'middle', guidance: 'middle'.repeat(500) },
    { id: 'newest', guidance: 'newest'.repeat(500) },
  ];
  const result = boundGuidance(entries, 8000, 20);
  assert.deepEqual(result.entries.map(entry => entry.id), ['middle', 'newest']);
  assert.equal(result.entries.reduce((total, entry) => total + entry.guidance.length, 0), 6000);
  assert.equal(result.omitted, 1);
  assert.equal(boundGuidance(entries.slice(1), 1).entries.length, 0);
});

test('specialist memory also enforces an entry-count bound', () => {
  const entries = Array.from({ length: 25 }, (_, index) => ({ id: String(index), guidance: 'x' }));
  const result = boundGuidance(entries, 100, 20);
  assert.equal(result.entries.length, 20);
  assert.equal(result.entries[0].id, '5');
  assert.equal(result.entries.at(-1).id, '24');
  assert.equal(result.omitted, 5);
});
