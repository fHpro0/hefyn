import { randomUUID } from 'node:crypto';
import { db } from '../appdb.ts';
import { fsFor } from '../runner.ts';
import { StorageError } from '../storage.ts';
import { openForUser, sealForUser } from '../vault.ts';
import { msg, providerRegistry, rooted, segments, type Adapter, type Field, type StorageProvider } from './types.ts';

// Connections of one user (table `connections`, docs/STORAGE.md). Secrets are sealed with the user's key (AAD: connection id + user id) and never leave this file in plain form.
export interface ConnRow { id: string; user_id: string; kind: string; name: string; folder: string; config: string; enc: string | null; remote_root: string; status: string; last_sync_at: string | null; last_error: string | null; last_summary: string | null; host_key: string | null; running_at: string | null; created_at: string }

export const aad = (id: string, userId: string) => `conn:${id}:${userId}`;
export const rowOf = (userId: string, id: string) => db.prepare('SELECT * FROM connections WHERE id = ? AND user_id = ?').get(id, userId) as ConnRow | undefined;
export const need = (userId: string, id: string) => rowOf(userId, id) ?? (() => { throw new StorageError(404, 'connection not found'); })();
export const providerOf = (kind: string): StorageProvider => providerRegistry.get(kind) ?? (() => { throw new StorageError(400, `unknown kind "${kind}"`); })();
export const fieldsOf = (p: StorageProvider, userId: string): Field[] => (typeof p.fields === 'function' ? p.fields(userId) : p.fields);
export const secretsOf = (r: ConnRow): Record<string, string> => (r.enc ? JSON.parse(openForUser(r.user_id, r.enc, aad(r.id, r.user_id))) : {});
export const localPath = (r: Pick<ConnRow, 'folder'>) => `/files/${r.folder}`;

/** What the API returns: no secret values, only which secret fields are set. */
export function view(r: ConnRow) {
  let secrets: string[] = [];
  try { const s = secretsOf(r); secrets = Object.keys(s).filter((k) => s[k]); } catch { /* locked: the list still works */ }
  return {
    id: r.id, kind: r.kind, name: r.name, folder: r.folder, path: localPath(r), config: JSON.parse(r.config) as Record<string, unknown>, secretsSet: secrets, remoteRoot: r.remote_root,
    status: r.status, syncing: !!r.running_at && Date.parse(r.running_at) > Date.now() - 15 * 60_000, lastSyncAt: r.last_sync_at, lastError: r.last_error,
    lastSummary: r.last_summary ? JSON.parse(r.last_summary) : null, hostKey: r.host_key, createdAt: r.created_at,
  };
}

