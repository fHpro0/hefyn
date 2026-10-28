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

test('create sends the highlighted Assistant, and a view only for CLI agent chats', () => {
  const base = { title: 't', cli: true, agent: '', view: 'chat' as const, assistantId: 'flowA' };
  assert.deepEqual(createBody({ ...base, flow: true }), { title: 't', assistantId: 'flowA' });
  assert.deepEqual(createBody({ ...base, flow: false }), { title: 't', assistantId: 'flowA', view: 'chat' });
  assert.deepEqual(createBody({ ...base, cli: false }), { title: 't', assistantId: 'flowA' });
  assert.deepEqual(createBody({ ...base, agent: 'codex-acp', project: 'p' }), { title: 't', projectId: 'p', agent: 'codex-acp', view: 'chat' });
});
