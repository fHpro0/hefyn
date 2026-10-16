// Regenerates a parity fixture from a running Rust sidecar (services/redact @ git history, or any compatible HTTP service):
//   node scripts/redact-parity-gen.ts http://127.0.0.1:8787 test/fixtures/redact-expected-nogliner.json.gz
// The Rust sidecar was the reference implementation the TypeScript engine was ported from and verified against.
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

const [url, out] = process.argv.slice(2);
const { cases, guard } = JSON.parse(gunzipSync(readFileSync(new URL('../test/fixtures/redact-corpus.json.gz', import.meta.url))).toString('utf8'));
const post = async (path: string, body: unknown) => {
  const res = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.ok ? await res.json() : { error: `HTTP ${res.status}` };
};
const expected: Record<string, unknown> = {};
for (const c of cases) expected[c.name] = await post('/redact', { texts: c.texts, vars: c.vars ?? [] });
const guards = [];
for (const t of guard) guards.push(await post('/guard', { text: t }));
writeFileSync(out, gzipSync(JSON.stringify({ redact: expected, guard: guards }, null, 1) + '\n'));
console.log(`${Object.keys(expected).length} cases, ${guards.length} guards -> ${out}`);
