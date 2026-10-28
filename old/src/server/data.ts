import { randomBytes } from 'node:crypto';
import { db } from './appdb.ts';
import { cellOf, parseCsv, toCsv, valueOfCell, MAX_CSV_ROWS } from './data-csv.ts';
import { compileFilter, compileSearch, compileSort, FilterError, type Rec, type Related } from './data-filter.ts';
import { checkFields, DataError, defaultFor, emptyValue, normalizeValues, type Field } from './data-schema.ts';
import { LockedError, openForTeam, openForUser, sealForTeam, sealForUser } from './vault.ts';

// Data collections (docs/DATA.md): user-defined collections and records, sealed at rest.
// Metadata (name, slug, icon, description, fields) and every record are sealed with the scope's key (personal: the owner's user
// key, team: the team key) and bound to their row by the AAD. Queries open the records in memory and filter, sort and page there.

db.exec(`
CREATE TABLE IF NOT EXISTS data_collections (id TEXT PRIMARY KEY, scope TEXT NOT NULL, owner_id TEXT NOT NULL, enc TEXT NOT NULL, access TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS data_collections_owner ON data_collections (owner_id);
CREATE TABLE IF NOT EXISTS data_records (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, updated_by TEXT);
CREATE INDEX IF NOT EXISTS data_records_col ON data_records (collection_id, created_at);
`);
// Worker got data.use only on new instances; hand it to existing ones once (an admin can take it away again in Roles).
if (!db.prepare("SELECT 1 FROM instance_settings WHERE key = 'data_worker_default'").get()) {
  const w = db.prepare("SELECT permissions FROM roles WHERE id = 'worker'").get() as { permissions: string } | undefined;
  const perms: string[] = w ? JSON.parse(w.permissions) : [];
  if (w && !perms.includes('data.use')) db.prepare("UPDATE roles SET permissions = ? WHERE id = 'worker'").run(JSON.stringify([...perms, 'data.use']));
  db.prepare("INSERT OR IGNORE INTO instance_settings (key, value) VALUES ('data_worker_default', '1')").run();
}

// shortcut: records are opened in memory per query, so a collection is capped; raise it (or index sealed fields) when queries pass ~1 s.
export const MAX_RECORDS = 20_000;
const MAX_COLLECTIONS = { personal: 100, team: 200 };
export const RESERVED_SLUGS = new Set(['collections', 'users', 'roles']);

export interface Actor { id: string; roleId: string; permissions: string[] }
export type Level = 'view' | 'edit' | 'manage';
export interface Access { view: string[]; edit: string[] }
interface Meta { name: string; slug: string; icon: string; description: string; fields: Field[] }
export interface Col extends Meta { id: string; scope: 'personal' | 'team'; ownerId: string; access: Access; createdAt: string; updatedAt: string; level: Level }
interface ColRow { id: string; scope: 'personal' | 'team'; owner_id: string; enc: string; access: string; created_at: string; updated_at: string }
interface RecRow { id: string; collection_id: string; data: string; created_at: string; updated_at: string; created_by: string | null; updated_by: string | null }
export interface Out { id: string; created: string; updated: string; createdBy: string | null; updatedBy: string | null; values: Record<string, unknown>; expand?: Record<string, unknown> }

export function actorOf(userId: string): Actor | undefined {
  const r = db.prepare('SELECT ur.role_id AS roleId, r.permissions FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?').get(userId) as { roleId: string; permissions: string } | undefined;
  return r && { id: userId, roleId: r.roleId, permissions: JSON.parse(r.permissions) };
}

// Time-ordered, and in creation order even inside one millisecond (the counter), so equal timestamps still sort as created.
let lastMs = 0, seq = 0;
const ulid = () => { const ms = Date.now(); seq = ms === lastMs ? seq + 1 : 0; lastMs = ms; return ms.toString(36).padStart(9, '0') + seq.toString(36).padStart(3, '0') + randomBytes(5).toString('hex'); };
const metaAad = (id: string) => `datacol:${id}`;
const recAad = (cid: string, id: string) => `rec:${cid}:${id}`;
const sealIn = (scope: string, owner: string, plain: string, aad: string) => (scope === 'team' ? sealForTeam(plain, aad) : sealForUser(owner, plain, aad));
const openIn = (scope: string, owner: string, v: string, aad: string) => (scope === 'team' ? openForTeam(v, aad) : openForUser(owner, v, aad));

