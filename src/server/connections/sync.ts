import { posix } from 'node:path';
import { db } from '../appdb.ts';
import { fsFor } from '../runner.ts';
import { StorageError, maxUploadBytes } from '../storage.ts';
import { LockedError } from '../vault.ts';
import { localPath, need, openAdapter, type ConnRow } from './store.ts';
import { ensureProviders } from './providers.ts';
import { msg, readAll, type Adapter } from './types.ts';

// The two-way sync of one connection between its remote folder and /files/<folder> (rules: docs/STORAGE.md "Connections").
// Both sides are listed completely, compared with what the last run saw (table connection_state) and the difference is applied. Nothing is ever lost on either side:
// a change beats a delete, and when both sides changed a file both versions are kept.
const MB = 1048576;
const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== '' && n > 0 && Number.isFinite(n) ? n : d; };
const limits = () => ({ entries: num(process.env.HEFYN_SYNC_MAX_ENTRIES, 10_000), depth: 20, bytes: num(process.env.HEFYN_SYNC_MAX_MB, 500) * MB });
const STALE_LOCK_MS = 15 * 60_000;

export type Mode = 'full' | 'pull' | 'push';
export interface Summary { mode: Mode; downloaded: number; uploaded: number; deletedLocal: number; deletedRemote: number; conflicts: number; skipped: number; bytes: number; capped: string[]; errors: string[]; ms: number }
interface Node { type: 'file' | 'dir'; size: number; mtime: string; etag?: string }
interface State { path: string; type: string; r_sig: string | null; r_size: number | null; l_mtime: string | null; l_size: number | null }

