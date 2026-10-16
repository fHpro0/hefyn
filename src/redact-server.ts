import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { glinerOn, guard, health, redact, startEngine } from './server/redact/index.ts';

// The redaction service: hefyn's redaction engine (regex, entropy, GLiNER in worker threads) behind a small HTTP API. Internal network
// only, internal token required. Fail closed: anything but a complete answer is a non-2xx status, the caller blocks. It has no internet:
// the GLiNER files are downloaded by web into a shared volume; this process only reads and verifies them, and stays warm when agent/web restart.
//   POST /redact {texts, vars}  -> {texts, newVars, findings}      POST /guard {text} -> {flagged, score, reason}
//   GET /health -> 200|503 {ready, detectors, gliner, pid, startedAt}      GET /live -> 200 (process is up; the compose healthcheck)

const digest = (s: string) => createHash('sha256').update(s).digest();
export const tokenOk = (given: string | undefined, expected: string) => !!expected && timingSafeEqual(digest(given ?? ''), digest(expected));

export interface Options { token: string; maxBody?: number; requestTimeoutMs?: number }
const startedAt = new Date().toISOString();

class Fail extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

async function body(req: http.IncomingMessage, max: number): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > max) throw new Fail(413, 'request body too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Fail(400, 'invalid JSON'); }
}

export function createServer(o: Options) {
  const max = o.maxBody ?? 20 << 20, timeout = o.requestTimeoutMs ?? 120_000;
  const withTimeout = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Fail(504, 'redaction timed out')), timeout).unref())]);
  const server = http.createServer(async (req, res) => {
    const send = (status: number, j: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(j));
    try {
      if (!tokenOk(req.headers['x-hefyn-internal'] as string | undefined, o.token)) throw new Fail(401, 'unauthorized');
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && path === '/live') return send(200, { ok: true });
      if (req.method === 'GET' && path === '/health') { const h = health(); return send(h.ready ? 200 : 503, { ...h, pid: process.pid, startedAt }); }
      if (req.method === 'POST' && path === '/redact') {
        const b = await body(req, max);
        if (!Array.isArray(b?.texts) || !b.texts.every((t: unknown) => typeof t === 'string')) throw new Fail(400, 'texts must be an array of strings');
        const vars = b.vars ?? [];
        if (!Array.isArray(vars) || !vars.every((v: any) => typeof v?.name === 'string' && typeof v?.value === 'string')) throw new Fail(400, 'vars must be [{name, value}]');
        if (!health().ready) throw new Fail(503, 'redaction detectors are not ready');
        return send(200, await withTimeout(redact(b.texts, vars)));
      }
      if (req.method === 'POST' && path === '/guard') {
        const b = await body(req, max);
        if (typeof b?.text !== 'string') throw new Fail(400, 'text must be a string');
        return send(200, await withTimeout(guard(b.text)));
      }
      throw new Fail(req.url === '/redact' || req.url === '/guard' || req.url === '/health' ? 405 : 404, 'not found');
    } catch (e) {
      if (e instanceof Fail) { if (e.status === 413) res.setHeader('connection', 'close'); return send(e.status, { error: e.message }); }
      send(500, { error: (e as Error).message }); // detector failure: never partial output
    }
  });
  server.requestTimeout = timeout + 10_000;
  server.headersTimeout = 15_000;
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const prod = process.env.NODE_ENV === 'production';
  const token = process.env.HEFYN_INTERNAL_TOKEN ?? (prod ? '' : 'hefyn-dev-internal-token');
  if (prod && (token.length < 32 || token.startsWith('dev-only'))) { console.error('[hefyn-redact] HEFYN_INTERNAL_TOKEN missing, a dev-only placeholder, or shorter than 32 characters.'); process.exit(1); }
  startEngine();
  const port = Number(process.env.PORT ?? 8787);
  createServer({ token, requestTimeoutMs: Number(process.env.HEFYN_REDACT_REQUEST_TIMEOUT_MS) || undefined }).listen(port, process.env.HEFYN_REDACT_HOST ?? '0.0.0.0', () => console.log(`[hefyn-redact] listening on :${port} (gliner ${glinerOn() ? 'on' : 'off'})`));
}