/** The display name becomes the folder name: no path or reserved characters, at most 60 characters. */
export function folderName(name: string): string {
  const f = name.replace(/[\\/\0-\x1f<>:"|?*]+/g, '-').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 60).trim();
  if (!f) throw new StorageError(400, 'name: use letters or digits');
  return f;
}

/** Splits and checks the input against the provider's fields: non-secret values go to config, secret ones to secrets. Blank secrets keep the stored value (`keep`). */
export function parseInput(p: StorageProvider, userId: string, config: Record<string, unknown>, secrets: Record<string, unknown>, keep?: { config: Record<string, unknown>; secrets: Record<string, string> }) {
  const fields = fieldsOf(p, userId);
  const known = new Set(fields.map((f) => f.name));
  for (const k of [...Object.keys(config), ...Object.keys(secrets)]) if (!known.has(k)) throw new StorageError(400, `${k}: not a field of ${p.label}`);
  const cfg: Record<string, unknown> = {}, sec: Record<string, string> = {};
  for (const f of fields) {
    const isSecret = f.type === 'secret';
    const raw = (isSecret ? secrets : config)[f.name];
    const blank = raw === undefined || raw === null || raw === '';
    let v: unknown = blank ? (keep ? (isSecret ? keep.secrets : keep.config)[f.name] : undefined) : raw;
    if (v === undefined || v === null || v === '') { if (f.required) throw new StorageError(400, `${f.name}: ${f.label} is required`); continue; }
    if (f.type === 'number') { v = Number(v); if (!Number.isFinite(v)) throw new StorageError(400, `${f.name}: must be a number`); }
    else if (typeof v !== 'string' || v.length > 20_000) throw new StorageError(400, `${f.name}: must be text`);
    else if (f.type === 'select' && f.options && !f.options.some((o) => o.value === v)) throw new StorageError(400, `${f.name}: pick one of the offered values`);
    else if (!isSecret) v = v.trim();
    if (isSecret) sec[f.name] = v as string; else cfg[f.name] = v;
  }
  return { config: cfg, secrets: sec };
}

/** Opens the remote of a connection (below its remote folder). Pins the SFTP host key on first use. The caller closes the adapter. */
export async function openAdapter(r: ConnRow): Promise<Adapter> {
  const p = providerOf(r.kind);
  const a = await p.connect(JSON.parse(r.config), secretsOf(r), {
    userId: r.user_id, hostKey: r.host_key ?? undefined,
    pin: (fp) => { if (!r.host_key) { db.prepare('UPDATE connections SET host_key = ? WHERE id = ? AND host_key IS NULL').run(fp, r.id); r.host_key = fp; } },
  });
  return rooted(a, r.remote_root);
}

/** Connects and lists the remote folder. Never throws. */
export async function testRow(r: ConnRow): Promise<{ ok: boolean; entries?: number; readonly?: boolean; error?: string }> {
  let a: Adapter | undefined;
  try { a = await openAdapter(r); const entries = (await a.list('')).length; return { ok: true, entries, readonly: !(await a.caps()).write }; }
  catch (e) { return { ok: false, error: msg(e) }; } finally { await a?.close?.().catch(() => {}); }
}

const draft = (userId: string, kind: string, config: object, secrets: object, remoteRoot: string, hostKey?: string): ConnRow => {
  const id = randomUUID();
  return { id, user_id: userId, kind, name: '', folder: '', config: JSON.stringify(config), enc: sealForUser(userId, JSON.stringify(secrets), aad(id, userId)), remote_root: remoteRoot, status: 'new', last_sync_at: null, last_error: null, last_summary: null, host_key: hostKey ?? null, running_at: null, created_at: new Date().toISOString() };
};
const cleanRoot = (v: unknown) => { const s = segments(String(v ?? '/')); return '/' + s.join('/'); };

export async function createConnection(userId: string, b: { kind: string; name: string; config: Record<string, unknown>; secrets: Record<string, unknown>; remoteRoot?: string }) {
  const p = providerOf(b.kind);
  const name = String(b.name ?? '').trim().slice(0, 60);
  const folder = folderName(name);
  const fs = fsFor(userId);
  const taken = (db.prepare('SELECT folder FROM connections WHERE user_id = ?').all(userId) as { folder: string }[]).map((x) => x.folder).concat((await fs.list('/files').catch(() => [])).map((e) => e.name));
  if (taken.some((t) => t.toLowerCase() === folder.toLowerCase())) throw new StorageError(409, `a folder named "${folder}" already exists in your files; choose another name`);
  const { config, secrets } = parseInput(p, userId, b.config ?? {}, b.secrets ?? {});
  const r = { ...draft(userId, b.kind, config, secrets, cleanRoot(b.remoteRoot)), name, folder };
  const t = await testRow(r);
  if (!t.ok) throw new StorageError(400, `Could not connect: ${t.error}`);
  db.prepare('INSERT INTO connections (id, user_id, kind, name, folder, config, enc, remote_root, status, host_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(r.id, userId, r.kind, name, folder, r.config, r.enc, r.remote_root, 'new', r.host_key, r.created_at);
  await fs.mkdir(localPath(r), { recursive: true });
  return rowOf(userId, r.id)!;
}

export async function updateConnection(userId: string, id: string, b: { name?: string; config?: Record<string, unknown>; secrets?: Record<string, unknown>; remoteRoot?: string }) {
  const old = need(userId, id), p = providerOf(old.kind);
  const keep = { config: JSON.parse(old.config), secrets: secretsOf(old) };
  const { config, secrets } = parseInput(p, userId, { ...keep.config, ...(b.config ?? {}) }, b.secrets ?? {}, keep);
  const moved = JSON.stringify(config) !== old.config && (config.host !== keep.config.host || config.port !== keep.config.port); // another SSH server: pin its key afresh
  const r: ConnRow = { ...old, config: JSON.stringify(config), enc: sealForUser(userId, JSON.stringify(secrets), aad(id, userId)), remote_root: b.remoteRoot === undefined ? old.remote_root : cleanRoot(b.remoteRoot), host_key: moved ? null : old.host_key };
  const t = await testRow(r);
  if (!t.ok) throw new StorageError(400, `Could not connect: ${t.error}`);
  const name = b.name === undefined ? old.name : String(b.name).trim().slice(0, 60);
  if (!name) throw new StorageError(400, 'name: required');
  db.prepare('UPDATE connections SET name = ?, config = ?, enc = ?, remote_root = ?, host_key = ? WHERE id = ? AND user_id = ?').run(name, r.config, r.enc, r.remote_root, r.host_key, id, userId);
  if (r.remote_root !== old.remote_root) db.prepare('DELETE FROM connection_state WHERE connection_id = ?').run(id); // another remote folder: start from a first sync
  return rowOf(userId, id)!;
}

export async function deleteConnection(userId: string, id: string, keepLocalCopy: boolean) {
  const r = need(userId, id);
  if (r.running_at && Date.parse(r.running_at) > Date.now() - 15 * 60_000) throw new StorageError(409, 'a sync is running; try again in a moment');
  db.prepare('DELETE FROM connection_state WHERE connection_id = ?').run(id);
  db.prepare('DELETE FROM connections WHERE id = ? AND user_id = ?').run(id, userId);
  if (!keepLocalCopy) await fsFor(userId).rm(localPath(r), { recursive: true, force: true }); // the remote is never touched
}
