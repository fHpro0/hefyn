import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// The model gateway of hosted CLI agents (src/cli-agents/gateway.ts) called directly as a handler, against a scripted Anthropic stand-in
// that records exactly what reaches it: the request goes through unchanged, the connected key is injected, usage is counted.
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-cligw-'));
process.env.HEFYN_SECRET = 'cli-gateway-secret-cli-gateway-secret-1234';

const vault = await import('../src/server/vault.ts');
vault.setTeamKey(vault.newKey());
const keys: Record<string, Buffer> = {};
for (const u of ['alice', 'bob', 'carol']) { keys[u] = vault.newKey(); vault.rememberUserKey(u, keys[u]); }

const { createGateway } = await import('../src/cli-agents/gateway.ts');
const { db } = await import('../src/server/appdb.ts');
const { connect } = await import('../src/server/providers.ts');
const { connectApiKey, saveOAuth } = await import('../src/server/connectors.ts');

// ---- the upstream: records every request, answers by marker ----
const seen: { path: string; key: string; version: string; beta: string; raw: string }[] = [];
const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
const STREAM = [
  ev('message_start', { message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 } } }),
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello ' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'world' } }),
  ev('content_block_stop', { index: 0 }),
  ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }),
  ev('message_stop', {}),
].join('');
const JSON_ANSWER = { id: 'm2', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 22 }, content: [{ type: 'text', text: 'Hello' }] };
let fake: http.Server, fakeUrl: string;
before(async () => {
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      seen.push({ path: req.url ?? '', key: String(req.headers['x-api-key'] ?? ''), version: String(req.headers['anthropic-version'] ?? ''), beta: String(req.headers['anthropic-beta'] ?? ''), raw });
      if (req.url?.startsWith('/v1/messages/count_tokens')) return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":7}');
      if (JSON.parse(raw).stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (let i = 0; i < STREAM.length; i += 37) { res.write(STREAM.slice(i, i + 37)); await new Promise((r) => setTimeout(r, 2)); } // arbitrary chunking, events cut in the middle
        return void res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(JSON_ANSWER));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  connect({ id: 'anthropic', baseUrl: fakeUrl }, 'sk-ant-company-key');
});
after(() => { fake?.close(); });

