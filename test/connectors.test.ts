import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { fakeOAuth, fakeServer } from './fake-oauth.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-conn-'));
process.env.HEFYN_SECRET = 'connectors-test-secret-connectors-test-1234';

test('model OAuth: PKCE code exchange, single use, bound to the user, expiry, encrypted tokens, refresh', async () => {
  const srv = await fakeServer();
  const { registerOAuth, DbCredentialStore, resolver } = await import('../src/server/connectors.ts');
  const { startFlow, completeFlow, flowStatus } = await import('../src/server/oauth.ts');
  const { db } = await import('../src/server/appdb.ts');
  registerOAuth('fake', fakeOAuth(srv.url));

  const start = await startFlow('alice', 'fake');
  assert.ok(start.authUrl?.includes('code_challenge='));
  await assert.rejects(completeFlow('mallory', start.flowId, 'code-1'), /unknown or expired/); // bound to the starting user
  assert.deepEqual(await completeFlow('alice', start.flowId, 'code-1'), { state: 'done', error: undefined });
  await assert.rejects(completeFlow('alice', start.flowId, 'code-1'), /already used/); // single use
  assert.equal(flowStatus('alice', start.flowId)?.state, 'done');
  assert.equal(flowStatus('mallory', start.flowId), undefined);

  const row = db.prepare('SELECT enc FROM user_credentials WHERE user_id = ? AND provider = ?').get('alice', 'fake') as { enc: string };
  assert.ok(!row.enc.includes('access-1') && !row.enc.includes('refresh-1'));
  assert.equal((await new DbCredentialStore('alice').read('fake'))?.type, 'oauth');

  // a wrong code fails the flow (PKCE/one-time code enforced by the server) and the flow is spent
  const bad = await startFlow('alice', 'fake');
  assert.equal((await completeFlow('alice', bad.flowId, 'nope')).state, 'error');
  await assert.rejects(completeFlow('alice', bad.flowId, 'code-1'), /already used/);

  // expiry: a pending flow older than 10 minutes is gone
  const slow = await startFlow('alice', 'fake');
  const now = Date.now();
  mock.method(Date, 'now', () => now + 11 * 60_000);
  await assert.rejects(completeFlow('alice', slow.flowId, 'code-1'), /unknown or expired/);
  mock.restoreAll();

  // refresh: an expired access token is refreshed through the provider and persisted
  const store = new DbCredentialStore('alice');
  await store.modify('fake', async (c) => ({ ...(c as any), expires: Date.now() - 1000 }));
  const { auth } = await resolver('alice', 'fake')();
  assert.equal(auth.apiKey, 'access-2');
  assert.equal(srv.refreshes(), 1);
  assert.equal(((await store.read('fake')) as any).access, 'access-2');
  assert.equal((await resolver('alice', 'fake')()).auth.apiKey, 'access-2'); // still valid: no second refresh
  assert.equal(srv.refreshes(), 1);
  srv.close();
});

test('provider access: company providers for all, user providers only for their owner while the credential exists', async () => {
  const { db } = await import('../src/server/appdb.ts');
  const { connectApiKey, disconnectUser, modelAllowed, nsId, providerAllowed } = await import('../src/server/connectors.ts');
  db.prepare("INSERT OR IGNORE INTO providers (id, name, enc_key, created_at) VALUES ('anthropic', 'Anthropic', 'x', 'now')").run();
  connectApiKey('userA', { id: 'anthropic' }, 'sk-a');
  assert.ok(providerAllowed('userA', 'anthropic') && providerAllowed('userB', 'anthropic'));
  assert.ok(providerAllowed('userA', nsId('userA', 'anthropic')));
  assert.ok(!providerAllowed('userB', nsId('userA', 'anthropic')));
  assert.ok(modelAllowed('userA', `${nsId('userA', 'anthropic')}/claude-opus-5-5`) && !modelAllowed('userB', `${nsId('userA', 'anthropic')}/claude-opus-5-5`));
  disconnectUser('userA', 'anthropic');
  assert.ok(!providerAllowed('userA', nsId('userA', 'anthropic')));
  assert.ok(!providerAllowed('userA', 'unknown'));
});

test('MCP urls: internal addresses and bare service names are refused', async () => {
  const { assertPublicUrl } = await import('../src/server/mcp.ts');
  for (const u of ['http://localhost:8787', 'http://127.0.0.1/x', 'http://10.0.0.5/', 'http://169.254.169.254/', 'http://redact:8787', 'http://[::1]/', 'file:///etc/passwd']) assert.throws(() => assertPublicUrl(u), u);
  assert.ok(assertPublicUrl('https://mcp.example.com/mcp'));
});
