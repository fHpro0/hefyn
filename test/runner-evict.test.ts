import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkLimits, evictable, type Managed } from '../services/runner/src/logic.ts';

// At the per-user sandbox cap the runner stops the user's least recently used idle sandbox instead of answering 429.
const cfg = { maxPerUser: { sandbox: 2, playwright: 1 }, maxGlobal: { sandbox: 20, playwright: 5 } };
const sbx = (handle: string, userId = 'u1'): Managed => ({ handle, kind: 'sandbox', userId, conversationId: handle });
const used = (o: Record<string, number>) => new Map(Object.entries(o).map(([h, t]) => [`sandbox:${h}`, t]));

test('below the cap nothing is stopped', () => {
  assert.equal(evictable([sbx('a')], 'sandbox', 'u1', used({ a: 1 }), new Map(), cfg), undefined);
});

test('at the cap the least recently used idle one goes, and only the user\'s own', () => {
  const all = [sbx('a'), sbx('b'), sbx('x', 'u2')];
  assert.equal(evictable(all, 'sandbox', 'u1', used({ a: 50, b: 10, x: 1 }), new Map(), cfg), 'b');
  assert.equal(evictable(all, 'sandbox', 'u1', used({ a: 5, b: 10, x: 1 }), new Map(), cfg), 'a');
});

test('one with a running exec or attached process is never chosen; if all are busy the limit still refuses', () => {
  const all = [sbx('a'), sbx('b')], busy = new Map([['sandbox:b', 1]]);
  assert.equal(evictable(all, 'sandbox', 'u1', used({ a: 50, b: 10 }), busy, cfg), 'a');
  assert.equal(evictable(all, 'sandbox', 'u1', used({ a: 50, b: 10 }), new Map([['sandbox:a', 2], ['sandbox:b', 1]]), cfg), undefined);
  assert.throws(() => checkLimits(all, 'sandbox', 'u1', cfg), /too many sandbox containers for this user/);
});
