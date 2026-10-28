import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBody, handoffFor, mayOpen } from '../web/src/components/chat-routing.ts';

test('a handed-off first message belongs to its own conversation only', () => {
  const h = { id: 'new1', value: 'hi' };
  assert.equal(handoffFor(h, 'new1'), 'hi');
  assert.equal(handoffFor(h, 'old'), undefined);
  assert.equal(handoffFor(undefined, 'old'), undefined);
});

test('a late create opens its chat only on the same attempt with no chat open', () => {
  assert.equal(mayOpen(3, 3, ''), true);
  assert.equal(mayOpen(3, 4, ''), false); // the reader left or started a new chat meanwhile
  assert.equal(mayOpen(3, 3, 'old'), false); // a chat is open already
});

test('create sends a raw agent with its view, else the highlighted Assistant, else nothing (the server picks Claude Code)', () => {
  const base = { title: 't', agent: '', view: 'chat' as const, assistantId: 'a1' };
  assert.deepEqual(createBody(base), { title: 't', assistantId: 'a1' });
  assert.deepEqual(createBody({ ...base, assistantId: '' }), { title: 't' });
  assert.deepEqual(createBody({ ...base, agent: 'codex-acp', view: 'terminal' }), { title: 't', agent: 'codex-acp', view: 'terminal' });
});