function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---- access ----
function levelOf(a: Actor, row: Pick<ColRow, 'scope' | 'owner_id' | 'access'>): Level | undefined {
  if (!a.permissions.includes('data.use')) return;
  if (row.scope === 'personal') return row.owner_id === a.id ? 'manage' : undefined;
  if (a.permissions.includes('data.manage')) return 'manage';
  const acc = JSON.parse(row.access) as Access;
  return acc.edit.includes(a.roleId) ? 'edit' : acc.view.includes(a.roleId) ? 'view' : undefined;
}
const need = (col: Col, l: Level) => {
  const rank = { view: 0, edit: 1, manage: 2 };
  if (rank[col.level] < rank[l]) throw new DataError(403, l === 'manage' ? 'Only someone with data.manage can change a team collection’s schema or access.' : 'You can view this collection but not change it.');
};

function openCol(a: Actor, row: ColRow): Col {
  const meta = JSON.parse(openIn(row.scope, row.owner_id, row.enc, metaAad(row.id))) as Meta;
  return { ...meta, id: row.id, scope: row.scope, ownerId: row.owner_id, access: JSON.parse(row.access), createdAt: row.created_at, updatedAt: row.updated_at, level: levelOf(a, row)! };
}
const visibleRows = (a: Actor) =>
  (db.prepare("SELECT * FROM data_collections WHERE (scope = 'personal' AND owner_id = ?) OR scope = 'team' ORDER BY created_at").all(a.id) as unknown as ColRow[]).filter((r) => levelOf(a, r));

/** The collections `a` can see. A locked team key hides the team ones (`teamLocked`); a locked user key is a LockedError. */
export function listCollections(a: Actor): { items: Col[]; teamLocked: boolean } {
  const items: Col[] = []; let teamLocked = false;
  for (const r of visibleRows(a)) {
    try { items.push(openCol(a, r)); } catch (e) { if (e instanceof LockedError && e.scope === 'team') teamLocked = true; else throw e; }
  }
  return { items, teamLocked };
}

export const hasCollections = (a: Actor) => visibleRows(a).length > 0;

/** By id, then by slug, then by name (case-insensitive); the caller's own collections win a tie. */
export function getCol(a: Actor, key: string): Col {
  const rows = visibleRows(a), byId = rows.find((r) => r.id === key);
  if (byId) return openCol(a, byId);
  const { items, teamLocked } = listCollections(a), k = String(key).toLowerCase();
  const hit = items.find((c) => c.slug === k) ?? items.find((c) => c.name.toLowerCase() === k);
  if (hit) return hit;
  if (teamLocked) throw new LockedError('team');
  throw new DataError(404, `No collection "${key}" that you can access.`);
}

export const countRecords = (id: string) => (db.prepare('SELECT COUNT(*) AS n FROM data_records WHERE collection_id = ?').get(id) as { n: number }).n;
export const counts = () => new Map((db.prepare('SELECT collection_id AS id, COUNT(*) AS n FROM data_records GROUP BY collection_id').all() as { id: string; n: number }[]).map((r) => [r.id, r.n]));

export function colOut(c: Col, records?: number) {
  return { id: c.id, scope: c.scope, ownerId: c.scope === 'personal' ? c.ownerId : undefined, name: c.name, slug: c.slug, icon: c.icon, description: c.description, fields: c.fields,
    access: c.scope === 'team' && c.level === 'manage' ? c.access : undefined, createdAt: c.createdAt, updatedAt: c.updatedAt, canEdit: c.level !== 'view', canManage: c.level === 'manage', records };
}

