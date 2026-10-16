// Latency and memory of the redaction path, GLiNER on. Usage:
//   node scripts/redact-bench.ts ts                      in-process engine (worker thread), HEFYN_REDACT_MODEL_DIR=<model dir>
//   node scripts/redact-bench.ts http://127.0.0.1:8787   a Rust sidecar (the engine before the port), for comparison
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';

const target = process.argv[2] ?? 'ts';
const doc: string = JSON.parse(gunzipSync(readFileSync(new URL('../test/fixtures/redact-corpus.json.gz', import.meta.url))).toString('utf8')).cases.find((c: any) => c.name === 'mixed_10k').texts[0];
const run = target === 'ts'
  ? await (async () => { const { redact, health } = await import('../src/server/redact/index.ts'); process.env.HEFYN_REDACT_GLINER ??= 'on'; await redact(['warmup']).catch(() => {}); for (let i = 0; health().gliner !== 'ready' && i < 600; i++) await new Promise((r) => setTimeout(r, 100)); return (t: string) => redact([t]); })()
  : (t: string) => fetch(`${target}/redact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts: [t] }) }).then((r) => r.json());
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
for (const n of [1000, 10_000]) {
  const t = doc.slice(0, n);
  for (let i = 0; i < 3; i++) await run(t);
  const ms: number[] = [];
  for (let i = 0; i < 30; i++) { const s = performance.now(); await run(t); ms.push(performance.now() - s); }
  console.log(`${target} ${n} chars: p50 ${pct(ms, 0.5).toFixed(0)} ms, p95 ${pct(ms, 0.95).toFixed(0)} ms`);
}
if (target === 'ts') console.log(`rss ${(process.memoryUsage.rss() / 2 ** 20).toFixed(0)} MB (whole process incl. worker thread and model)`);
else console.log(`rss ${(Number(execSync(`ps -o rss= -p $(lsof -ti tcp:${new URL(target).port} -sTCP:LISTEN | head -1)`).toString().trim()) / 1024).toFixed(0)} MB (sidecar process)`);
process.exit(0); // the GLiNER worker thread would keep the process alive
