// `bun run test [pattern…]`: every test file in its own `bun test` process (module singletons, env and ports must not leak between files),
// a few at a time (Docker-heavy files one after another), then one summary. A file name fragment on the command line selects files; HEFYN_TEST_JOBS sets the parallelism.
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const only = process.argv.slice(2);
const files = readdirSync('test').filter((f) => f.endsWith('.test.ts') && (!only.length || only.some((o) => f.includes(o)))).sort();
const jobs = Number(process.env.HEFYN_TEST_JOBS) || 4;
const results: { file: string; pass: number; fail: number; skip: number; code: number; out: string; secs: number }[] = [];

async function runOne(file: string) {
  const t = Date.now();
  const p = Bun.spawn(['bun', 'test', '--timeout', '120000', `./test/${file}`], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HEFYN_MODULES_DISABLED: process.env.HEFYN_MODULES_DISABLED ?? '', HEFYN_DATA_DIR: mkdtempSync(join(tmpdir(), 'hefyn-test-')) } }); // a test that sets its own dir wins; none may fall back to the real ./data
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  const out = o + e;
  const n = (k: string) => Number(new RegExp(`^\\s*(\\d+) ${k}`, 'm').exec(out)?.[1] ?? 0);
  results.push({ file, pass: n('pass'), fail: n('fail'), skip: n('skip'), code, out, secs: (Date.now() - t) / 1000 });
  console.log(`${code === 0 ? 'ok  ' : 'FAIL'} ${file} (${n('pass')} pass, ${n('fail')} fail, ${n('skip')} skip, ${((Date.now() - t) / 1000).toFixed(1)}s)`);
}

// Files that start real containers share one Docker daemon and time out when run side by side: they get one serial lane of their own.
const heavy = (f: string) => /^cli-agent-|^container-sandbox/.test(f);
const lane = async (q: string[]) => { for (let f; (f = q.shift()); ) await runOne(f); };
const docker = files.filter(heavy), queue = files.filter((f) => !heavy(f));
await Promise.all([lane(docker), ...Array.from({ length: Math.max(1, jobs - 1) }, () => lane(queue))]);

const bad = results.filter((r) => r.code !== 0);
for (const r of bad) console.log(`\n===== ${r.file} (exit ${r.code}) =====\n${r.out}`);
const sum = (k: 'pass' | 'fail' | 'skip') => results.reduce((a, r) => a + r[k], 0);
console.log(`\n${files.length} files, ${sum('pass')} pass, ${sum('fail')} fail, ${sum('skip')} skip${bad.length ? `; failing files: ${bad.map((r) => r.file).join(', ')}` : ''}`);
process.exit(bad.length ? 1 : 0);
