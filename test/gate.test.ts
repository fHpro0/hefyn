import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createModels } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { requests, startFake } from './fake-anthropic.ts';
import { fakeOAuth, fakeServer } from './fake-oauth.ts';

// The in-process privacy layers against a real sidecar binary (GLiNER off) and the fake upstream:
//   1. gate on the pi-ai Models class (plain setProvider and never-connected built-ins included)
//   2. outbound fetch guard (model-API requests need the gate's stamp)
//   4. GLiNER mandatory in production   5. images
const RPORT = 4700 + Math.floor(Math.random() * 200);
let redact: ChildProcess;
let fake: Awaited<ReturnType<typeof startFake>>;
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-gate-'));
process.env.HEFYN_SECRET = 'gate-test-secret-gate-test-secret-1234';
process.env.HEFYN_REDACT_URL = `http://127.0.0.1:${RPORT}`;

before(async () => {
  fake = await startFake();
  redact = spawn('services/redact/target/debug/hefyn-redact-service', [], { env: { ...process.env, HEFYN_REDACT_GLINER: 'off', HEFYN_REDACT_ADDR: `127.0.0.1:${RPORT}` }, stdio: 'inherit' });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${RPORT}/health`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
});
after(() => { redact?.kill(); fake?.close(); });

const ctx = (content: unknown) => ({ systemPrompt: 'be brief', messages: [{ role: 'user', content, timestamp: Date.now() }] });
async function send(models: any, model: any, context: unknown, conv = 'u_alice_01ABC', opts: object = { apiKey: 'sk-x' }) {
  const { als } = await import('../src/server/context.ts');
  return als.run(conv, async () => {
    const s = models.streamSimple(model, context, opts);
    for await (const _e of s) { /* drain */ }
    return s.result();
  });
}

test('layer 1: the gate sits on the Models class: unconnected built-ins and plain setProvider are blocked, connected ones are redacted', async () => {
  const { installGate } = await import('../src/server/redact.ts');
  const { installFetchGuard } = await import('../src/server/netguard.ts');
  const { build } = await import('../src/server/providers.ts');
  const { db } = await import('../src/server/appdb.ts');
  installGate();
  await installFetchGuard();
  const models: any = createModels(); // a Models instance nobody on our side configured: the prototype is gated anyway
  const before0 = requests.length;

  // a built-in provider the admin never connected, registered by plain setProvider (simulated bypass)
  const openai = builtinProviders().find((p) => p.id === 'openai')!;
  models.setProvider(openai);
  const r1 = await send(models, openai.getModels()[0], ctx('hello'));
  assert.equal(r1.stopReason, 'error');
  assert.match(r1.errorMessage!, /not available to you.*Nothing was sent/s);

  // a custom provider pointing at the fake upstream, plain setProvider, still no company row: blocked, nothing sent
  models.setProvider(build({ id: 'anthropic', baseUrl: fake.url }, 'sk-x'));
  const model = models.getProvider('anthropic').getModels()[0];
  const r2 = await send(models, model, ctx('hello'));
  assert.match(r2.errorMessage!, /not available to you/);
  assert.equal(requests.length, before0, 'nothing reached the upstream');

  // once connected as a company provider the same plain registration is redacted by the gate
  db.prepare("INSERT OR REPLACE INTO providers (id, name, base_url, enc_key, created_at) VALUES ('anthropic', 'Anthropic', ?, 'x', 'now')").run(fake.url);
  const ok = await send(models, model, ctx([{ type: 'text', text: 'mail ada.lovelace@example.com' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]));
  assert.notEqual(ok.stopReason, 'error'); // (the fake answers a placeholder with a tool call; its arguments come back restored)
  assert.ok(JSON.stringify(ok.content).includes('ada.lovelace@example.com'), 'restored for the caller');
  const sent = requests.slice(before0);
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].raw.includes('ada.lovelace@example.com') && sent[0].raw.includes('{{var:EMAIL_1}}'), 'placeholder, not the address');
  assert.ok(!sent[0].raw.includes('AAAA') && sent[0].raw.includes('[image removed by the privacy layer]'), 'image replaced by text');
  const { auditFor } = await import('../src/server/privacy.ts');
  const rows = auditFor('u_alice_01ABC').requests;
  assert.ok(rows.find((r: any) => r.status === 'ok').findings.some((f: any) => f.label === 'IMAGE_REMOVED' && f.count === 1));
  assert.ok(rows.some((r: any) => r.status === 'blocked'));

  // an admin may allow images: they go out, flagged as unredacted
  const { setImagesAllowed } = await import('../src/server/privacy.ts');
  setImagesAllowed(true);
  await send(models, model, ctx([{ type: 'image', data: 'BBBB', mimeType: 'image/png' }]));
  assert.ok(requests.at(-1)!.raw.includes('BBBB'));
  assert.ok(auditFor('u_alice_01ABC').requests[0].findings.some((f: any) => f.label === 'IMAGE_SENT_UNREDACTED'));
  setImagesAllowed(false);
});

test('layer 2: a model-API request outside the gate is a bypass attempt (blocked, audited); auth traffic and other hosts pass', async () => {
  const { withStamp } = await import('../src/server/context.ts');
  const { invalidateAiHosts } = await import('../src/server/netguard.ts');
  const { auditFor } = await import('../src/server/privacy.ts');
  const { als } = await import('../src/server/context.ts');
  invalidateAiHosts();
  const before0 = requests.length;
  await als.run('u_alice_01BYP', async () => {
    await assert.rejects(fetch(fake.url + '/v1/messages', { method: 'POST', body: '{}' }), (e: any) => /bypass attempt/.test(e.message + String(e.cause?.message)));
  });
  assert.equal(requests.length, before0, 'the request never left');
  const row = auditFor('u_alice_01BYP').requests[0];
  assert.equal(row.status, 'blocked');
  assert.match(row.error, /bypass attempt/);
  // token refresh / key checks run under the auth stamp
  const res = await withStamp('auth', () => fetch(fake.url + '/models'));
  assert.equal(res.status, 200);
  // a host that is not a model endpoint is untouched by this layer
  const other = await startFake();
  try { assert.equal((await fetch(other.url + '/models')).status, 200); } finally { other.close(); }
});

test('layer 4: GLiNER is mandatory in production, fail closed; the gate rechecks the sidecar', async () => {
  const { assertPrivacyReady, sidecarHealth } = await import('../src/server/privacy.ts');
  const env = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.HEFYN_ALLOW_NO_GLINER;
    await sidecarHealth(true);
    await assert.rejects(assertPrivacyReady(), /GLiNER is not active/);
    process.env.HEFYN_ALLOW_NO_GLINER = '1';
    await assertPrivacyReady();
  } finally { process.env.NODE_ENV = env; delete process.env.HEFYN_ALLOW_NO_GLINER; }
  assert.equal((await sidecarHealth(true)).gliner, false);
  // the sidecar going away: not ready within the 5 s cache window of the next real request
  const real = process.env.HEFYN_REDACT_URL;
  process.env.HEFYN_REDACT_URL = 'http://127.0.0.1:1';
  assert.equal((await sidecarHealth(true)).ready, false);
  process.env.HEFYN_REDACT_URL = real;
  assert.equal((await sidecarHealth(true)).ready, true);
});

test('company OAuth: a signed-in company provider is usable by any user through the gate; refresh failure shows as expired', async () => {
  const auth = await fakeServer();
  after(() => auth.close());
  const { registerOAuth, companyConnections, CompanyCredentialStore, companyResolver, build: _b } = await import('../src/server/connectors.ts') as any;
  const { startFlow, completeFlow } = await import('../src/server/oauth.ts');
  const { build } = await import('../src/server/providers.ts');
  const { db } = await import('../src/server/appdb.ts');
  db.prepare("DELETE FROM providers WHERE id = 'anthropic'").run();
  registerOAuth('anthropic', fakeOAuth(auth.url)); // the fake PKCE server stands in for Anthropic's login
  const flow = await startFlow('admin1', 'anthropic', undefined, 'company');
  assert.deepEqual(await completeFlow('admin1', flow.flowId, 'code-1'), { state: 'done', error: undefined });
  const row = db.prepare("SELECT kind, enc_key FROM providers WHERE id = 'anthropic'").get() as any;
  assert.equal(row.kind, 'oauth');
  assert.ok(!row.enc_key.includes('access-1'), 'tokens encrypted at rest');
  db.prepare("UPDATE providers SET base_url = ? WHERE id = 'anthropic'").run(fake.url); // route the provider to the fake upstream
  assert.deepEqual(await companyConnections(), [{ id: 'anthropic', name: 'Anthropic', kind: 'oauth', status: 'ok' }]);

  // a plain worker (alice) chats with it: redacted by the gate, sent with the OAuth access token
  const models: any = createModels();
  models.setProvider(build({ id: 'anthropic', baseUrl: fake.url }, companyResolver('anthropic')));
  const from = requests.length;
  const r = await send(models, models.getProvider('anthropic').getModels()[0], ctx('mail ada.lovelace@example.com'), 'u_alice_01CMP', {}); // no apiKey: the provider's own (OAuth) auth applies
  assert.notEqual(r.stopReason, 'error', r.errorMessage);
  assert.equal(requests[from].key, 'access-1');
  assert.ok(!requests[from].raw.includes('ada.lovelace@example.com'));

  // the refresh token stops working: expired
  await new CompanyCredentialStore().modify('anthropic', async (c: any) => ({ ...c, refresh: 'revoked', expires: Date.now() - 1000 }));
  assert.equal((await companyConnections())[0].status, 'expired');
});