const legal = (n: string) => !!n && n !== '.' && n !== '..' && Buffer.byteLength(n) <= 255 && !/[\\\0-\x1f<>:"|?*]/.test(n) && !/[ .]$/.test(n); // names the other side may refuse are left alone
const sig = (n: Node) => n.etag ?? n.mtime;
const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
const under = (m: Map<string, Node>, dir: string) => { for (const k of m.keys()) if (k.startsWith(dir + '/')) return true; return false; };
class Stop extends Error {}

function lock(id: string): boolean {
  const now = Date.now();
  return db.prepare('UPDATE connections SET running_at = ? WHERE id = ? AND (running_at IS NULL OR running_at < ?)').run(new Date(now).toISOString(), id, new Date(now - STALE_LOCK_MS).toISOString()).changes === 1;
}

/** Runs one sync. Throws 409 when another run of the same connection is going (in this process or the other one). */
export async function syncConnection(userId: string, id: string, o: { mode?: Mode; deadlineMs?: number } = {}): Promise<Summary> {
  ensureProviders();
  const row = need(userId, id), mode = o.mode ?? 'full', started = Date.now();
  if (!lock(id)) throw new StorageError(409, 'a sync of this connection is already running');
  let adapter: Adapter | undefined;
  const sum: Summary = { mode, downloaded: 0, uploaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, skipped: 0, bytes: 0, capped: [], errors: [], ms: 0 };
  try {
    adapter = await openAdapter(row);
    await run(row, adapter, sum, mode, o.deadlineMs ? started + o.deadlineMs : undefined);
  } catch (e) {
    if (e instanceof Stop) sum.capped.push('time');
    else {
      sum.ms = Date.now() - started;
      db.prepare("UPDATE connections SET status = 'error', last_error = ?, last_summary = ?, running_at = NULL WHERE id = ?").run(msg(e), JSON.stringify(sum), id);
      throw e;
    }
  } finally { await adapter?.close?.().catch(() => {}); }
  sum.ms = Date.now() - started;
  const bad = sum.errors.length;
  db.prepare('UPDATE connections SET status = ?, last_error = ?, last_sync_at = ?, last_summary = ?, running_at = NULL WHERE id = ?')
    .run(bad ? 'error' : 'ok', bad ? `${bad} item${bad > 1 ? 's' : ''} failed: ${sum.errors[0]}` : null, new Date().toISOString(), JSON.stringify(sum), id);
  return sum;
}

async function run(row: ConnRow, adapter: Adapter, sum: Summary, mode: Mode, deadline: number | undefined) {
  const lim = limits(), fs = fsFor(row.user_id), base = localPath(row), maxFile = maxUploadBytes();
  const lp = (p: string) => (p ? `${base}/${p}` : base);
  const caps = await adapter.caps();
  const down = mode !== 'push', up = mode !== 'pull' && caps.write, full = mode === 'full' && caps.write;
  const check = () => { if (deadline && Date.now() > deadline) throw new Stop(); };

  async function scan(list: (dir: string) => Promise<{ name: string; type: string; size: number; mtime: string; etag?: string }[]>, side: string) {
    const out = new Map<string, Node>();
    const queue: [string, number][] = [['', 0]];
    while (queue.length) {
      check();
      const [dir, depth] = queue.shift()!;
      let entries;
      try { entries = await list(dir); } catch (e) { throw new StorageError(502, `${side} folder ${dir || '/'} could not be read, nothing was changed: ${msg(e)}`); }
      for (const e of entries) {
        if (e.type !== 'file' && e.type !== 'dir') { sum.skipped++; continue; } // symlinks are never followed
        if (!legal(e.name)) { sum.skipped++; continue; }
        const p = join(dir, e.name);
        if (out.size >= lim.entries) throw new StorageError(413, `more than ${lim.entries} files and folders on the ${side}; nothing was changed. Choose a smaller remote folder.`);
        out.set(p, { type: e.type, size: e.size, mtime: e.mtime, ...(e.etag ? { etag: e.etag } : {}) });
        if (e.type === 'dir') { if (depth + 1 >= lim.depth) { sum.capped.push(`depth ${lim.depth}`); out.delete(p); } else queue.push([p, depth + 1]); }
      }
    }
    return out;
  }
  await fs.mkdir(base, { recursive: true });
  const remote = await scan((d) => adapter.list(d), 'remote');
  const local = await scan((d) => fs.list(lp(d)), 'local');
  const state = new Map((db.prepare('SELECT path, type, r_sig, r_size, l_mtime, l_size FROM connection_state WHERE connection_id = ?').all(row.id) as unknown as State[]).map((s) => [s.path, s]));

  const save = (p: string, type: string, r?: Node, l?: Node) => void db.prepare('INSERT OR REPLACE INTO connection_state (connection_id, path, type, r_sig, r_size, l_mtime, l_size, synced_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(row.id, p, type, r ? sig(r) : null, r?.size ?? null, l?.mtime ?? null, l?.size ?? null, new Date().toISOString());
  const forget = (p: string) => void db.prepare('DELETE FROM connection_state WHERE connection_id = ? AND path = ?').run(row.id, p);
  const fresh = {
    remote: async (p: string) => (await adapter.list(posix.dirname(p) === '.' ? '' : posix.dirname(p))).find((e) => e.name === posix.basename(p)) as Node | undefined,
    local: async (p: string) => (await fs.list(lp(posix.dirname(p) === '.' ? '' : posix.dirname(p)))).find((e: any) => e.name === posix.basename(p)) as Node | undefined,
  };
  const record = async (p: string) => { const [r, l] = await Promise.all([fresh.remote(p), fresh.local(p)]); if (r) remote.set(p, r); if (l) local.set(p, l); save(p, 'file', r, l); };
  const fetchRemote = async (p: string) => { const b = await readAll(await adapter.read(p)); if (b.byteLength > maxFile) throw new StorageError(413, 'file is over the size limit'); return b; };
  const budget = (size: number) => { if (sum.bytes + size > lim.bytes) { if (!sum.capped.includes('bytes')) sum.capped.push('bytes'); return false; } sum.bytes += size; return true; };
  const changedR = (s: State | undefined, r: Node) => !s || s.r_sig !== sig(r) || s.r_size !== r.size;
  const changedL = (s: State | undefined, l: Node) => !s || s.l_mtime !== l.mtime || s.l_size !== l.size;
  const fail = (p: string, e: unknown) => {
    sum.errors.push(`${p}: ${msg(e)}`);
    if (/quota/i.test(msg(e))) { sum.errors.unshift('Your storage quota is full. Free up space in Files, then sync again.'); throw new Stop(); }
  };

  const toLocal = async (p: string, r: Node) => {
    if (!budget(r.size)) return;
    await fs.mkdir(lp(posix.dirname(p) === '.' ? '' : posix.dirname(p)), { recursive: true });
    await fs.writeFile(lp(p), await fetchRemote(p));
    await record(p); sum.downloaded++;
  };
  const toRemote = async (p: string, l: Node) => {
    if (!budget(l.size)) return;
    await adapter.write(p, await fs.readFileBuffer(lp(p)));
    await record(p); sum.uploaded++;
  };
  const conflictName = (p: string) => {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
    const dir = posix.dirname(p) === '.' ? '' : posix.dirname(p), name = posix.basename(p), dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let i = 0; ; i++) {
      const c = join(dir, `${stem} (conflict ${stamp}${i ? ` ${i + 1}` : ''})${ext}`);
      if (!remote.has(c) && !local.has(c)) return c;
    }
  };
  /** Both sides have the file and it differs from the last sync (or there was none): the remote version takes the name, the local version is kept next to it, on both sides. */
  const conflict = async (p: string, r: Node, l: Node) => {
    const mine = await fs.readFileBuffer(lp(p));
    if (r.size === l.size && Buffer.compare(Buffer.from(mine), Buffer.from(await fetchRemote(p))) === 0) { await record(p); return; } // the same content after all
    if (!budget(r.size + l.size)) return;
    const c = conflictName(p);
    await adapter.write(c, mine); // first the copy on the remote: from here the local version is safe on both sides
    await fs.rename(lp(p), lp(c));
    await fs.writeFile(lp(p), await fetchRemote(p));
    await record(p); await record(c); sum.conflicts++;
  };

  const paths = [...new Set([...remote.keys(), ...local.keys(), ...state.keys()])].sort();
  const blocked: string[] = [];
  const isBlocked = (p: string) => blocked.some((b) => p === b || p.startsWith(b + '/'));
  const dirDeletes: { p: string; side: 'local' | 'remote' }[] = [];

  // 1. folders, parents first
  for (const p of paths) {
    const r = remote.get(p), l = local.get(p), s = state.get(p);
    if (r?.type !== 'dir' && l?.type !== 'dir' && s?.type !== 'dir') continue;
    if (r && l && r.type !== l.type) { sum.errors.push(`${p}: a file on one side and a folder on the other; skipped`); blocked.push(p); continue; }
    try {
      check();
      if (r && l) save(p, 'dir', r, l);
      else if (r?.type === 'dir') {
        if (s) { if (full) dirDeletes.push({ p, side: 'remote' }); } // deleted here
        else if (down) { await fs.mkdir(lp(p), { recursive: true }); const nl = await fresh.local(p); if (nl) local.set(p, nl); save(p, 'dir', r, nl); }
      } else if (l?.type === 'dir') {
        if (s) { if (down) dirDeletes.push({ p, side: 'local' }); } // deleted there
        else if (up) { await adapter.mkdir(p); const nr = await fresh.remote(p); if (nr) remote.set(p, nr); save(p, 'dir', nr, l); }
      } else if (s?.type === 'dir') forget(p);
    } catch (e) { if (e instanceof Stop) throw e; fail(p, e); }
  }

  // 2. files
  for (const p of paths) {
    const r = remote.get(p), l = local.get(p), s = state.get(p);
    if (r?.type === 'dir' || l?.type === 'dir' || (!r && !l && s?.type === 'dir') || isBlocked(p)) continue; // folders: step 1
    try {
      check();
      if ((r?.size ?? 0) > maxFile || (l?.size ?? 0) > maxFile) { sum.skipped++; sum.errors.push(`${p}: over the size limit of ${maxFile / MB} MB; skipped`); continue; }
      if (r && l) {
        const cr = changedR(s, r), cl = changedL(s, l);
        if (!cr && !cl) continue;
        if (cr && cl) { if (full) await conflict(p, r, l); }
        else if (cr) { if (down) await toLocal(p, r); }
        else if (up) await toRemote(p, l);
      } else if (r) {
        if (!s || changedR(s, r)) { if (down) await toLocal(p, r); } // new, or deleted here but changed there: restore
        else if (full) { await adapter.delete(p); remote.delete(p); forget(p); sum.deletedRemote++; } // deleted here, untouched there
      } else if (l) {
        if (!s || changedL(s, l)) { if (up) await toRemote(p, l); }
        else if (down) { await fs.rm(lp(p), { force: true }); local.delete(p); forget(p); sum.deletedLocal++; } // deleted there, untouched here
      } else if (s) forget(p);
    } catch (e) { if (e instanceof Stop) throw e; fail(p, e); }
  }

  // 3. folders deleted on one side go on the other only when nothing is left in them (a restored file keeps its folder), deepest first
  for (const { p, side } of dirDeletes.sort((a, b) => b.p.localeCompare(a.p))) {
    try {
      // a fresh listing too: names this sync skips (illegal on the other side) must not go with the folder
      if (side === 'remote' && !under(remote, p) && remote.has(p) && !(await adapter.list(p)).length) { await adapter.delete(p); remote.delete(p); forget(p); sum.deletedRemote++; }
      else if (side === 'local' && !under(local, p) && local.has(p) && !(await fs.list(lp(p))).length) { await fs.rm(lp(p), { recursive: true, force: true }); local.delete(p); forget(p); sum.deletedLocal++; }
    } catch (e) { sum.errors.push(`${p}: ${msg(e)}`); }
  }
}

// ---- triggers ----
const rowsOf = (userId: string) => db.prepare('SELECT * FROM connections WHERE user_id = ?').all(userId) as unknown as ConnRow[];
const recent = (r: ConnRow, ms: number) => !!r.last_sync_at && Date.now() - Date.parse(r.last_sync_at) < ms;

/** Before an agent session starts: a bounded pull of the user's connections, so the agent sees current files. Never throws; continues after `ms` even if the pull is still going. */
export async function pullBeforeSession(userId: string, ms = 10_000): Promise<void> {
  try {
    ensureProviders();
    const due = rowsOf(userId).filter((r) => !recent(r, 20_000));
    if (!due.length) return;
    let t: ReturnType<typeof setTimeout>;
    await Promise.race([Promise.allSettled(due.map((r) => syncConnection(userId, r.id, { mode: 'pull', deadlineMs: ms }))), new Promise((ok) => { t = setTimeout(ok, ms); })]).finally(() => clearTimeout(t));
  } catch { /* the session starts regardless */ }
}

/** After an agent turn: push local changes, fire and forget. */
export function pushAfterTurn(userId: string): void {
  try {
    ensureProviders();
    for (const r of rowsOf(userId)) void syncConnection(userId, r.id, { mode: 'push' }).catch((e) => { if (!(e instanceof LockedError) && (e as { status?: number }).status !== 409) console.error(`[hefyn] connection ${r.id} push:`, msg(e)); });
  } catch { /* nothing to push */ }
}

/** Users the web process saw lately (the connections API touches this). */
const seen = new Map<string, number>();
export const touch = (userId: string) => void seen.set(userId, Date.now());

/** The background job: every connection of a user who was active in the last hour and has not synced for 4 minutes. */
export async function syncDue(): Promise<number> {
  ensureProviders();
  const hour = Date.now() - 3_600_000, since = new Date(hour).toISOString();
  const active = (u: string) => (seen.get(u) ?? 0) > hour || !!db.prepare('SELECT 1 FROM conversations WHERE user_id = ? AND updated_at > ? LIMIT 1').get(u, since);
  let n = 0;
  for (const r of db.prepare('SELECT * FROM connections').all() as unknown as ConnRow[]) {
    if (recent(r, 4 * 60_000) || !active(r.user_id)) continue;
    try { await syncConnection(r.user_id, r.id); n++; } catch (e) { if (!(e instanceof LockedError) && (e as { status?: number }).status !== 409) console.error(`[hefyn] connection ${r.id} sync:`, msg(e)); }
  }
  return n;
}
