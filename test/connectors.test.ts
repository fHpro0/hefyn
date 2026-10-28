import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { fakeOAuth, fakeServer } from './fake-oauth.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-conn-'));
process.env.HEFYN_SECRET = 'connectors-test-secret-connectors-test-1234';

const vault = await import('../src/server/vault.ts');
for (const u of ['alice', 'userA']) vault.rememberUserKey(u, vault.newKey()); // credentials are sealed with the owner's key (docs/ENCRYPTION.md)

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

test('a company key sealed under a key that is no longer held is listed as unreadable (status error), not dropped; entering it again fixes it', async () => {
  const { db } = await import('../src/server/appdb.ts');
  const { companyConnections } = await import('../src/server/connectors.ts');
  const { connect } = await import('../src/server/providers.ts');
  const old = vault.getTeamKey();
  vault.setTeamKey(vault.newKey());
  connect({ id: 'openai' }, 'sk-made-earlier');
  vault.setTeamKey(vault.newKey()); // the key mode changed: another team key is held now
  const row = async () => (await companyConnections()).find((c) => c.id === 'openai');
  assert.equal((await row())?.status, 'error');
  connect({ id: 'openai' }, 'sk-entered-again');
  assert.equal((await row())?.status, 'ok');
  db.prepare("DELETE FROM providers WHERE id = 'openai'").run();
  vault.setTeamKey(old);
});

test('MCP urls: internal addresses and bare service names are refused', async () => {
  const { assertPublicUrl } = await import('../src/server/mcp.ts');
  for (const u of ['http://localhost:8787', 'http://127.0.0.1/x', 'http://10.0.0.5/', 'http://169.254.169.254/', 'http://runner:8790', 'http://[::1]/', 'file:///etc/passwd']) assert.throws(() => assertPublicUrl(u), u);
  assert.ok(assertPublicUrl('https://mcp.example.com/mcp'));
});

test('ChatGPT login: the installation has one stable device UUID', async () => {
  const { deviceId } = await import('../src/server/oauth.ts');
  const id = deviceId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(deviceId(), id);
});

test('OAuth flows that return to a loopback port are completed by the callback; paste is the fallback', async () => {
  const { startFlow } = await import('../src/server/oauth.ts');
  const flow = (redirect: string) => ({ name: 'x', login: async (i: any) => { i.notify({ type: 'auth_url', url: `https://auth.example.com/authorize?redirect_uri=${encodeURIComponent(redirect)}` }); return new Promise((_, rej) => i.signal.addEventListener('abort', () => rej(new Error('cancelled')))); } }) as any;
  assert.equal((await startFlow('alice', 'x', flow('http://127.0.0.1:1455/auth/callback'))).callback, true);
  assert.equal((await startFlow('alice', 'x', flow('http://localhost:53692/callback'))).callback, true);
  assert.equal((await startFlow('alice', 'x', flow('https://platform.claude.com/oauth/code/callback'))).callback, false); // copy-the-code page
});

test('OAuth: retrying a sign-in cancels the abandoned one, so its callback port is free again', async () => {
  const { startFlow } = await import('../src/server/oauth.ts');
  let port = false;
  const holdsPort = { name: 'p', login: async (i: any) => {
    if (port) throw new Error('Port 1455 is in use');
    port = true;
    i.notify({ type: 'auth_url', url: 'https://auth.example.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fcb' });
    try { return await i.prompt({ type: 'manual_code', message: 'paste', signal: i.signal }); } finally { port = false; }
  } } as any;
  const first = await startFlow('bob', 'p', holdsPort);
  const second = await startFlow('bob', 'p', holdsPort);
  assert.equal(second.state, 'pending');
  assert.notEqual(second.flowId, first.flowId);
});
