import { GlinerClient } from './gliner-client.ts';
import { modelDir } from './models.ts';
import { Redactor } from './redactor.ts';
import type { Detector } from './redactor.ts';
import { WorkerPool } from './pool.ts';
import { workerPath } from './worker-path.ts';
import { RedactError } from './spans.ts';
import type { Span } from './spans.ts';

// hefyn's redaction engine: a TypeScript port of warden's redaction crate (regex rules, entropy, GLiNER via ONNX in a worker
// thread, span merging) plus what the former sidecar added on top: stable `{{var:LABEL_n}}` placeholders, reuse of known
// values, findings. Runs inside the redact service (src/redact-server.ts); fail closed everywhere (a detector problem throws, nothing is returned partially redacted).

export type GlinerStatus = 'ready' | 'loading' | 'off' | 'error';
export interface Health { ready: boolean; gliner: GlinerStatus; detectors: string[] }
export interface Var { name: string; value: string }
export interface NewVar { name: string; value: string; label: string }
export interface RedactResult { texts: string[]; newVars: NewVar[]; findings: { label: string; count: number }[] }

/** Tag as the sidecar renders it (uppercase, non-alphanumerics -> `_`, at most 56 chars), valid as a var name start. */
export const varTag = (label: string) => { const t = Array.from(label).slice(0, 56).map((c) => (/^[A-Za-z0-9]$/.test(c) ? c.toUpperCase() : '_')).join(''); return /^[A-Z]/.test(t) ? t : `V${t}`; };

/** Re-finds values that already have a name, so a value the models missed this time is still replaced. */
class Known implements Detector {
  readonly name = 'variable';
  private known: [string, string][];
  constructor(known: [string, string][]) { this.known = known; }
  detect(text: string): Span[] {
    const out: Span[] = [];
    for (const [label, v] of this.known) for (let i = text.indexOf(v); i >= 0; i = text.indexOf(v, i + v.length)) out.push({ start: i, end: i + v.length, label, detector: 'variable', score: 1 });
    return out;
  }
}

/** The sidecar's /redact: texts are redacted in order, placeholders numbered per label, known values reuse their names. */
export async function redactWith(base: Detector[], texts: string[], vars: Var[] = []): Promise<RedactResult> {
  const names = new Map<string, string>(); // value -> name
  const counters = new Map<string, number>();
  const known: [string, string][] = [];
  for (const v of vars.filter((v) => Buffer.byteLength(v.value) >= 3)) {
    names.set(v.value, v.name);
    const m = /^(.*)_(\d+)$/.exec(v.name), prefix = m ? m[1] : v.name;
    if (m && Number.isSafeInteger(Number(m[2]))) counters.set(prefix, Math.max(counters.get(prefix) ?? 0, Number(m[2])));
    known.push([prefix, v.value]);
  }
  const redactor = new Redactor([...base, new Known(known)]);
  const newVars: NewVar[] = [], counts = new Map<string, number>(), out: string[] = [];
  for (const t of texts) {
    const r = await redactor.redactRender(t, (span, original) => {
      let name = names.get(original);
      if (!name) {
        const label = varTag(span.label), n = (counters.get(label) ?? 0) + 1;
        counters.set(label, n);
        name = `${label}_${n}`;
        names.set(original, name);
        newVars.push({ name, value: original, label });
      }
      return `{{var:${name}}}`;
    });
    for (const [l, c] of r.counts) counts.set(varTag(l), (counts.get(varTag(l)) ?? 0) + c);
    out.push(r.text);
  }
  const findings = [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([label, count]) => ({ label, count }));
  return { texts: out, newVars, findings };
}

// Regex, entropy and guard run in a small worker pool, never on the main thread: a pathological input can only stall (and lose) its own
// worker, the job fails closed after the hard timeout and the worker is replaced. HEFYN_REDACT_WORKERS (2), HEFYN_REDACT_TIMEOUT_MS (10000).
let pool: WorkerPool | undefined;
const getPool = () => pool ??= new WorkerPool({ file: workerPath('detect-worker'), size: Number(process.env.HEFYN_REDACT_WORKERS) || 2, timeoutMs: Number(process.env.HEFYN_REDACT_TIMEOUT_MS) || 10_000 });
/** The regex + entropy detectors, run in the pool (spans of both, regex first like the sequential order). */
const pooled: Detector = { name: 'regex+entropy', detect: (text) => getPool().run<Span[]>({ kind: 'detect', text }) };
const baseNames = ['regex', 'entropy'];
export const glinerOn = () => (process.env.HEFYN_REDACT_GLINER ?? 'on').toLowerCase() !== 'off';

/** Prompt-injection check (hub content screening). Runs in the pool; a timeout or crash throws: the caller must deny. */
export const guard = (text: string): Promise<{ flagged: boolean; score: number; reason: string }> => getPool().run({ kind: 'guard', text });

let client: GlinerClient | undefined;
/** Starts the GLiNER worker supervisor (agent). No-op when GLiNER is off or already started. */
export function startEngine() { if (glinerOn()) client ??= new GlinerClient({ dir: modelDir(), timeoutMs: Number(process.env.HEFYN_REDACT_GLINER_TIMEOUT_MS) || 60_000 }); }
export function stopEngine() { client?.stop(); client = undefined; pool?.stop(); pool = undefined; }

/** In-process readiness, cheap and synchronous. Never throws. */
export function health(): Health {
  if (!glinerOn()) return { ready: true, gliner: 'off', detectors: baseNames };
  const gliner: GlinerStatus = client ? client.state : 'loading';
  return { ready: gliner === 'ready', gliner, detectors: gliner === 'ready' ? [...baseNames, 'gliner'] : [] };
}

/** The sidecar's POST /redact. Throws (fail closed) when a detector is not ready or fails. */
export async function redact(texts: string[], vars: Var[] = []): Promise<RedactResult> {
  startEngine();
  const h = health();
  if (!h.ready) throw new RedactError(`redaction detectors are not ready (GLiNER ${h.gliner}${client?.error ? `: ${client.error}` : ''})`);
  return redactWith(client ? [pooled, client] : [pooled], texts, vars);
}
