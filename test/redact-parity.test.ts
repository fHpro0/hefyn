import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { after, test } from 'node:test';
import { EntropyDetector } from '../src/server/redact/entropy.ts';
import { GlinerClient } from '../src/server/redact/gliner-client.ts';
import { guard } from '../src/server/redact/guard.ts';
import { redactWith } from '../src/server/redact/index.ts';
import { modelDir, verifyModel } from '../src/server/redact/models.ts';
import { RegexDetector } from '../src/server/redact/rules.ts';

// Differential test: the TypeScript engine against outputs recorded from the Rust sidecar it was ported from
// (warden-redact fe15b9f + services/redact), over test/fixtures/redact-corpus.json.gz. Regenerate the corpus with
// scripts/redact-corpus.ts and the expectations with scripts/redact-parity-gen.ts against a running sidecar.
// Fixtures are gzipped so secret scanners don't flag the fake keys inside them.
const fx = (n: string) => JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/${n}.gz`, import.meta.url))).toString('utf8'));
const { cases, guard: guardCases } = fx('redact-corpus.json');
const plain = fx('redact-expected-nogliner.json'), model = fx('redact-expected-gliner.json');
const base = () => [new RegexDetector(), new EntropyDetector()];

test('parity (regex + entropy): texts, placeholder names and findings are identical to the Rust engine', async () => {
  for (const c of cases) assert.deepEqual(await redactWith(base(), c.texts, c.vars ?? []), plain.redact[c.name], c.name);
});

test('parity: prompt-injection guard verdicts are identical', () => {
  guardCases.forEach((t: string, i: number) => assert.deepEqual(guard(t), plain.guard[i], JSON.stringify(t)));
});

// The Rust engine returned HTTP 500 for whitespace-only input with GLiNER on (zero-word ONNX input); the port skips such chunks
// instead, so there the expectation is the regex + entropy answer.
const rustFailed = new Set(Object.entries(model.redact).filter(([, v]: any) => v.error).map(([k]) => k));

const present = (await verifyModel(modelDir())).ok;
let client: GlinerClient | undefined;
after(() => client?.stop());
test('parity (GLiNER on): same entities as the Rust engine', { skip: present ? false : `GLiNER model files not found in ${modelDir()} (the web service downloads them; set HEFYN_REDACT_MODEL_DIR)`, timeout: 600_000 }, async () => {
  client = new GlinerClient({ dir: modelDir() });
  for (let i = 0; client.state !== 'ready'; i++) { assert.ok(i < 600 && client.state !== 'error', `GLiNER not ready: ${client.error}`); await new Promise((r) => setTimeout(r, 100)); }
  for (const c of cases) {
    const want = rustFailed.has(c.name) ? plain.redact[c.name] : model.redact[c.name];
    assert.deepEqual(await redactWith([...base(), client], c.texts, c.vars ?? []), want, c.name);
  }
});

test('parity (GLiNER on, over HTTP): the redact service answers like the Rust engine', { skip: present ? false : `GLiNER model files not found in ${modelDir()}`, timeout: 600_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const port = 4600 + Math.floor(Math.random() * 300), token = 'parity-token-parity-token-parity-1234';
  const svc = spawn('node', ['dist/redact-server.mjs'], { env: { ...process.env, PORT: String(port), HEFYN_REDACT_HOST: '127.0.0.1', HEFYN_REDACT_GLINER: 'on', HEFYN_REDACT_MODEL_DIR: modelDir(), HEFYN_INTERNAL_TOKEN: token }, stdio: 'inherit' });
  const call = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-hefyn-internal': token }, body: body ? JSON.stringify(body) : undefined });
  try {
    for (let i = 0; ; i++) { assert.ok(i < 600, 'the service never became ready'); if ((await call('/health').then((r) => r.json(), () => ({}))).ready) break; await new Promise((r) => setTimeout(r, 100)); }
    for (const c of cases) {
      const want = rustFailed.has(c.name) ? plain.redact[c.name] : model.redact[c.name];
      assert.deepEqual(await (await call('/redact', { texts: c.texts, vars: c.vars ?? [] })).json(), want, c.name);
    }
  } finally { svc.kill(); }
});