// ---- collections ----
const slugify = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'collection';
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const str = (x: unknown, what: string, max: number, min = 0) => {
  if (typeof x !== 'string' || x.trim().length < min || x.length > max) throw new DataError(400, `${what} must be ${min ? 'a non-empty ' : ''}text of at most ${max} characters`);
  return x.trim();
};
function checkAccess(x: unknown): Access {
  const o = (x ?? {}) as Record<string, unknown>, list = (k: string) => {
    const l = o[k] ?? [];
    if (!Array.isArray(l) || l.some((r) => typeof r !== 'string')) throw new DataError(400, `access.${k} must be a list of role ids`);
    for (const r of l) if (!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(r)) throw new DataError(400, `access.${k}: unknown role`);
    return [...new Set(l as string[])];
  };
  const edit = list('edit');
  return { view: [...new Set([...list('view'), ...edit])], edit };
}

/** Resolves relation targets to ids and enforces: a team collection relates only to team collections and users. */
function resolveRelations(a: Actor, scope: string, fields: Field[], selfId: string): Field[] {
  return fields.map((f) => {
    if (f.type !== 'relation' || f.collection === 'users') return f;
    if (f.collection === 'self' || f.collection === selfId) return { ...f, collection: selfId };
    let target: Col;
    try { target = getCol(a, f.collection!); } catch (e) { if (e instanceof DataError) throw new DataError(400, `field "${f.name}": no collection "${f.collection}" that you can access`); throw e; }
    if (scope === 'team' && target.scope === 'personal') throw new DataError(400, `field "${f.name}": a team collection can only relate to team collections or users`);
    return { ...f, collection: target.id };
  });
}

function freeSlug(a: Actor, want: string, selfId?: string) {
  const taken = new Set(listCollections(a).items.filter((c) => c.id !== selfId).map((c) => c.slug));
  let s = RESERVED_SLUGS.has(want) ? `${want}-1` : want, n = 2;
  while (taken.has(s)) s = `${want.slice(0, 44)}-${n++}`;
  return s;
}

