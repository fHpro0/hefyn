import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentId, sourceLabel, usedBy, type CatalogAgent } from '../web/src/components/agent-catalog.ts';

const a = (id: string, o: Partial<CatalogAgent> = {}): CatalogAgent => ({ id, name: id, description: '', icon: '', version: '1', adapterVersion: '1', license: 'MIT', licenseUrl: '', api: 'anthropic', source: { type: 'builtin' }, installed: null, enabled: false, roles: [], keyProvider: null, updateAvailable: null, autoUpdate: true, lastChecked: null, lastUpdateError: null, updating: null, ...o });

test('usedBy follows the pinned key, else the agent API', () => {
  const ready = { version: '1', status: 'ready' as const };
  const list = [a('claude', { name: 'Claude Code', api: 'anthropic', installed: ready }), a('codex', { name: 'Codex', api: 'openai-responses', installed: ready, keyProvider: 'anthropic' }), a('off', { api: 'anthropic' })];
  assert.deepEqual(usedBy(list, 'anthropic'), ['Claude Code', 'Codex']);
  assert.deepEqual(usedBy(list, 'openai'), []);
});

test('the source of an agent is said in words', () => {
  assert.equal(sourceLabel({ type: 'builtin' }), 'Built in');
  assert.match(sourceLabel({ type: 'hub', name: 'acme-agent' }), /Hub: acme-agent/);
  assert.match(sourceLabel({ type: 'upload' }), /added by an admin/);
});

test('legacy claude-code maps to claude-acp', () => assert.equal(agentId('claude-code'), 'claude-acp'));
