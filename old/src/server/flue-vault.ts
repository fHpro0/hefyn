import { sqlite } from '@flue/runtime/node';
import { parseSessionStorageKey } from '@flue/runtime/adapter';
import { createCipheriv, createHmac, hkdfSync } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { MiddlewareHandler } from 'hono';
import { db as appDb } from './appdb.ts';
import { LockedError, isSealed, markStrictTeam, markStrictUser, open, openForUser, rememberUserKey, seal, setTeamKey, userKey } from './vault.ts';

// Per-user encryption of flue.db (docs/ENCRYPTION.md). Flue's sqlite() adapter writes user content to a handful of columns; this
// module seals exactly those at the SQL boundary and opens them on the way back, so Flue's own stores (and their fencing and
// idempotency checks, which read record contents) run unchanged on plaintext. Store-level wrapping was rejected: the stores
// inspect records and payloads, so they must see plaintext. Done by patching DatabaseSync.prototype.prepare for flue.db only.
//
// Sealed (AAD in brackets):
//   flue_agent_submissions.payload [flue:sub:<id>:payload], .settlement_record [flue:sub:<id>:settlement, deterministic, see below],
//     .error [flue:suberr:<joined_into ?? id>] (Flue never compares or filters on it in SQL; a joined row is settled in bulk with its host's id)
//   flue_submission_chunks.data [flue:subchunk:<id>:<item>:<i>]
//   flue_conversation_stream_batches.data [flue:batch:<path>:<seq>], ..._batch_chunks.data [flue:bchunk:<path>:<seq>:<i>]
//   flue_conversation_fold_checkpoints.data [flue:fold:<path>:<head_offset>:<incarnation>], ..._checkpoint_chunks.data [flue:foldchunk:<path>:<i>]
//   flue_attachment_chunks.bytes [flue:att:<path>:<attachment>:<i>]
// In clear on purpose (Flue reads and queries them; none is message content): ids, session keys, paths, seq/offsets, producer
// fields, kind, status, timestamps, attempt counters, stream identity_json (agent name + conversation id), attachment mime type,
// size and SHA-256 digest (the digest lets someone who already has a file confirm it was attached). Every sensitive row maps to a user via its path / session key (u_<userId>_<ulid>); a
// sealed value with no derivable user throws. There are no user-less Flue records: Hefyn only serves u_ conversations.
// SCHEMA lists every column of flue.db as sealed or clear; vaultedSqlite().migrate() refuses to start on anything unlisted.

export const AGENT_KEY_TTL_MS = 30 * 60 * 1000;
export const LOCKED_MESSAGE = 'Your data is locked. Sign in again to continue.';

// u_<userId>_<ulid>, as in usage.ts (anchored: a model-chosen session name can not smuggle in another user).
const CONVERSATION = /^u_([A-Za-z0-9-]+)_[0-9A-Za-z]+$/;
/** The user owning a Flue stream path (`agents/<agent>/<id>`), session key, or bare conversation id. */
export function userOfFlueKey(k: unknown): string | undefined {
  if (typeof k !== 'string') return;
  const session = parseSessionStorageKey(k);
  if (session) return CONVERSATION.exec(session.instanceId)?.[1];
  const parts = k.split('/');
  return CONVERSATION.exec(parts[0] === 'agents' && parts.length === 3 ? parts[2]! : k)?.[1];
}

const needKey = (userId: string) => {
  const k = userKey(userId);
  if (!k) throw new LockedError('user', userId);
  rememberUserKey(userId, k, AGENT_KEY_TTL_MS); // an active run keeps its key alive
  return k;
};
const must = (userId: string | undefined, what: string) => { if (!userId) throw new Error(`flue-vault: no user for ${what}`); return userId; };