export function createCollection(a: Actor, b: Record<string, unknown>): Col {
  const scope = b.scope === 'team' ? 'team' : b.scope === 'personal' || b.scope === undefined ? 'personal' : undefined;
  if (!scope) throw new DataError(400, 'scope must be personal or team');
  if (!a.permissions.includes('data.use') || (scope === 'team' && !a.permissions.includes('data.manage'))) throw new DataError(403, scope === 'team' ? 'Creating a team collection needs data.manage.' : 'forbidden');
  const n = (db.prepare('SELECT COUNT(*) AS n FROM data_collections WHERE scope = ? AND (? = \'team\' OR owner_id = ?)').get(scope, scope, a.id) as { n: number }).n;
  if (n >= MAX_COLLECTIONS[scope]) throw new DataError(409, `At most ${MAX_COLLECTIONS[scope]} ${scope} collections.`);
  const id = 'dc_' + ulid(), name = str(b.name, 'name', 80, 1);
  const slug = b.slug === undefined ? freeSlug(a, slugify(name)) : checkSlug(a, b.slug);
  const meta: Meta = { name, slug, icon: checkIcon(b.icon), description: b.description === undefined ? '' : str(b.description, 'description', 500),
    fields: resolveRelations(a, scope, checkFields(b.fields ?? []), id) };
  const access = scope === 'team' ? checkAccess(b.access) : { view: [], edit: [] }, now = new Date().toISOString();
  db.prepare('INSERT INTO data_collections (id, scope, owner_id, enc, access, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, scope, a.id, sealIn(scope, a.id, JSON.stringify(meta), metaAad(id)), JSON.stringify(access), now, now);
  return getCol(a, id);
}
const checkIcon = (x: unknown) => (x === undefined || x === '' ? 'Database' : /^[A-Za-z0-9]{1,30}$/.test(String(x)) ? String(x) : (() => { throw new DataError(400, 'icon must be a lucide icon name'); })());
function checkSlug(a: Actor, x: unknown, selfId?: string) {
  const s = str(x, 'slug', 48, 1);
  if (!SLUG.test(s) || RESERVED_SLUGS.has(s)) throw new DataError(400, 'slug: lower-case letters, digits and "-" only (and not "collections", "users" or "roles")');
  if (listCollections(a).items.some((c) => c.id !== selfId && c.slug === s)) throw new DataError(409, `slug "${s}" is already used by another collection you can see`);
  return s;
}

export function updateCollection(a: Actor, col: Col, b: Record<string, unknown>): Col {
  need(col, 'manage');
  const meta: Meta = { name: col.name, slug: col.slug, icon: col.icon, description: col.description, fields: col.fields };
  if (b.name !== undefined) meta.name = str(b.name, 'name', 80, 1);
  if (b.slug !== undefined && b.slug !== col.slug) meta.slug = checkSlug(a, b.slug, col.id);
  if (b.icon !== undefined) meta.icon = checkIcon(b.icon);
  if (b.description !== undefined) meta.description = str(b.description, 'description', 500);
  let access = col.access;
  if (b.access !== undefined) { if (col.scope !== 'team') throw new DataError(400, 'Only team collections have role access.'); access = checkAccess(b.access); }
  let migrate: ((recs: Rec[]) => Rec[]) | undefined;
  if (b.fields !== undefined) {
    const next = resolveRelations(a, col.scope, checkFields(b.fields), col.id), old = new Map(col.fields.map((f) => [f.id, f]));
    for (const f of next) {
      const o = old.get(f.id);
      if (o && (o.type !== f.type || !!o.multiple !== !!f.multiple || o.collection !== f.collection))
        throw new DataError(409, `field "${o.name}": the type, "multiple" and relation target cannot change; add a new field and delete this one`);
    }
    if (JSON.stringify(next) !== JSON.stringify(col.fields)) {
      meta.fields = next;
      migrate = (recs) => migrateRecords(col.fields, next, recs, a.id);
    }
  }
  tx(() => {
    if (migrate) {
      const recs = loadRecords(col), moved = migrate(recs), upd = db.prepare('UPDATE data_records SET data = ? WHERE id = ?');
      for (const r of moved) upd.run(sealIn(col.scope, col.ownerId, JSON.stringify(r.data), recAad(col.id, r.id)), r.id);
    }
    db.prepare('UPDATE data_collections SET enc = ?, access = ?, updated_at = ? WHERE id = ?')
      .run(sealIn(col.scope, col.ownerId, JSON.stringify(meta), metaAad(col.id)), JSON.stringify(access), new Date().toISOString(), col.id);
  });
  return getCol(a, col.id);
}

/** Records for the new field list: renamed fields keep their values (matched by field id), removed ones are dropped, new ones get their default. */
function migrateRecords(old: Field[], next: Field[], recs: Rec[], me: string): Rec[] {
  const byId = new Map(old.map((f) => [f.id, f])), bad: string[] = [];
  const out = recs.map((r) => {
    const data: Record<string, unknown> = {};
    for (const f of next) {
      const o = byId.get(f.id);
      let x = o ? r.data[o.name] : defaultFor(f, me);
      if (f.type === 'select' && x != null) x = Array.isArray(x) ? x.filter((y) => f.options!.includes(y)) : f.options!.includes(x as string) ? x : null;
      data[f.name] = x;
    }
    try { return { ...r, data: normalizeValues(next, data, 'update', me) }; } catch (e) { bad.push(`${r.id}: ${(e as Error).message}`); return r; }
  });
  if (bad.length) throw new DataError(409, `${bad.length} record(s) would not fit the new schema, nothing was changed. Make the field optional or give it a default. First: ${bad[0]}`, bad.slice(0, 10));
  for (const f of next.filter((x) => x.unique)) {
    const seen = new Set<string>();
    for (const r of out) { const x = r.data[f.name]; if (emptyValue(x)) continue; const k = JSON.stringify(x); if (seen.has(k)) throw new DataError(409, `field "${f.name}": existing records already share a value, so it cannot be unique`); seen.add(k); }
  }
  return out;
}

export function deleteCollection(a: Actor, col: Col) {
  need(col, 'manage');
  const users = listCollections(a).items.filter((c) => c.id !== col.id && c.fields.some((f) => f.type === 'relation' && f.collection === col.id));
  if (users.length) throw new DataError(409, `Still used by a relation in: ${users.map((c) => c.name).join(', ')}. Remove that field first.`);
  tx(() => { db.prepare('DELETE FROM data_records WHERE collection_id = ?').run(col.id); db.prepare('DELETE FROM data_collections WHERE id = ?').run(col.id); });
}

// ---- records ----
const toRec = (col: Col, r: RecRow): Rec => ({ id: r.id, created: r.created_at, updated: r.updated_at, createdBy: r.created_by, updatedBy: r.updated_by, data: JSON.parse(openIn(col.scope, col.ownerId, r.data, recAad(col.id, r.id))) });
export const loadRecords = (col: Col): Rec[] => (db.prepare('SELECT * FROM data_records WHERE collection_id = ? ORDER BY created_at, id').all(col.id) as unknown as RecRow[]).map((r) => toRec(col, r));
const outOf = (r: Rec): Out => ({ id: r.id, created: r.created, updated: r.updated, createdBy: r.createdBy, updatedBy: r.updatedBy, values: r.data });

function related(a: Actor, memo: Map<string, Related>): (f: Field) => Related {
  return (f) => {
    const key = f.collection!, hit = memo.get(key);
    if (hit) return hit;
    let rel: Related;
    if (key === 'users') {
      const names = new Map((db.prepare('SELECT id, name FROM user').all() as { id: string; name: string }[]).map((u) => [u.id, u.name]));
      rel = { fields: [{ id: 'n', name: 'name', type: 'text' }], get: (id) => (names.has(id) ? { id, created: '', updated: '', createdBy: null, updatedBy: null, data: { name: names.get(id) } } : undefined) };
    } else {
      let target: Col;
      try { target = getCol(a, key); } catch (e) { if (e instanceof DataError) throw new FilterError(`"${f.name}" points to a collection you cannot access`); throw e; }
      const map = new Map(loadRecords(target).map((r) => [r.id, r]));
      rel = { fields: target.fields, get: (id) => map.get(id) };
    }
    memo.set(key, rel);
    return rel;
  };
}

export interface QueryOpts { filter?: string; sort?: string; q?: string; page?: number; perPage?: number; expand?: string }

export function queryRecords(a: Actor, col: Col, o: QueryOpts = {}) {
  const memo = new Map<string, Related>(), rel = related(a, memo);
  let recs = loadRecords(col);
  if (o.q) { const m = compileSearch(o.q, col.fields); recs = recs.filter(m); }
  if (o.filter?.trim()) { const m = compileFilter(o.filter, { fields: col.fields, me: a.id, related: rel }); recs = recs.filter(m); }
  recs.sort(compileSort(o.sort || '-created', col.fields));
  const perPage = Math.min(Math.max(Math.trunc(Number(o.perPage)) || 30, 1), 500), totalItems = recs.length, totalPages = Math.max(Math.ceil(totalItems / perPage), 1);
  const page = Math.min(Math.max(Math.trunc(Number(o.page)) || 1, 1), totalPages);
  const items = recs.slice((page - 1) * perPage, page * perPage).map(outOf);
  const names = (o.expand ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    const f = col.fields.find((x) => x.name === n);
    if (!f || f.type !== 'relation') throw new DataError(400, `expand: "${n}" is not a relation field`);
    let r: Related;
    try { r = rel(f); } catch { continue; } // the related collection is not readable for this user: ids only
    for (const it of items) {
      const get = (id: string) => { const x = r.get(id); return x && (f.collection === 'users' ? { id, name: x.data.name } : outOf(x)); };
      const v = it.values[n];
      const e = f.multiple ? (Array.isArray(v) ? v.map((id) => get(id as string)).filter(Boolean) : []) : typeof v === 'string' ? get(v) ?? null : null;
      (it.expand ??= {})[n] = e;
    }
  }
  return { page, perPage, totalItems, totalPages, items };
}

const ids = (x: unknown) => [x].flat().filter((y): y is string => typeof y === 'string');
function checkRelations(a: Actor, col: Col, data: Record<string, unknown>) {
  for (const f of col.fields) {
    if (f.type !== 'relation') continue;
    const want = [...new Set(ids(data[f.name]))];
    if (!want.length) continue;
    let found: number;
    if (f.collection === 'users') found = (db.prepare(`SELECT COUNT(*) AS n FROM user WHERE id IN (${want.map(() => '?').join(',')})`).get(...want) as { n: number }).n;
    else {
      const target = f.collection === col.id ? col : (() => { try { return getCol(a, f.collection!); } catch (e) { if (e instanceof DataError) throw new DataError(422, `${f.name} points to a collection you cannot access`); throw e; } })();
      found = (db.prepare(`SELECT COUNT(*) AS n FROM data_records WHERE collection_id = ? AND id IN (${want.map(() => '?').join(',')})`).get(target.id, ...want) as { n: number }).n;
    }
    if (found !== want.length) throw new DataError(422, `${f.name} refers to a record that does not exist or that you cannot read`, { [f.name]: 'unknown record' });
  }
}

function checkUnique(col: Col, data: Record<string, unknown>, selfId?: string, existing?: Rec[]) {
  const fs = col.fields.filter((f) => f.unique && !emptyValue(data[f.name]));
  if (!fs.length) return;
  for (const r of existing ?? loadRecords(col)) {
    if (r.id === selfId) continue;
    for (const f of fs) if (r.data[f.name] === data[f.name]) throw new DataError(422, `${f.name} "${data[f.name]}" is already used by another record`, { [f.name]: 'must be unique' });
  }
}

const insert = db.prepare('INSERT INTO data_records (id, collection_id, data, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
function insertRec(a: Actor, col: Col, data: Record<string, unknown>): Rec {
  const id = ulid(), now = new Date().toISOString();
  insert.run(id, col.id, sealIn(col.scope, col.ownerId, JSON.stringify(data), recAad(col.id, id)), now, now, a.id, a.id);
  return { id, created: now, updated: now, createdBy: a.id, updatedBy: a.id, data };
}
const full = () => new DataError(409, `This collection holds ${MAX_RECORDS.toLocaleString('en')} records, the most hefyn opens at once. Delete or export old ones, or split it into two collections.`);

export function createRecord(a: Actor, col: Col, values: unknown): Out {
  need(col, 'edit');
  const data = normalizeValues(col.fields, values, 'create', a.id);
  checkRelations(a, col, data);
  return tx(() => {
    if (countRecords(col.id) >= MAX_RECORDS) throw full();
    checkUnique(col, data);
    return outOf(insertRec(a, col, data));
  });
}

function rowOf(col: Col, id: string) {
  const r = db.prepare('SELECT * FROM data_records WHERE id = ? AND collection_id = ?').get(String(id), col.id) as unknown as RecRow | undefined;
  if (!r) throw new DataError(404, 'No such record in this collection.');
  return r;
}
export const getRecord = (col: Col, id: string): Out => outOf(toRec(col, rowOf(col, id)));

export function updateRecord(a: Actor, col: Col, id: string, patch: unknown): Out {
  need(col, 'edit');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new DataError(400, 'values must be an object');
  const row = rowOf(col, id), cur = toRec(col, row);
  for (const k of Object.keys(patch)) if (!col.fields.some((f) => f.name === k)) throw new DataError(422, `Some values are not valid: ${k} unknown field`, { [k]: 'unknown field' });
  const data = normalizeValues(col.fields, { ...cur.data, ...patch }, 'update', a.id);
  checkRelations(a, col, data);
  return tx(() => {
    checkUnique(col, data, id);
    const now = new Date().toISOString();
    db.prepare('UPDATE data_records SET data = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(sealIn(col.scope, col.ownerId, JSON.stringify(data), recAad(col.id, id)), now, a.id, id);
    return outOf({ ...cur, data, updated: now, updatedBy: a.id });
  });
}

export function deleteRecords(a: Actor, col: Col, list: unknown): number {
  need(col, 'edit');
  if (!Array.isArray(list) || list.length > 1000 || list.some((x) => typeof x !== 'string')) throw new DataError(400, 'ids must be a list of at most 1000 record ids');
  return tx(() => { const del = db.prepare('DELETE FROM data_records WHERE id = ? AND collection_id = ?'); let n = 0; for (const id of list) n += Number(del.run(id, col.id).changes); return n; });
}

// ---- CSV ----
export function exportCsv(a: Actor, col: Col, o: Pick<QueryOpts, 'filter' | 'sort' | 'q'> = {}): string {
  const rows = queryRecords(a, col, { ...o, perPage: 500, page: 1 }), all: Out[] = [...rows.items];
  for (let p = 2; p <= rows.totalPages; p++) all.push(...queryRecords(a, col, { ...o, perPage: 500, page: p }).items);
  return toCsv([col.fields.map((f) => f.name), ...all.map((r) => col.fields.map((f) => cellOf(f, r.values[f.name])))]);
}

export interface ImportReport { created: number; invalid: number; errors: { row: number; error: string }[] }
/** `mapping`: CSV header -> field name (null = skip). Without it, headers match field names case-insensitively. All-or-nothing unless `skipInvalid`. */
export function importCsv(a: Actor, col: Col, text: string, o: { mapping?: Record<string, string | null>; skipInvalid?: boolean; dryRun?: boolean } = {}): ImportReport {
  need(col, 'edit');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new DataError(400, 'The CSV needs a header row and at least one data row.');
  if (rows.length - 1 > MAX_CSV_ROWS) throw new DataError(413, `At most ${MAX_CSV_ROWS} rows per import.`);
  const head = rows[0]!, byName = new Map(col.fields.map((f) => [f.name.toLowerCase(), f]));
  const cols = head.map((h) => {
    const target = o.mapping ? o.mapping[h] : byName.get(h.trim().toLowerCase())?.name;
    if (target == null) return undefined;
    const f = col.fields.find((x) => x.name === target);
    if (!f) throw new DataError(400, `mapping: no field "${target}"`);
    return f;
  });
  if (!cols.some(Boolean)) throw new DataError(400, 'No CSV column matches a field. Check the header names or map the columns.');
  const good: Record<string, unknown>[] = [], errors: ImportReport['errors'] = [];
  let invalid = 0;
  const uniq = col.fields.filter((f) => f.unique), seen = new Map(uniq.map((f) => [f.name, new Set<unknown>()]));
  if (uniq.length) for (const r of loadRecords(col)) for (const f of uniq) if (!emptyValue(r.data[f.name])) seen.get(f.name)!.add(r.data[f.name]);
  rows.slice(1).forEach((cells, i) => {
    const fail = (e: string) => { invalid++; if (errors.length < 50) errors.push({ row: i + 2, error: e }); };
    try {
      const values: Record<string, unknown> = {};
      cols.forEach((f, j) => { if (f && cells[j] !== undefined) values[f.name] = valueOfCell(f, cells[j]!); });
      const data = normalizeValues(col.fields, values, 'create', a.id);
      checkRelations(a, col, data);
      for (const f of uniq) { const x = data[f.name]; if (emptyValue(x)) continue; if (seen.get(f.name)!.has(x)) throw new DataError(422, `${f.name} "${x}" is used twice`); seen.get(f.name)!.add(x); }
      good.push(data);
    } catch (e) { if (e instanceof LockedError) throw e; fail((e as Error).message); }
  });
  if (invalid && !o.skipInvalid) throw new DataError(422, `${invalid} row(s) are not valid, nothing was imported. First: row ${errors[0]!.row}: ${errors[0]!.error}`, { invalid, errors });
  if (o.dryRun) return { created: good.length, invalid, errors };
  tx(() => {
    if (countRecords(col.id) + good.length > MAX_RECORDS) throw full();
    for (const d of good) insertRec(a, col, d);
  });
  return { created: good.length, invalid, errors };
}

export const userChoices = () => db.prepare('SELECT id, name FROM user ORDER BY name').all() as { id: string; name: string }[];
export const roleChoices = () => db.prepare('SELECT id, name FROM roles ORDER BY builtin DESC, name').all() as { id: string; name: string }[];
