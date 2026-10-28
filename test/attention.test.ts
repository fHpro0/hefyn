import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askSentence, attention, bareTitle, chatActivity, pageTitle, type Status } from '../web/src/components/activity.ts';

const st = (o: Partial<Status>): Status => ({ state: 'waiting', agents: [], ...o });
const titles = { c1: 'was kannst du?', c2: 'Budget', c3: 'Idle' };

test('sentences are plain; an unknown kind or a flow question is a generic request', () => {
  assert.equal(askSentence('Artikel schreiben', 'Write'), 'Artikel schreiben wants to write a file');
  assert.equal(askSentence(undefined, 'execute'), 'The agent wants to run a command');
  assert.equal(askSentence(undefined, 'mcp__x_ab12__send'), 'The agent wants to use a tool');
  assert.equal(askSentence('Draft', 'weird'), 'Draft wants to do something');
  assert.equal(askSentence('Draft'), 'Draft needs your answer');
});

test('every waiting sub-agent and chat is listed once; running, idle, unknown and the open chat are not', () => {
  const sub = { id: 'a1', name: 'Artikel schreiben', kind: 'agent' as const, state: 'waiting' as const, ask: 'Write' };
  const list = attention({
    c1: st({ agents: [sub, { ...sub, id: 'a2', name: 'Other', state: 'running' }] }),
    c2: st({ ask: 'Bash' }), c3: st({ state: 'running' }), gone: st({}), c4: st({}),
  }, { ...titles, c4: 'Flow' }, undefined);
  assert.deepEqual(list.map((a) => [a.key, a.text, a.title]), [
    ['c1:a1', 'Artikel schreiben wants to write a file', 'was kannst du?'], ['c2', 'The agent wants to run a command', 'Budget'], ['c4', 'The agent needs your answer', 'Flow']]);
  assert.equal(list[0]!.lane, 'a1');
  assert.deepEqual(attention({ c2: st({ ask: 'Bash' }) }, titles, 'c2'), [], 'the open chat shows its own dock');
});

test('a chat and its sub-agent both asking are two requests', () => {
  const sub = { id: 'a1', name: 'S', kind: 'agent' as const, state: 'waiting' as const };
  assert.equal(attention({ c1: st({ ask: 'edit', agents: [sub] }) }, titles).length, 2);
});

test('the server ask reaches the status', () => {
  assert.equal(chatActivity(undefined, { state: 'waiting', ask: 'edit' }).ask, 'edit');
  assert.equal(chatActivity({ busy: true }, { state: 'running' }).ask, undefined);
});

test('title prefix: waiting wins, then working; stripped before re-prefixing', () => {
  assert.equal(pageTitle('hefyn', 2, true), '(2) hefyn');
  assert.equal(pageTitle('hefyn', 0, true), '● hefyn');
  assert.equal(pageTitle('hefyn', 0, false), 'hefyn');
  assert.equal(bareTitle('(12) hefyn'), 'hefyn'); assert.equal(bareTitle('● hefyn'), 'hefyn'); assert.equal(bareTitle('hefyn (2)'), 'hefyn (2)');
});