/** Same plaintext + AAD gives the same ciphertext: Flue compares settlement records inside SQL (`settlement_record = ?`). */
function sealDeterministic(key: Buffer, plain: string, aad: string): string {
  const iv = createHmac('sha256', Buffer.from(hkdfSync('sha256', key, '', 'hefyn flue settlement iv', 32))).update(`flue-det\0${aad}\0`).update(plain).digest().subarray(0, 12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'hx1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

const SEALED_BYTES = Buffer.from('hx1:');
const isSealedBytes = (b: unknown): b is Uint8Array => b instanceof Uint8Array && Buffer.from(b.buffer, b.byteOffset, Math.min(4, b.byteLength)).equals(SEALED_BYTES);
const lockedMessage = (e: unknown) => { if (e instanceof LockedError) e.message = LOCKED_MESSAGE; return e; };

// The table a statement writes or reads: the first FROM / INTO / UPDATE target.
const tableOf = (q: string) => /\b(?:FROM|INTO|UPDATE)\s+(flue_\w+)/i.exec(q)?.[1];
// Every table and column Flue 2.3 creates in flue.db: true = sealed here, false = clear on purpose (see header).
const SCHEMA: Record<string, Record<string, boolean>> = {
  flue_meta: { key: false, value: false },
  flue_agent_submissions: { sequence: false, submission_id: false, session_key: false, kind: false, payload: true, status: false, accepted_at: false, canonical_ready_at: false,
    attempt_id: false, input_applied_at: false, abort_requested_at: false, started_at: false, joined_into: false, settled_at: false, error: true, attempt_count: false,
    max_attempts: false, timeout_at: false, owner_id: false, lease_expires_at: false, settlement_record_id: false, settlement_record: true },
  flue_submission_chunks: { submission_id: false, item_id: false, chunk_index: false, chunk_count: false, data: true },
  flue_conversation_streams: { path: false, identity_json: false, next_offset: false, producer_id: false, producer_epoch: false, next_producer_sequence: false, incarnation: false },
  flue_conversation_stream_batches: { path: false, seq: false, producer_id: false, producer_epoch: false, producer_sequence: false, data: true, submission_id: false, attempt_id: false },
  flue_conversation_stream_batch_chunks: { path: false, seq: false, chunk_index: false, chunk_count: false, data: true },
  flue_conversation_fold_checkpoints: { path: false, head_offset: false, incarnation: false, format_version: false, data: true, chunk_count: false },
  flue_conversation_fold_checkpoint_chunks: { path: false, chunk_index: false, data: true },
  flue_attachments: { stream_path: false, attachment_id: false, mime_type: false, byte_size: false, digest: false, conversation_id: false, chunk_count: false, created_at: false },
  flue_attachment_chunks: { stream_path: false, attachment_id: false, chunk_index: false, bytes: true },
};
const SENSITIVE = new Set(Object.entries(SCHEMA).filter(([, c]) => Object.values(c).some(Boolean)).map(([t]) => t));

/** Throws when flue.db has a table or column that SCHEMA does not classify (a Flue upgrade that stores something new). */
export function checkFlueSchema(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all() as { name: string }[]).map((t) => t.name);
    for (const t of tables) {
      const known = SCHEMA[t];
      for (const c of known ? (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((x) => x.name) : [undefined]) {
        if (!known || !(c! in known)) throw new Error(`Flue schema changed: ${known ? `${t}.${c}` : t} is not classified; refusing to start so it is not stored in plain text`);
      }
    }
  } finally { db.close(); }
}

const rawSession = (db: DatabaseSync, submissionId: unknown) =>
  ((origPrepare as any).call(db, 'SELECT session_key FROM flue_agent_submissions WHERE submission_id = ?') as any).get(submissionId)?.session_key as string | undefined;

// Index of the binding that the first `?` after a regex match belongs to (-1: no match).
const at = (q: string, re: RegExp) => { const m = re.exec(q); return m ? q.slice(0, m.index).split('?').length - 1 : -1; };
const rawStmt = (db: DatabaseSync, q: string) => (origPrepare as any).call(db, q) as import('node:sqlite').StatementSync;

/** Seal the content bindings of a write. Returns new bindings. */
function sealBindings(db: DatabaseSync, q: string, b: any[]): any[] {
  const t = tableOf(q);
  if (!t || !SENSITIVE.has(t)) return b;
  const out = [...b];
  const put = (i: number, userId: string | undefined, aad: string, det = false) => {
    const v = out[i];
    if (typeof v !== 'string' && !(v instanceof Uint8Array)) return; // e.g. a NULL checkpoint data column
    try {
      const k = needKey(must(userId, aad));
      const sealed = det ? sealDeterministic(k, v as string, aad) : seal(k, typeof v === 'string' ? v : Buffer.from(v), aad);
      out[i] = typeof v === 'string' ? sealed : Buffer.from(sealed); // blobs hold the sealed text
    } catch (e) { throw lockedMessage(e); }
  };
  const insert = /^\s*INSERT/i.test(q);
  if (t === 'flue_agent_submissions') {
    if (insert) put(3, userOfFlueKey(b[1]), `flue:sub:${b[0]}:payload`);
    else if (/SET status = 'terminalizing'/.test(q)) put(1, userOfFlueKey(rawSession(db, b[4])), `flue:sub:${b[4]}:settlement`, true);
    else if (/settlement_record = \?/.test(q)) put(3, userOfFlueKey(rawSession(db, b[0])), `flue:sub:${b[0]}:settlement`, true);
    else if (at(q, /\berror = \?/) >= 0) {
      const j = at(q, /joined_into = \?/), i = at(q, /\bsubmission_id = \?/), n = at(q, /\bsequence = \?/);
      const sid = j >= 0 ? b[j] : i >= 0 ? b[i] : (rawStmt(db, 'SELECT submission_id AS s FROM flue_agent_submissions WHERE sequence = ?').get(b[n]) as any)?.s;
      put(at(q, /\berror = \?/), userOfFlueKey(rawSession(db, sid)), `flue:suberr:${sid}`);
    }
  } else if (!insert) return b;
  else if (t === 'flue_submission_chunks') put(4, userOfFlueKey(rawSession(db, b[0])), `flue:subchunk:${b[0]}:${b[1]}:${b[2]}`);
  else if (t === 'flue_conversation_stream_batches') put(5, userOfFlueKey(b[0]), `flue:batch:${b[0]}:${b[1]}`);
  else if (t === 'flue_conversation_stream_batch_chunks') put(4, userOfFlueKey(b[0]), `flue:bchunk:${b[0]}:${b[1]}:${b[2]}`);
  else if (t === 'flue_conversation_fold_checkpoints') put(4, userOfFlueKey(b[0]), `flue:fold:${b[0]}:${b[1]}:${b[2]}`);
  else if (t === 'flue_conversation_fold_checkpoint_chunks') put(2, userOfFlueKey(b[0]), `flue:foldchunk:${b[0]}:${b[1]}`);
  else if (t === 'flue_attachment_chunks') put(3, userOfFlueKey(b[0]), `flue:att:${b[0]}:${b[1]}:${b[2]}`);
  return out;
}

/** Open the content columns of result rows (legacy plaintext passes through). Rows of locked users in list queries are dropped. */
function openRows(db: DatabaseSync, q: string, b: any[], rows: any[]): any[] {
  const t = tableOf(q);
  if (!t || !SENSITIVE.has(t)) return rows;
  // Lists over all users (coordinator, recovery): a locked user's submissions are skipped and stay pending. Point reads throw.
  const list = t === 'flue_agent_submissions' && !/submission_id = \?/.test(q);
  const out: any[] = [];
  for (const row of rows) {
    try { out.push(openRow(db, t, b, row)); } catch (e) {
      if (list) { // one bad row (locked owner, corrupt, downgraded) must not stall everyone's lists
        if (!(e instanceof LockedError)) console.error(`[hefyn] flue.db: skipping unreadable ${t} row (${row.submission_id ?? row.path ?? '?'}): ${(e as Error).name}: ${(e as Error).message}`);
        continue;
      }
      throw lockedMessage(e);
    }
  }
  return out;
}

function openRow(db: DatabaseSync, t: string, b: any[], row: any): any {
  // Opens row[name] in place of a copy; plaintext (legacy) values pass through, sealed ones need the owner's key.
  const col = (r: any, name: string, aad: string, userOf: () => string | undefined) => {
    const v = r[name];
    if (!(typeof v === 'string' ? isSealed(v) : isSealedBytes(v))) {
      // Legacy plaintext: fine until the owner is marked strict (migrated), then it can only be a downgrade (DowngradeError).
      const u = v === null || v === undefined ? undefined : userOf();
      if (u) openForUser(u, typeof v === 'string' ? v : '', aad);
      return r;
    }
    const k = needKey(must(userOf(), aad));
    const plain = open(k, typeof v === 'string' ? v : Buffer.from(v).toString(), aad);
    return { ...r, [name]: typeof v === 'string' ? plain.toString('utf8') : plain };
  };
  switch (t) {
    case 'flue_agent_submissions': {
      const sid = row.submission_id ?? b[0];
      const user = () => userOfFlueKey(row.session_key ?? rawSession(db, sid));
      const r = col(col(row, 'payload', `flue:sub:${sid}:payload`, user), 'settlement_record', `flue:sub:${sid}:settlement`, user);
      return col(r, 'error', `flue:suberr:${row.joined_into ?? sid}`, user);
    }
    case 'flue_submission_chunks': return col(row, 'data', `flue:subchunk:${b[0]}:${row.item_id}:${row.chunk_index}`, () => userOfFlueKey(rawSession(db, b[0])));
    case 'flue_conversation_stream_batches': return col(row, 'data', `flue:batch:${b[0]}:${row.seq}`, () => userOfFlueKey(b[0]));
    case 'flue_conversation_stream_batch_chunks': return col(row, 'data', `flue:bchunk:${b[0]}:${b[1]}:${row.chunk_index}`, () => userOfFlueKey(b[0]));
    case 'flue_conversation_fold_checkpoints': return col(row, 'data', `flue:fold:${b[0]}:${row.head_offset}:${row.incarnation}`, () => userOfFlueKey(b[0]));
    case 'flue_conversation_fold_checkpoint_chunks': return col(row, 'data', `flue:foldchunk:${b[0]}:${row.chunk_index}`, () => userOfFlueKey(b[0]));
    default: return col(row, 'bytes', `flue:att:${b[0]}:${b[1]}:${row.chunk_index}`, () => userOfFlueKey(b[0]));
  }
}

function wrapStatement(db: DatabaseSync, stmt: any, q: string) {
  return new Proxy(stmt, {
    get(t, p) {
      if (p === 'iterate') throw new Error('flue-vault: iterate() is not supported on sealed tables');
      if (p === 'run') return (...b: any[]) => t.run(...sealBindings(db, q, b));
      if (p === 'all') return (...b: any[]) => openRows(db, q, b, t.all(...sealBindings(db, q, b)));
      if (p === 'get') return (...b: any[]) => openRows(db, q, b, [t.get(...sealBindings(db, q, b))].filter(Boolean))[0];
      const v = t[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

// The patch lives on globalThis: a dev hot reload (Vite SSR) re-evaluates this module, and a second patch on top of the first
// would capture the patched prepare as "original" and seal every value twice (the reader then hands the inner ciphertext to Flue).
// The installed prototype function stays the single one and only calls `G.handle`; every evaluation replaces `handle` with the new
// module's whole decision (tableOf, SENSITIVE, wrapStatement, key store), so a reload that adds a sealed table applies at once.
const G = ((globalThis as any)[Symbol.for('hefyn.flue-vault')] ??= {
  origPrepare: DatabaseSync.prototype.prepare, guarded: new Set<string>(), seen: new WeakMap<object, { mine: boolean; n: number }>(), handle: undefined as any, patched: false,
}) as { origPrepare: DatabaseSync['prepare']; guarded: Set<string>; seen: WeakMap<object, { mine: boolean; n: number }>; handle: (db: DatabaseSync, stmt: any, q: string) => any; patched: boolean };
const origPrepare = G.origPrepare;
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } }; // location() reports the resolved path
G.handle = (db, stmt, q) => {
  let c = G.seen.get(db);
  if (!c || c.n !== G.guarded.size) { // re-decide when a path was guarded after this connection was classified
    const was = c?.mine;
    G.seen.set(db, c = { mine: [...G.guarded].some((g) => real(g) === real(db.location() ?? '')), n: G.guarded.size });
    if (c.mine && !was) (origPrepare as any).call(db, 'PRAGMA busy_timeout = 5000').run(); // writers wait for each other (web migration, purge) instead of SQLITE_BUSY
  }
  const t = tableOf(q);
  return c.mine && t && SENSITIVE.has(t) ? wrapStatement(db, stmt, q) : stmt;
};
function guard(path: string) {
  G.guarded.add(path);
  if (G.patched) return;
  G.patched = true;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, q: string, ...rest: any[]) {
    return G.handle(this, (origPrepare as any).call(this, q, ...rest), q);
  } as typeof origPrepare;
}

/** Drop-in for `sqlite(path)` in src/db.ts: Flue's adapter, with user content sealed per user on its way to flue.db. */
export function vaultedSqlite(path: string) {
  guard(path);
  const base = sqlite(path);
  // After Flue's own migrations: refuse to run on a schema this module has not classified.
  return { ...base, async migrate() { await base.migrate?.(); checkFlueSchema(path); } };
}

const defaultPath = () => `${process.env.HEFYN_DATA_DIR ?? './data'}/flue.db`;

/**
 * Re-seals the user's legacy plaintext rows (payload, settlement, error, every data/bytes column) under their key.
 * Idempotent (sealed values are skipped); throws LockedError without the key. Works from the web process. Returns the values sealed.
 * Cheap on a migrated user: a read-only pass selects only that user's rows whose value is not `hx1:`; the write lock
 * (BEGIN IMMEDIATE) is taken only when something needs sealing, and the work list is rebuilt under it.
 */
export function migrateUserFlueData(userId: string, path = defaultPath()): number {
  needKey(userId);
  const db = new DatabaseSync(path);
  const esc = userId.replace(/[\\%_]/g, '\\$&');
  const sessionLike = `%"u\\_${esc}\\_%`, pathLike = `agents/%/u\\_${esc}\\_%`;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const has = (t: string) => !!rawStmt(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const legacy = (col: string) => `${col} IS NOT NULL AND CAST(substr(${col}, 1, 4) AS TEXT) <> 'hx1:'`;
    const sel = (t: string, col: string, where: string, ...args: string[]) => (has(t) ? rawStmt(db, `SELECT * FROM ${t} WHERE ${where} AND ${legacy(col)}`).all(...args) : []) as any[];
    type Job = { t: string; col: string; keys: string[]; r: any; q: string; b: any[]; i: number };
    const jobs = (): Job[] => {
      const out: Job[] = [];
      const add = (t: string, col: string, keys: string[], r: any, q: string, b: any[], i: number) => out.push({ t, col, keys, r, q, b, i });
      if (has('flue_agent_submissions')) {
        const mine = (rawStmt(db, 'SELECT submission_id FROM flue_agent_submissions WHERE session_key LIKE ? ESCAPE \'\\\'').all(sessionLike) as any[]).map((x) => x.submission_id);
        for (const id of mine) {
          const r = rawStmt(db, 'SELECT * FROM flue_agent_submissions WHERE submission_id = ?').get(id) as any;
          if (userOfFlueKey(r.session_key) !== userId) continue;
          const k = ['submission_id'], S = 'flue_agent_submissions';
          if (!isSealed(r.payload)) add(S, 'payload', k, r, 'INSERT INTO flue_agent_submissions', [r.submission_id, r.session_key, r.kind, r.payload], 3);
          if (r.settlement_record != null && !isSealed(r.settlement_record)) add(S, 'settlement_record', k, r, "UPDATE flue_agent_submissions SET status = 'terminalizing'", [null, r.settlement_record, null, null, r.submission_id], 1);
          if (r.error != null && !isSealed(r.error)) add(S, 'error', k, r, `UPDATE flue_agent_submissions SET error = ? WHERE ${r.joined_into ? 'joined_into' : 'submission_id'} = ?`, [r.error, r.joined_into ?? r.submission_id], 0);
          for (const c of sel('flue_submission_chunks', 'data', 'submission_id = ?', id)) add('flue_submission_chunks', 'data', ['submission_id', 'item_id', 'chunk_index'], c, 'INSERT INTO flue_submission_chunks', [c.submission_id, c.item_id, c.chunk_index, c.chunk_count, c.data], 4);
        }
      }
      const P = "path LIKE ? ESCAPE '\\'";
      for (const r of sel('flue_conversation_stream_batches', 'data', P, pathLike).filter((x) => userOfFlueKey(x.path) === userId)) add('flue_conversation_stream_batches', 'data', ['path', 'seq'], r, 'INSERT INTO flue_conversation_stream_batches', [r.path, r.seq, null, null, null, r.data], 5);
      for (const r of sel('flue_conversation_stream_batch_chunks', 'data', P, pathLike).filter((x) => userOfFlueKey(x.path) === userId)) add('flue_conversation_stream_batch_chunks', 'data', ['path', 'seq', 'chunk_index'], r, 'INSERT INTO flue_conversation_stream_batch_chunks', [r.path, r.seq, r.chunk_index, r.chunk_count, r.data], 4);
      for (const r of sel('flue_conversation_fold_checkpoints', 'data', P, pathLike).filter((x) => userOfFlueKey(x.path) === userId)) add('flue_conversation_fold_checkpoints', 'data', ['path'], r, 'INSERT INTO flue_conversation_fold_checkpoints', [r.path, r.head_offset, r.incarnation, null, r.data], 4);
      for (const r of sel('flue_conversation_fold_checkpoint_chunks', 'data', P, pathLike).filter((x) => userOfFlueKey(x.path) === userId)) add('flue_conversation_fold_checkpoint_chunks', 'data', ['path', 'chunk_index'], r, 'INSERT INTO flue_conversation_fold_checkpoint_chunks', [r.path, r.chunk_index, r.data], 2);
      for (const r of sel('flue_attachment_chunks', 'bytes', "stream_path LIKE ? ESCAPE '\\'", pathLike).filter((x) => userOfFlueKey(x.stream_path) === userId)) add('flue_attachment_chunks', 'bytes', ['stream_path', 'attachment_id', 'chunk_index'], r, 'INSERT INTO flue_attachment_chunks', [r.stream_path, r.attachment_id, r.chunk_index, r.bytes], 3);
      return out;
    };
    if (!jobs().length) return 0; // nothing legacy: no write lock taken
    rawStmt(db, 'BEGIN IMMEDIATE').run();
    try {
      const todo = jobs();
      for (const j of todo) // the same binding rules as a live write: q/b/i mimic the statement Flue would have issued
        rawStmt(db, `UPDATE ${j.t} SET ${j.col} = ? WHERE ${j.keys.map((k) => `${k} = ?`).join(' AND ')}`).run(sealBindings(db, j.q, j.b)[j.i], ...j.keys.map((k) => j.r[k]));
      rawStmt(db, 'COMMIT').run();
      return todo.length;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  } finally { db.close(); }
}

/**
 * Repair for rows sealed twice or more (a pre-fix dev hot reload stacked patches): opens the outer layer, with the row's own AAD, and
 * writes the inner ciphertext back, but only after the inner value verifiably opens with the same key + AAD (so a plaintext that merely
 * starts with `hx1:` is left alone: `skipped`). A row that does not open at all is `failed`; neither stops the others. Needs the owner's
 * key. Run it with the agent stopped, on a backup: stop agent, back up flue.db(+wal/shm), run per user, start agent.
 */
export function repairDoubleSealedFlueData(userId: string, path = defaultPath()): { repaired: number; skipped: number; failed: number } {
  needKey(userId);
  const db = new DatabaseSync(path);
  const esc = userId.replace(/[\\%_]/g, '\\$&');
  const sessionLike = `%"u\\_${esc}\\_%`, pathLike = `agents/%/u\\_${esc}\\_%`;
  const mySubs = "submission_id IN (SELECT submission_id FROM flue_agent_submissions WHERE session_key LIKE ? ESCAPE '\\')";
  const P = "path LIKE ? ESCAPE '\\'", S = "session_key LIKE ? ESCAPE '\\'";
  // table, column, primary key, openRow bindings, owner filter (one LIKE parameter), owner of a row
  const specs: [string, string, string[], (r: any) => any[], string, string, (r: any) => string | undefined][] = [
    ['flue_agent_submissions', 'payload', ['submission_id'], () => [], S, sessionLike, (r) => userOfFlueKey(r.session_key)],
    ['flue_agent_submissions', 'settlement_record', ['submission_id'], () => [], S, sessionLike, (r) => userOfFlueKey(r.session_key)],
    ['flue_agent_submissions', 'error', ['submission_id'], () => [], S, sessionLike, (r) => userOfFlueKey(r.session_key)],
    ['flue_submission_chunks', 'data', ['submission_id', 'item_id', 'chunk_index'], (r) => [r.submission_id], mySubs, sessionLike, (r) => userOfFlueKey(rawSession(db, r.submission_id))],
    ['flue_conversation_stream_batches', 'data', ['path', 'seq'], (r) => [r.path], P, pathLike, (r) => userOfFlueKey(r.path)],
    ['flue_conversation_stream_batch_chunks', 'data', ['path', 'seq', 'chunk_index'], (r) => [r.path, r.seq], P, pathLike, (r) => userOfFlueKey(r.path)],
    ['flue_conversation_fold_checkpoints', 'data', ['path'], (r) => [r.path], P, pathLike, (r) => userOfFlueKey(r.path)],
    ['flue_conversation_fold_checkpoint_chunks', 'data', ['path', 'chunk_index'], (r) => [r.path], P, pathLike, (r) => userOfFlueKey(r.path)],
    ['flue_attachment_chunks', 'bytes', ['stream_path', 'attachment_id', 'chunk_index'], (r) => [r.stream_path, r.attachment_id], "stream_path LIKE ? ESCAPE '\\'", pathLike, (r) => userOfFlueKey(r.stream_path)],
  ];
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const has = (t: string) => !!rawStmt(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    db.exec('BEGIN IMMEDIATE');
    let repaired = 0, skipped = 0, failed = 0, pass: number;
    const done = new Set<string>(); // rows that were skipped or failed are not retried in the next pass
    const sealedLike = (v: unknown) => (typeof v === 'string' ? isSealed(v) : isSealedBytes(v));
    do { // a row can be stacked more than twice (one layer per reload): peel one layer per pass until a single one is left
      pass = 0;
      for (const [t, col, keys, bOf, where, like, ownerOf] of specs) {
        if (!has(t)) continue;
        for (const row of rawStmt(db, `SELECT * FROM ${t} WHERE ${where} AND ${col} IS NOT NULL AND CAST(substr(${col}, 1, 4) AS TEXT) = 'hx1:'`).all(like) as any[]) {
          if (ownerOf(row) !== userId) continue;
          const id = `${t}.${col}:${keys.map((k) => row[k]).join('\0')}`;
          if (done.has(id)) continue;
          // Only this column, the others of a submission row nulled: one unreadable sibling must not block it. Same AAD rules as a live read.
          const only = (v: unknown) => ({ ...row, payload: null, settlement_record: null, error: null, [col]: v });
          let once: unknown;
          try {
            once = openRow(db, t, bOf(row), only(row[col]))[col];
            if (!sealedLike(once)) continue; // single layer: nothing to peel
          } catch (e) {
            failed++; done.add(id);
            console.error(`[hefyn] flue.db repair: unreadable ${t}.${col} row: ${(e as Error).name}`);
            continue;
          }
          try { openRow(db, t, bOf(row), only(once)); } catch { // the plaintext just started with "hx1:": not a second layer
            skipped++; done.add(id);
            console.error(`[hefyn] flue.db repair: ${t}.${col} row looks sealed twice but the inner value does not open; left as it is`);
            continue;
          }
          rawStmt(db, `UPDATE ${t} SET ${col} = ? WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}`).run(once as any, ...keys.map((k) => row[k]));
          pass++;
        }
      }
      repaired += pass;
    } while (pass);
    db.exec('COMMIT');
    return { repaired, skipped, failed };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally { db.close(); }
}

/** "Start fresh": removes every Flue row (submissions, streams, checkpoints, attachments) of the user's conversations. */
export function purgeUserFlueData(userId: string, path = `${process.env.HEFYN_DATA_DIR ?? './data'}/flue.db`, only?: Set<string>) {
  // `only`: just these conversation ids (delete one chat); else every conversation of the user.
  const mine = (k: string) => userOfFlueKey(k) === userId && (!only || only.has(parseSessionStorageKey(k)?.instanceId ?? (k.startsWith('agents/') ? k.split('/')[2]! : k)));
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const del = (t: string, col: string, ids: string[]) => { if (has(t)) for (const id of ids) db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(id); };
    const ids = (t: string, col: string) => has(t) ? (db.prepare(`SELECT ${col} AS k FROM ${t}`).all() as { k: string }[]).map((r) => r.k) : [];
    db.exec('BEGIN');
    const subs = has('flue_agent_submissions')
      ? (db.prepare('SELECT submission_id, session_key FROM flue_agent_submissions').all() as any[]).filter((r) => mine(r.session_key)).map((r) => r.submission_id) : [];
    const paths = [...new Set(ids('flue_conversation_streams', 'path'))].filter(mine);
    const attPaths = [...new Set(ids('flue_attachments', 'stream_path'))].filter(mine);
    del('flue_submission_chunks', 'submission_id', subs);
    del('flue_agent_submissions', 'submission_id', subs);
    for (const t of ['flue_conversation_stream_batch_chunks', 'flue_conversation_stream_batches', 'flue_conversation_fold_checkpoint_chunks', 'flue_conversation_fold_checkpoints', 'flue_conversation_streams']) del(t, 'path', paths);
    del('flue_attachment_chunks', 'stream_path', attPaths);
    del('flue_attachments', 'stream_path', attPaths);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally { db.close(); }
}

// Agent side of the key transport: the web service sends the caller's keys with each /agents/* request (x-hefyn-user-key, optional
// x-hefyn-team-key, base64). They are kept in memory (sliding TTL) and removed from the request before Flue sees it. Never logged.
const decodeKey = (v: string | undefined) => { const k = v ? Buffer.from(v, 'base64') : undefined; return k?.length === 32 ? k : undefined; };
// The persisted "migrated" flags (user_keys.strict, instance_settings team_strict) make unsealed values an error instead of legacy data.
function markStrictFromAppDb(userId?: string) {
  try {
    if (userId) { if ((appDb.prepare('SELECT strict FROM user_keys WHERE user_id = ?').get(userId) as any)?.strict) markStrictUser(userId); }
    else if (['1', 'true'].includes(String((appDb.prepare("SELECT value FROM instance_settings WHERE key = 'team_strict'").get() as any)?.value))) markStrictTeam();
  } catch { /* column not there yet (older app.db): not strict */ }
}
export const acceptKeys: MiddlewareHandler = async (c, next) => {
  const userId = userOfFlueKey(new URL(c.req.url).pathname.split('/')[3]);
  const user = decodeKey(c.req.header('x-hefyn-user-key')), team = decodeKey(c.req.header('x-hefyn-team-key'));
  if (userId && user) { rememberUserKey(userId, user, AGENT_KEY_TTL_MS); markStrictFromAppDb(userId); }
  if (team) { setTeamKey(team); markStrictFromAppDb(); }
  const headers = new Headers(c.req.raw.headers);
  headers.delete('x-hefyn-user-key');
  headers.delete('x-hefyn-team-key');
  c.req.raw = new Request(c.req.raw, { headers });
  await next();
};
