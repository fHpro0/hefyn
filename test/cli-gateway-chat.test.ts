import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// The OpenAI chat completions front for OpenCode, Pi ... (src/cli-agents/gateway-chat.ts) called as a handler, against scripted OpenAI-compatible
// stand-ins that record exactly what reaches them. The provider comes from the session (keyPolicy.session).
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-cligwc-'));
process.env.HEFYN_SECRET = 'cli-gateway-chat-secret-cli-gateway-chat-1234';

const vault = await import('../src/server/vault.ts');
vault.setTeamKey(vault.newKey());
const keys: Record<string, Buffer> = {};
for (const u of ['alice', 'bob']) { keys[u] = vault.newKey(); vault.rememberUserKey(u, keys[u]); }

const { createChatGateway } = await import('../src/cli-agents/gateway-chat.ts');
const { keyPolicy } = await import('../src/cli-agents/access.ts');
const { modelFront } = await import('../src/cli-agents/host.ts');
const { db } = await import('../src/server/appdb.ts');
const { connect } = await import('../src/server/providers.ts');
const { connectApiKey } = await import('../src/server/connectors.ts');

const seen: { server: string; path: string; auth: string; raw: string }[] = [];
const chunk = (d: object, finish: string | null = null, extra: object = {}) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: d, finish_reason: finish }], ...extra })}\n\n`;
const STREAM = [
  chunk({ role: 'assistant', content: '' }),
  chunk({ content: 'Hello ' }),
  chunk({ content: 'world' }, 'stop'),
  chunk({}, null, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 42, prompt_tokens_details: { cached_tokens: 30 } } }),
  'data: [DONE]\n\n',
].join('');
const JSON_ANSWER = { id: 'c2', object: 'chat.completion', model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello' } }], usage: { prompt_tokens: 11, completion_tokens: 22 } };
let fakes: http.Server[] = [], urls: string[] = [];
const serve = async (name: string) => {
  const s = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      seen.push({ server: name, path: req.url ?? '', auth: String(req.headers.authorization ?? ''), raw });
      if (JSON.parse(raw).stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (let i = 0; i < STREAM.length; i += 37) { res.write(STREAM.slice(i, i + 37)); await new Promise((r) => setTimeout(r, 2)); }
        return void res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(JSON_ANSWER));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  fakes.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
before(async () => {
  urls = [await serve('openrouter'), await serve('custom')];
  connect({ id: 'openrouter', baseUrl: `${urls[0]}/v1` }, 'sk-or-company');
  connect({ id: 'custom', baseUrl: `${urls[1]}/v1`, models: ['local-1'] }, 'sk-custom-company');
});
after(() => { fakes.forEach((f) => f.close()); });

const CONV = 'u_alice_01CLIGWC';
const EMAIL = 'ada.lovelace@example.com';
const refusals: string[] = [];
const gw = createChatGateway({ userId: 'alice', conversationId: CONV, userKey: keys.alice, onRefusal: (m) => refusals.push(m) });
const call = (body: unknown, session: string | undefined = 'openrouter', handler = gw, path = '/v1/chat/completions', pin: string | null = null) =>
  keyPolicy.run({ provider: pin, session }, () => handler(new Request('http://gateway' + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer hefyn-gateway' }, body: JSON.stringify(body) })));

const request = (extra: object = {}) => ({
  model: 'acme/model-x',
  messages: [
    { role: 'system', content: `You work for ${EMAIL} today.` },
    { role: 'user', content: [{ type: 'text', text: `please write to ${EMAIL}` }] },
    { role: 'assistant', content: `ok, ${EMAIL}`, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'send', arguments: JSON.stringify({ to: EMAIL }) } }] },
    { role: 'tool', tool_call_id: 'c0', name: 'send', content: `sent to ${EMAIL}` },
    { role: 'user', content: 'thanks' },
  ],
  tools: [{ type: 'function', function: { name: 'send', description: `Send mail, e.g. to ${EMAIL}`, parameters: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] } } }],
  stream: false,
  ...extra,
});

test('the request reaches the session provider unchanged with its key; the answer comes back as sent (non-stream)', async () => {
  const body = request();
  const res = await call(body);
  assert.equal(res.status, 200);
  const up = seen.at(-1)!;
  assert.deepEqual([up.server, up.path, up.auth], ['openrouter', '/v1/chat/completions', 'Bearer sk-or-company'], 'the agent key is ignored, the connected key is used');
  assert.deepEqual(JSON.parse(up.raw), body);
  assert.deepEqual(await res.json(), JSON_ANSWER);
  const u = db.prepare('SELECT * FROM usage WHERE conversation_id = ? ORDER BY id DESC').get(CONV) as any;
  assert.deepEqual([u.user_id, u.provider, u.model, u.input, u.output], ['alice', 'openrouter', 'acme/model-x', 11, 22]);
});

test('stream: events pass through byte for byte, usage is asked for and counted', async () => {
  const n0 = (db.prepare('SELECT COUNT(*) AS n FROM usage WHERE conversation_id = ?').get(CONV) as any).n;
  const res = await call(request({ stream: true }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/event-stream/);
  assert.equal(JSON.parse(seen.at(-1)!.raw).stream_options.include_usage, true, 'usage is asked for');
  assert.equal(await res.text(), STREAM);
  const rows = db.prepare('SELECT * FROM usage WHERE conversation_id = ?').all(CONV) as any[];
  assert.equal(rows.length, n0 + 1);
  assert.deepEqual([rows.at(-1).input, rows.at(-1).output, rows.at(-1).cache_read], [70, 42, 30]);
});

test('pictures and files are sent as they are', async () => {
  const body = { model: 'm', messages: [{ role: 'user', content: [{ type: 'file', file: { filename: 'a.pdf', file_data: 'JVBERi0xLjQ=' } }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUFBQQ==' } }, { type: 'text', text: 'x' }] }] };
  assert.equal((await call(body)).status, 200);
  assert.deepEqual(JSON.parse(seen.at(-1)!.raw), body);
});

test('provider routing: the session decides the upstream; a request on another front or without a chat provider reaches nobody', async () => {
  const n = seen.length;
  assert.equal((await call(request(), 'custom')).status, 200);
  assert.deepEqual([seen.at(-1)!.server, seen.at(-1)!.auth], ['custom', 'Bearer sk-custom-company']);
  for (const session of ['', 'anthropic', 'nope']) { // '' = the session names no provider
    const res = await call(request(), session);
    assert.equal(res.status, 400); assert.match(((await res.json()) as any).error.message, /does not run on an OpenAI-compatible provider/);
  }
  // the socket handler: the session's provider is not reached through the other fronts, so a forged /v1/messages or /v1/responses is refused
  const front = modelFront({ userId: 'alice', conversationId: CONV, userKey: keys.alice }, () => 'openrouter');
  for (const p of ['/v1/messages', '/v1/responses']) assert.equal((await front(new Request('http://g' + p, { method: 'POST', body: '{}' }))).status, 400);
  assert.equal((await front(new Request('http://g/v1/chat/completions', { method: 'POST', body: JSON.stringify(request()) }))).status, 200);
  const none = modelFront({ userId: 'alice', conversationId: CONV, userKey: keys.alice }, () => 'anthropic');
  assert.equal((await none(new Request('http://g/v1/chat/completions', { method: 'POST', body: JSON.stringify(request()) }))).status, 400);
  assert.equal(seen.length, n + 2, 'only the two valid calls got through');
});

test('credentials: the user\'s own key first, the admin\'s pin wins, a provider that is not connected refuses', async () => {
  const bob = createChatGateway({ userId: 'bob', conversationId: 'u_bob_01CLIGWC', userKey: keys.bob });
  assert.equal((await call(request(), 'openrouter', bob)).status, 200);
  assert.equal(seen.at(-1)!.auth, 'Bearer sk-or-company');
  connectApiKey('bob', { id: 'openrouter', baseUrl: `${urls[0]}/v1` }, 'sk-or-bob-own');
  await call(request(), 'openrouter', bob); assert.equal(seen.at(-1)!.auth, 'Bearer sk-or-bob-own');
  await call(request(), 'openrouter', bob, '/v1/chat/completions', 'openrouter'); assert.equal(seen.at(-1)!.auth, 'Bearer sk-or-company', 'pinned: the company\'s connection, the user\'s own is ignored');
  const n = seen.length;
  const res = await call(request(), 'mistral', bob);
  assert.equal(res.status, 403); assert.match(((await res.json()) as any).error.message, /No Mistral API key is connected/);
  assert.equal(seen.length, n);
});

test('unknown routes are OpenAI-shaped 404s', async () => {
  const n = seen.length;
  for (const p of ['/v1/models', '/v1/chat/completions/x']) {
    const r = await keyPolicy.run({ provider: null, session: 'openrouter' }, () => gw(new Request('http://gateway' + p, { method: 'GET' })));
    assert.equal(r.status, 404); assert.equal(((await r.json()) as any).error.type, 'not_found_error');
  }
  assert.equal(seen.length, n);
});
