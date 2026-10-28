import net, { type Socket } from 'node:net';
import { whenRoom } from '../server/container-fs.ts';
import { teamHomes } from './team-accounts.ts';

// Client of the runner's attach endpoint (services/runner, docs/SANDBOX.md): a long-lived process in the user's sandbox over an HTTP Upgrade.
// A raw socket, not fetch or http.request: Bun's http client never emits `upgrade`. Bytes after the 101 are the process's stdout (tty: stdout+stderr)
// and, the other way, its stdin. tty:false only forwards stdout; a client FIN is stdin-EOF, destroy() ends it for good (the runner kills the process).

export interface AttachSpec { cmd: string[]; tty: boolean; cwd?: string; env?: Record<string, string>; cols?: number; rows?: number }
export interface Proc { stream: Socket | import('node:stream').Duplex; resize(cols: number, rows: number): Promise<void> }
export type Attach = (userId: string, conversationId: string, spec: AttachSpec) => Promise<Proc>;

export interface RunnerOpts { url?: string; token?: string; fetch?: typeof fetch; retryMs?: number }

export function runnerAttach(o: RunnerOpts = {}): Attach {
  return async (userId, conversationId, spec) => {
    const base = new URL((o.url ?? process.env.HEFYN_RUNNER_URL ?? '').replace(/\/$/, '') || 'http://runner:8790');
    const token = o.token ?? process.env.HEFYN_INTERNAL_TOKEN ?? '';
    const headers = { 'x-hefyn-internal': token, 'content-type': 'application/json' };
    const handle = await whenRoom(userId, conversationId, async () => {
      const res = await (o.fetch ?? fetch)(`${base.origin}/sandboxes`, { method: 'POST', headers, body: JSON.stringify({ userId, conversationId, teamHomes: teamHomes(userId) }) });
      const j: any = await res.json().catch(() => ({}));
      if (res.status !== 200) throw new Error(`sandbox unavailable (${res.status}): ${j.error ?? 'unknown error'}`);
      return j.id as string;
    }, o.retryMs);
    const sock = net.connect(Number(base.port) || 80, base.hostname);
    sock.write(`POST /sandboxes/${handle}/attach?spec=${encodeURIComponent(JSON.stringify(spec))} HTTP/1.1\r\nHost: ${base.host}\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\nx-hefyn-internal: ${token}\r\n\r\n`);
    const execId = await new Promise<string>((resolve, reject) => {
      let head = Buffer.alloc(0);
      const fail = (m: string) => { sock.destroy(); reject(new Error(m)); };
      const on = (c: Buffer) => {
        head = Buffer.concat([head, c]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        sock.off('data', on);
        sock.pause();
        const text = head.toString('latin1', 0, end), rest = head.subarray(end + 4);
        const status = Number(/^HTTP\/1\.\d (\d+)/.exec(text)?.[1] ?? 0);
        if (status !== 101) {
          let msg = ''; try { msg = JSON.parse(rest.toString()).error; } catch { /* not JSON */ }
          return fail(`the sandbox refused the process (${status}): ${msg || 'unknown error'}`);
        }
        if (rest.length) sock.unshift(rest);
        resolve(/x-hefyn-exec-id: (\S+)/i.exec(text)?.[1] ?? '');
        setImmediate(() => sock.resume()); // paused until the caller has its listeners
      };
      sock.on('data', on);
      sock.once('error', (e) => fail(`the sandbox runner is unreachable (${e.message})`));
      sock.once('close', () => reject(new Error('the sandbox runner closed the connection')));
    });
    return {
      stream: sock,
      async resize(cols, rows) {
        const r = await (o.fetch ?? fetch)(`${base.origin}/sandboxes/${handle}/attach/${execId}/resize`, { method: 'POST', headers, body: JSON.stringify({ cols, rows }) });
        if (!r.ok) throw new Error(`resize failed (${r.status})`);
      },
    };
  };
}
