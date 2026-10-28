import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// The OpenAI Responses front for Codex (src/cli-agents/gateway-openai.ts) called directly as a handler, against a scripted OpenAI stand-in
// that records exactly what reaches it: the request goes through unchanged, the connected key is injected, usage is counted.
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-cligwo-'));
process.env.HEFYN_SECRET = 'cli-gateway-openai-secret-cli-gateway-1234';

const vault = await import('../src/server/vault.ts');
vault.setTeamKey(vault.newKey());
const keys: Record<string, Buffer> = {};
for (const u of ['alice', 'bob']) { keys[u] = vault.newKey(); vault.rememberUserKey(u, keys[u]); }

const { createOpenAIGateway } = await import('../src/cli-agents/gateway-openai.ts');
const { db } = await import('../src/server/appdb.ts');
const { connect } = await import('../src/server/providers.ts');
const { saveOAuth } = await import('../src/server/connectors.ts');

const seen: { path: string; auth: string; raw: string }[] = [];
const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
const STREAM = [
  ev('response.created', { response: { id: 'resp_1', status: 'in_progress', output: [] } }),
  ev('response.output_item.added', { output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } }),
  ev('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hello ' }),
  ev('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'world' }),
  ev('response.output_text.done', { item_id: 'msg_1', output_index: 0, content_index: 0, text: 'Hello world' }),
  ev('response.completed', { response: { id: 'resp_1', status: 'completed', output: [{ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello world' }] }], usage: { input_tokens: 100, output_tokens: 42, input_tokens_details: { cached_tokens: 30 } } } }),
].join('');
const JSON_ANSWER = { id: 'resp_2', status: 'completed', model: 'gpt-test', output: [
  { id: 'msg_2', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] },
], usage: { input_tokens: 11, output_tokens: 22 } };
let fake: http.Server, fakeUrl: string;
before(async () => {
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      seen.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? ''), raw });
      if (JSON.parse(raw).stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (let i = 0; i < STREAM.length; i += 37) { res.write(STREAM.slice(i, i + 37)); await new Promise((r) => setTimeout(r, 2)); }
        return void res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(JSON_ANSWER));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  connect({ id: 'openai', baseUrl: `${fakeUrl}/v1` }, 'sk-company-key');
});
after(() => { fake?.close(); });

const CONV = 'u_alice_01CLIGWO';
const EMAIL = 'ada.lovelace@example.com';
const refusals: string[] = [];
const gw = createOpenAIGateway({ userId: 'alice', conversationId: CONV, userKey: keys.alice, onRefusal: (m) => refusals.push(m) });
const call = (path: string, body: unknown, handler = gw, method = 'POST') =>
  handler(new Request('http://gateway' + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer hefyn-gateway' }, body: body === undefined ? undefined : JSON.stringify(body) }));

const request = (extra: object = {}) => ({
  model: 'gpt-test',
  instructions: `You work for ${EMAIL} today.`,
  tools: [{ type: 'function', name: 'send', description: `Send mail, e.g. to ${EMAIL}`, strict: false, parameters: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] } }],
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: `please write to ${EMAIL}` }] },
    { type: 'function_call', call_id: 'c0', name: 'send', arguments: JSON.stringify({ to: EMAIL }) },
    { type: 'function_call_output', call_id: 'c0', output: `sent to ${EMAIL}` },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'thanks' }] },
  ],
  stream: false, store: false,
  ...extra,
});

test('the request reaches the upstream unchanged with the connected key; the answer comes back as sent (non-stream)', async () => {
  seen.length = 0;
  const body = request();
  const res = await call('/v1/responses', body);
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  const up = seen[0];
  assert.equal(up.path, '/v1/responses');
  assert.equal(up.auth, 'Bearer sk-company-key', 'the agent key is ignored, the connected key is used');
  assert.deepEqual(JSON.parse(up.raw), body);
  assert.deepEqual(await res.json(), JSON_ANSWER);
  const u = db.prepare('SELECT * FROM usage WHERE conversation_id = ? ORDER BY id DESC').get(CONV) as any;
  assert.deepEqual([u.user_id, u.provider, u.model, u.input, u.output], ['alice', 'openai', 'gpt-test', 11, 22]);
});

test('stream: events pass through byte for byte and usage comes from the completed response', async () => {
  seen.length = 0;
  const before0 = (db.prepare('SELECT COUNT(*) AS n FROM usage WHERE conversation_id = ?').get(CONV) as any).n;
  const res = await call('/v1/responses', request({ stream: true }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/event-stream/);
  assert.equal(await res.text(), STREAM);
  const rows = db.prepare('SELECT * FROM usage WHERE conversation_id = ?').all(CONV) as any[];
  assert.equal(rows.length, before0 + 1);
  assert.deepEqual([rows.at(-1).input, rows.at(-1).output, rows.at(-1).cache_read], [70, 42, 30]);
});

test('pictures, files and provider-side tools are sent as they are', async () => {
  seen.length = 0;
  const body = { model: 'gpt-test', tools: [{ type: 'web_search' }], input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', filename: 'a.pdf', file_data: 'JVBERi0xLjQ=' }, { type: 'input_image', image_url: 'data:image/png;base64,QUFBQQ==' }] }] };
  assert.equal((await call('/v1/responses', body)).status, 200);
  assert.deepEqual(JSON.parse(seen[0].raw), body);
});

test('a malformed body is refused without reaching the upstream', async () => {
  seen.length = 0;
  assert.equal((await call('/v1/responses', { model: 'gpt-test' })).status, 400);
  assert.equal(seen.length, 0);
});

test('credentials: a ChatGPT sign-in (OAuth) is refused and reported', async () => {
  seen.length = 0; refusals.length = 0;
  const bob = createOpenAIGateway({ userId: 'bob', conversationId: 'u_bob_01CLIGWO', userKey: keys.bob, onRefusal: (m) => refusals.push(m) });
  saveOAuth('bob', 'openai', { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3600_000 } as any);
  const res = await call('/v1/responses', request(), bob);
  assert.equal(res.status, 400, 'Codex retries 403 (and everything else but 400)');
  assert.equal(res.headers.get('x-should-retry'), 'false');
  assert.match(((await res.json()) as any).error.message, /sign-in.*API key/s);
  assert.equal(seen.length, 0);
  assert.equal(refusals.length, 1);
});

test('models are listed; unknown routes are OpenAI-shaped 404s', async () => {
  const m: any = await (await call('/v1/models', undefined, gw, 'GET')).json();
  assert.equal(m.object, 'list'); assert.ok(m.data.length > 0);
  seen.length = 0;
  for (const [meth, p] of [['POST', '/v1/chat/completions'], ['GET', '/v1/responses'], ['POST', '/v1/responses/compact']] as const) {
    const n = await call(p, meth === 'POST' ? {} : undefined, gw, meth);
    assert.equal(n.status, 404);
    assert.equal(((await n.json()) as any).error.type, 'not_found_error');
  }
  assert.equal(seen.length, 0);
});