const CONV = 'u_alice_01CLIGW';
const EMAIL = 'ada.lovelace@example.com';
const gw = createGateway({ userId: 'alice', conversationId: CONV, userKey: keys.alice });
const call = (path: string, body: unknown, handler = gw, headers: Record<string, string> = {}, method = 'POST') =>
  handler(new Request('http://gateway' + path, { method, headers: { 'content-type': 'application/json', 'x-api-key': 'hefyn-gateway', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }));

const request = (extra: object = {}) => ({
  model: 'claude-test', max_tokens: 100,
  system: [{ type: 'text', text: `You work for ${EMAIL} today.` }, { type: 'text', text: 'Be brief.' }],
  tools: [{ name: 'send', description: `Send mail, e.g. to ${EMAIL}`, input_schema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] } }],
  messages: [
    { role: 'user', content: `please write to ${EMAIL}` },
    { role: 'assistant', content: [{ type: 'text', text: `ok, ${EMAIL}` }, { type: 'tool_use', id: 'tu0', name: 'send', input: { to: EMAIL } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu0', content: `sent to ${EMAIL}` }, { type: 'text', text: 'thanks' }] },
  ],
  ...extra,
});

test('the request reaches the upstream unchanged with the connected key; the answer comes back as sent (non-stream)', async () => {
  seen.length = 0;
  const body = request();
  const res = await call('/v1/messages?beta=true', body, gw, { 'anthropic-beta': 'x-beta', 'anthropic-version': '2023-06-01' });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  const up = seen[0];
  assert.equal(up.path, '/v1/messages?beta=true');
  assert.equal(up.key, 'sk-ant-company-key', 'the agent key is ignored, the connected key is used');
  assert.equal(up.beta, 'x-beta'); assert.equal(up.version, '2023-06-01');
  assert.deepEqual(JSON.parse(up.raw), body);
  assert.deepEqual(await res.json(), JSON_ANSWER);
  const u = db.prepare('SELECT * FROM usage WHERE conversation_id = ? ORDER BY id DESC').get(CONV) as any;
  assert.deepEqual([u.user_id, u.provider, u.model, u.input, u.output], ['alice', 'anthropic', 'claude-test', 11, 22]);
});

test('stream: events pass through byte for byte and usage comes from message_start / message_delta', async () => {
  seen.length = 0;
  const before0 = (db.prepare('SELECT COUNT(*) AS n FROM usage WHERE conversation_id = ?').get(CONV) as any).n;
  const res = await call('/v1/messages', request({ stream: true }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/event-stream/);
  assert.equal(await res.text(), STREAM);
  const rows = db.prepare('SELECT * FROM usage WHERE conversation_id = ?').all(CONV) as any[];
  assert.equal(rows.length, before0 + 1);
  const u = rows.at(-1);
  assert.deepEqual([u.input, u.output, u.cache_read, u.cache_write], [100, 42, 5, 7]);
});

test('count_tokens is forwarded; unknown routes are Anthropic-shaped 404s', async () => {
  seen.length = 0;
  const r = await call('/v1/messages/count_tokens', request());
  assert.deepEqual(await r.json(), { input_tokens: 7 });
  assert.equal(seen[0].path, '/v1/messages/count_tokens');
  for (const [m, p] of [['GET', '/v1/models'], ['POST', '/v1/complete'], ['GET', '/v1/messages']] as const) {
    const n = await call(p, m === 'POST' ? {} : undefined, gw, {}, m);
    assert.equal(n.status, 404);
    const j: any = await n.json();
    assert.equal(j.type, 'error'); assert.equal(j.error.type, 'not_found_error');
  }
  assert.equal(seen.length, 1);
});

test('documents and pictures are sent as they are', async () => {
  seen.length = 0;
  const doc = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' } };
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUFBQQ==' } };
  const body = { model: 'claude-test', max_tokens: 5, messages: [{ role: 'user', content: [doc, img, { type: 'text', text: 'x' }] }] };
  assert.equal((await call('/v1/messages', body)).status, 200);
  assert.deepEqual(JSON.parse(seen[0].raw), body);
});

test('a malformed body is refused without reaching the upstream', async () => {
  seen.length = 0;
  assert.equal((await call('/v1/messages', 'not json')).status, 400);
  assert.equal((await call('/v1/messages', { model: 'x' })).status, 400);
  assert.equal(seen.length, 0);
});

test('credentials: a Claude subscription (OAuth) is refused, a user API key beats the company key', async () => {
  seen.length = 0;
  const bobConv = 'u_bob_01CLIGW';
  const bob = createGateway({ userId: 'bob', conversationId: bobConv, userKey: keys.bob });
  saveOAuth('bob', 'anthropic', { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3600_000 } as any);
  const res = await call('/v1/messages', request(), bob);
  assert.equal(res.status, 403);
  const j: any = await res.json();
  assert.equal(j.error.type, 'permission_error');
  assert.match(j.error.message, /subscription.*API key/s);
  assert.equal(seen.length, 0);

  const carolConv = 'u_carol_01CLIGW';
  connectApiKey('carol', { id: 'anthropic', baseUrl: fakeUrl }, 'sk-ant-carol-own');
  const carol = createGateway({ userId: 'carol', conversationId: carolConv, userKey: keys.carol });
  assert.equal((await call('/v1/messages', request(), carol)).status, 200);
  assert.equal(seen[0].key, 'sk-ant-carol-own');
  assert.equal(db.prepare('SELECT provider FROM usage WHERE conversation_id = ?').get(carolConv)?.provider, 'u-carol-anthropic');

  // a company connection that is a subscription is refused too
  db.prepare("UPDATE providers SET kind = 'oauth' WHERE id = 'anthropic'").run();
  try {
    const alice = await call('/v1/messages', request());
    assert.equal(alice.status, 403);
    assert.equal(seen.length, 1);
  } finally { db.prepare("UPDATE providers SET kind = 'api_key' WHERE id = 'anthropic'").run(); }
});
