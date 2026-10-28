import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = (process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-data-')));
process.env.HEFYN_SECRET = 'data-test-secret-data-test-secret-1234';

const { trpcCall } = await import('./trpc.ts');
const { Hono } = await import('hono');
const vault = await import('../src/server/vault.ts');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const D = await import('../src/server/data.ts');
const { checkFields, normalizeValues, DataError } = await import('../src/server/data-schema.ts');
const { parseFilter, compileFilter, FilterError } = await import('../src/server/data-filter.ts');
const { parseCsv, toCsv } = await import('../src/server/data-csv.ts');
const { useDataTools } = await import('../src/agents/data-tools.ts');
const app = new Hono().route('/api', api);
// (importing the real auth module leaves a timer behind: leave 1 s for the reporter, then exit)
after(() => void setTimeout(() => process.exit(0), 1000).unref());

vault.setTeamKey(vault.newKey());
async function person(email: string, role: string, perms: string[]) {
  const r = await auth.api.signUpEmail({ body: { name: email.split('@')[0]!, email, password: 'password-12345' } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  vault.rememberUserKey(r.user.id, vault.newKey());
  const s = await auth.api.signInEmail({ body: { email, password: 'password-12345' }, returnHeaders: true });
  const cookie = s.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = (path: string, method = 'GET', body?: unknown) => app.request(`/api/data${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const trpc = (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate);
  return { id: r.user.id, roleId: role, permissions: perms, call, trpc };
}
db.prepare("INSERT INTO roles (id, name, builtin, permissions) VALUES ('nodata', 'No data', 0, '[\"models.use\"]')").run();
const admin = await person('admin@x.test', 'admin', ['data.use', 'data.manage']);
const alice = await person('alice@x.test', 'worker', ['data.use']);
const bob = await person('bob@x.test', 'worker', ['data.use']);
const eve = await person('eve@x.test', 'nodata', ['models.use']);

const f = (name: string, type: string, extra: object = {}) => ({ name, type, ...extra });
const fail = (fn: () => unknown, re: RegExp, cls: any = DataError) => assert.throws(fn, (e: any) => e instanceof cls && re.test(e.message), String(re));

test('the worker role gets data.use, only admins data.manage', () => {
  const perms = (id: string) => JSON.parse((db.prepare('SELECT permissions FROM roles WHERE id = ?').get(id) as any).permissions);
  assert.ok(perms('worker').includes('data.use') && !perms('worker').includes('data.manage'));
  assert.ok(perms('admin').includes('data.use') && perms('admin').includes('data.manage'));
});

test('field definitions are validated', () => {
  fail(() => checkFields([f('a b', 'text')]), /start with a letter/);
  fail(() => checkFields([f('id', 'text')]), /reserved/);
  fail(() => checkFields([f('x', 'text'), f('X', 'bool')]), /duplicate name/);
  fail(() => checkFields([f('x', 'select')]), /at least one option/);
  fail(() => checkFields([f('x', 'select', { options: ['a', 'a'] })]), /duplicate options/);
  fail(() => checkFields([f('x', 'bool', { unique: true })]), /unique is only/);
  fail(() => checkFields([f('x', 'text', { min: 1 })]), /only for number/);
  fail(() => checkFields([f('x', 'number', { min: 5, max: 1 })]), /min is greater/);
  fail(() => checkFields([f('x', 'relation')]), /target collection/);
  fail(() => checkFields([f('x', 'number', { default: 'abc' })]), /default/);
  fail(() => checkFields([{ name: 'x', type: 'text', evil: 1 }]), /field 1/);
  fail(() => checkFields([f('x', 'blob')]), /field 1/);
  const ok = checkFields([f('x', 'text'), f('y', 'number')]);
  assert.ok(ok[0]!.id && ok[0]!.id !== ok[1]!.id);
});

test('values are validated per field type', () => {
  const fields = checkFields([
    f('t', 'text', { required: true }), f('l', 'longtext'), f('n', 'number', { min: 1, max: 10, integer: true }), f('b', 'bool'), f('d', 'date'), f('dt', 'datetime'),
    f('s', 'select', { options: ['a', 'b'] }), f('m', 'select', { options: ['a', 'b'], multiple: true }), f('e', 'email'), f('u', 'url'), f('j', 'json'), f('du', 'duration'), f('r', 'relation', { collection: 'users' }),
  ]);
  const good = normalizeValues(fields, { t: 'hi', n: 3, b: true, d: '2026-02-28', dt: '2026-10-22T10:00:00+02:00', s: 'a', m: ['a', 'b'], e: ' Foo@Bar.COM ', u: 'https://x.test/a', j: { a: [1] }, du: 90 }, 'create', 'me');
  assert.equal(good.e, 'foo@bar.com'); assert.equal(good.dt, '2026-10-22T08:00:00.000Z'); assert.equal(good.l, null); assert.equal(good.r, null);
  const bad = (values: object, key: string) => assert.throws(() => normalizeValues(fields, { t: 'x', ...values }, 'create', 'me'), (e: any) => e.status === 422 && key in e.details, key);
  bad({ n: 0 }, 'n'); bad({ n: 11 }, 'n'); bad({ n: 2.5 }, 'n'); bad({ n: '3' }, 'n'); bad({ n: NaN }, 'n');
  bad({ b: 'yes' }, 'b'); bad({ d: '2026-02-30' }, 'd'); bad({ d: '22.10.2026' }, 'd'); bad({ dt: 'tomorrow' }, 'dt');
  bad({ s: 'c' }, 's'); bad({ m: ['a', 'a'] }, 'm'); bad({ m: ['z'] }, 'm'); bad({ e: 'nope' }, 'e'); bad({ u: 'javascript:alert(1)' }, 'u'); bad({ u: 'ftp://x' }, 'u');
  bad({ du: -1 }, 'du'); bad({ du: 1.5 }, 'du'); bad({ ghost: 1 }, 'ghost'); bad({ t: '' }, 't'); bad({ t: 'x'.repeat(5001) }, 't'); bad({ j: 'x'.repeat(70000) }, 'j');
  assert.throws(() => normalizeValues(fields, 'nope', 'create', 'me'), /object/);
  // defaults and tokens
  const withDef = checkFields([f('d', 'date', { default: '@today' }), f('p', 'select', { options: ['lo', 'hi'], default: 'lo' }), f('who', 'relation', { collection: 'users', default: '@me' })]);
  const v = normalizeValues(withDef, {}, 'create', 'u1');
  assert.match(v.d as string, /^\d{4}-\d{2}-\d{2}$/); assert.equal(v.p, 'lo'); assert.equal(v.who, 'u1');
  assert.equal(normalizeValues(withDef, { d: '@today', who: '@me' }, 'create', 'u1').d, v.d, 'a token typed as a value stands for what it names');
  assert.equal(normalizeValues(checkFields([f('t', 'text')]), { t: '@today' }, 'create', 'u1').t, '@today', 'on a text field it is just text');
});

const ctx = (fields: any[], extra: object = {}) => ({ fields: checkFields(fields), me: 'me-id', now: new Date(2026, 9, 22, 12), related: () => { throw new FilterError('no relation here'); }, ...extra });
const rec = (data: Record<string, unknown>, id = 'r1') => ({ id, created: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z', createdBy: null, updatedBy: null, data });

test('filter language: operators, logic, variables', () => {
  const c = ctx([f('title', 'text'), f('status', 'select', { options: ['todo', 'done'] }), f('due', 'date'), f('hours', 'number'), f('ok', 'bool'), f('tags', 'select', { options: ['a', 'b', 'c'], multiple: true }), f('at', 'datetime'), f('note', 'text')]);
  const run = (src: string, data: object) => compileFilter(src, c)(rec({ title: 'Ship it', status: 'todo', due: '2026-10-20', hours: 2.5, ok: true, tags: ['a', 'b'], at: '2026-10-22T09:30:00.000Z', note: null, ...data }));
  assert.ok(run('status = "todo"', {})); assert.ok(!run('status != "todo"', {})); assert.ok(run("status = 'todo'", {}));
  assert.ok(run('hours > 2 && hours <= 2.5', {})); assert.ok(!run('hours < 2', {})); assert.ok(run('title ~ "SHIP"', {})); assert.ok(run('title !~ "zzz"', {}));
  assert.ok(run('(status = "done" || status = "todo") && ok = true', {})); assert.ok(!run('status = "done" || (ok = false && hours > 0)', {}));
  assert.ok(run('due <= @today', {})); assert.ok(!run('due > @today', {})); assert.ok(run('due >= @weekStart && due <= @weekEnd', {}), 'Thu 22 Oct 2026: week is 19..25');
  assert.ok(run('due >= @monthStart && due <= @monthEnd', {})); assert.ok(run('due = "2026-10-20"', {}));
  assert.ok(run('at = "2026-10-22"', {}), 'a day matches the whole day'); assert.ok(run('at <= "2026-10-22"', {})); assert.ok(!run('at > "2026-10-22"', {})); assert.ok(run('at >= "2026-10-22T09:00:00Z"', {}));
  assert.ok(run('tags = "a"', {})); assert.ok(!run('tags = "c"', {})); assert.ok(run('tags != "c"', {})); assert.ok(run('tags ~ "b"', {}));
  assert.ok(run('note = null', {})); assert.ok(!run('title = null', {})); assert.ok(run('title != null', {}));
  assert.ok(!run('hours > 1', { hours: null })); assert.ok(run('hours != 1', { hours: null }));
  assert.ok(run('ok = true && created >= "2026-09-30"', {})); assert.ok(run('id = "r1"', {}));
  assert.ok(compileFilter('createdBy = @me', c)({ ...rec({}), createdBy: 'me-id' }));
});

test('filter language: errors and no injection', () => {
  const c = ctx([f('title', 'text'), f('hours', 'number'), f('ok', 'bool'), f('due', 'date'), f('j', 'json'), f('s', 'select', { options: ['x'] })]);
  const bad = (src: string, re: RegExp) => assert.throws(() => compileFilter(src, c), (e: any) => e instanceof FilterError && e.status === 400 && re.test(e.message), src);
  bad('', /empty/); bad('title', /operator/); bad('title =', /value/); bad('title = x', /quotes/); bad('nope = 1', /unknown field/);
  bad('title = "a', /unterminated/); bad('(title = "a"', /missing "\)"/); bad('title = "a" title = "b"', /unexpected/); bad('title = "a" &', /unexpected/); bad('title = "a" || ', /expected a field/);
  bad('hours = "abc"', /number/); bad('hours > true', /number/); bad('ok = 5', /true or false/); bad('ok > false', /not available/); bad('due = "soon"', /date/); bad('due > @bogus', /unknown variable/);
  bad('s > "x"', /not available/); bad('hours ~ "1"', /text/); bad('title > null', /null/); bad('title.name = "x"', /not a relation/); bad('@now = 1', /field name/);
  bad('title = "a" ; DROP TABLE x', /unexpected/); bad('title = `a`', /unexpected/); bad('(' .repeat(30) + 'title = "a"' + ')'.repeat(30), /deeply/); bad('title = "a" && '.repeat(120) + 'title = "a"', /too long/);
  // strings are data: quotes, operators and escapes inside them cannot change the query
  const hit = (src: string, title: string) => compileFilter(src, c)(rec({ title }));
  assert.ok(hit('title = "a\\" || title != \\"b"', 'a" || title != "b'));
  assert.ok(hit(`title = "x' && 1 = 1 --"`, "x' && 1 = 1 --"));
  assert.ok(!hit('title = "a" || "1" = "1"'.replace(' || "1" = "1"', ''), 'b'));
  assert.throws(() => parseFilter('title = "a" || "1" = "1"'), FilterError);
  assert.ok(hit('title ~ "(a)"', 'x (a) y')); assert.ok(hit('title = "@me"', '@me'), '"@me" in quotes is a plain string');
  assert.ok(hit('title = "constructor"', 'constructor') && !hit('title = "__proto__"', 'x'));
  assert.throws(() => compileFilter('__proto__ = 1', c), FilterError); assert.throws(() => compileFilter('constructor = 1', c), FilterError);
});

test('collections: create, query, sort, paginate, search', () => {
  const a = alice as any;
  const col = D.createCollection(a, { name: 'Tasks', fields: [f('title', 'text', { required: true }), f('prio', 'number'), f('due', 'date'), f('status', 'select', { options: ['todo', 'doing', 'done'], default: 'todo' })] });
  assert.equal(col.slug, 'tasks'); assert.equal(D.createCollection(a, { name: 'Tasks' }).slug, 'tasks-2');
  fail(() => D.createCollection(a, { name: 'Z', slug: 'collections' }), /slug/);
  fail(() => D.createCollection(a, { name: '' }), /name/);
  fail(() => D.createCollection(a, { name: 'T', scope: 'team' }), /data\.manage/);
  for (let i = 1; i <= 25; i++) D.createRecord(a, col, { title: `Task ${String(i).padStart(2, '0')}`, prio: i % 5, due: i % 4 === 0 ? null : `2026-10-${String(i).padStart(2, '0')}`, status: i % 3 === 0 ? 'done' : undefined });
  const q = (o: object) => D.queryRecords(a, col, o);
  assert.equal(q({}).totalItems, 25); assert.equal(q({ perPage: 10 }).items.length, 10); assert.equal(q({ perPage: 10 }).totalPages, 3);
  assert.equal(q({ perPage: 10, page: 3 }).items.length, 5); assert.equal(q({ perPage: 10, page: 99 }).page, 3, 'a page past the end is clamped');
  assert.equal(q({ filter: 'status != "done"' }).totalItems, 17);
  assert.equal(q({ filter: 'status != "done" && due <= "2026-10-10"' }).totalItems, q({ filter: 'status = "todo" && due <= "2026-10-10"' }).totalItems);
  assert.deepEqual(q({ sort: '-prio,title', perPage: 3 }).items.map((r: any) => r.values.title), ['Task 04', 'Task 09', 'Task 14']);
  assert.deepEqual(q({ sort: 'due', perPage: 100 }).items.slice(-6).map((r: any) => r.values.due), [null, null, null, null, null, null], 'empty values sort last');
  assert.equal(q({ sort: '-due', perPage: 1 }).items[0]!.values.due, '2026-10-25');
  assert.equal(q({ q: 'task 07' }).totalItems, 1);
  fail(() => q({ sort: 'nope' }), /unknown field/); fail(() => q({ filter: 'nope = 1' }), /unknown field/, FilterError); fail(() => q({ expand: 'title' }), /not a relation/);
  assert.equal(D.getCol(a, 'Tasks').id, col.id, 'by name'); assert.equal(D.getCol(a, col.id).id, col.id, 'by id');
  const r = q({ perPage: 1 }).items[0]!;
  const upd = D.updateRecord(a, col, r.id, { prio: 9 });
  assert.equal(upd.values.prio, 9); assert.equal(upd.values.title, r.values.title);
  fail(() => D.updateRecord(a, col, r.id, { ghost: 1 }), /unknown field/); fail(() => D.updateRecord(a, col, 'nope', { prio: 1 }), /No such record/);
  assert.equal(D.deleteRecords(a, col, [r.id]), 1); assert.equal(q({}).totalItems, 24);
});

test('access: personal stays private, team views and edits follow the role, schema needs data.manage', () => {
  const a = alice as any, b = bob as any, adm = admin as any;
  const mine = D.createCollection(a, { name: 'Diary', fields: [f('text', 'text')] });
  D.createRecord(a, mine, { text: 'secret' });
  assert.deepEqual(D.listCollections(b).items.filter((c) => c.name === 'Diary'), []);
  fail(() => D.getCol(b, mine.id), /No collection/); fail(() => D.getCol(b, 'diary'), /No collection/);
  assert.ok(!D.hasCollections(b) || D.listCollections(b).items.every((c) => c.scope === 'team'));
  const team = D.createCollection(adm, { name: 'Clients', scope: 'team', fields: [f('name', 'text')], access: { view: ['worker'], edit: [] } });
  assert.equal(team.scope, 'team'); assert.deepEqual(team.access, { view: ['worker'], edit: [] });
  D.createRecord(adm, team, { name: 'ACME' });
  const asBob = D.getCol(b, 'clients');
  assert.equal(asBob.level, 'view'); assert.equal(D.colOut(asBob).access, undefined, 'only managers see the access list');
  assert.equal(D.queryRecords(b, asBob).totalItems, 1);
  fail(() => D.createRecord(b, asBob, { name: 'x' }), /not change/); fail(() => D.updateRecord(b, asBob, D.queryRecords(b, asBob).items[0]!.id, { name: 'x' }), /not change/);
  fail(() => D.deleteRecords(b, asBob, []), /not change/); fail(() => D.updateCollection(b, asBob, { name: 'Hacked' }), /data\.manage/);
  D.updateCollection(adm, D.getCol(adm, team.id), { access: { view: [], edit: ['worker'] } });
  const editable = D.getCol(b, 'clients');
  assert.equal(editable.level, 'edit'); assert.equal(D.createRecord(b, editable, { name: 'Initech' }).values.name, 'Initech');
  fail(() => D.updateCollection(b, editable, { fields: [f('name', 'text'), f('x', 'text')] }), /data\.manage/); fail(() => D.deleteCollection(b, editable), /data\.manage/);
  D.updateCollection(adm, D.getCol(adm, team.id), { access: { view: [], edit: [] } });
  fail(() => D.getCol(b, 'clients'), /No collection/);
  assert.equal(D.getCol(adm, 'clients').level, 'manage', 'data.manage always sees team collections');
  fail(() => D.createCollection(adm, { name: 'Bad', scope: 'team', access: { view: ['ghost-role'] } }), /unknown role/);
  fail(() => D.updateCollection(a, D.getCol(a, mine.id), { access: { view: ['worker'] } }), /team collections/);
  fail(() => D.createCollection({ ...a, permissions: ['models.use'] }, { name: 'Nope' }), /forbidden/);
  assert.deepEqual(D.listCollections({ ...a, permissions: ['models.use'] }).items, []);
});

test('sealing at rest: no plaintext names or values in app.db, ciphertext is bound to its row', () => {
  const a = alice as any, adm = admin as any;
  const col = D.createCollection(a, { name: 'Zebrafinch notebook', description: 'Quetzalcoatl plans', fields: [f('Obsidianfield', 'text')] });
  const rec = D.createRecord(a, col, { Obsidianfield: 'Marmalade-4711' });
  const team = D.createCollection(adm, { name: 'Narwhal ledger', scope: 'team', fields: [f('Pinecone', 'text')], access: { view: ['worker'] } });
  D.createRecord(adm, team, { Pinecone: 'Tangerine-0815' });
  const dump = JSON.stringify([db.prepare('SELECT * FROM data_collections').all(), db.prepare('SELECT * FROM data_records').all()]);
  for (const s of ['Zebrafinch', 'Quetzalcoatl', 'Obsidianfield', 'Marmalade', 'Narwhal', 'Pinecone', 'Tangerine', 'zebrafinch-notebook']) assert.ok(!dump.includes(s), `${s} must not be in the tables`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const files = readdirSync(dir).filter((x) => x.startsWith('app.db') && !x.endsWith('-shm'));
  for (const fn of files) { const raw = readFileSync(join(dir, fn)).toString('latin1'); for (const s of ['Marmalade', 'Tangerine', 'Zebrafinch', 'Narwhal']) assert.ok(!raw.includes(s), `${s} must not be in ${fn}`); }
  // moved ciphertext does not open
  const row = db.prepare('SELECT * FROM data_records WHERE id = ?').get(rec.id) as any;
  const other = D.createRecord(a, col, { Obsidianfield: 'other' });
  db.prepare('UPDATE data_records SET data = ? WHERE id = ?').run(row.data, other.id);
  assert.throws(() => D.getRecord(col, other.id), /authenticate|auth/i);
  db.prepare('UPDATE data_records SET data = ?, collection_id = ? WHERE id = ?').run(row.data, 'dc_other', rec.id);
  assert.throws(() => D.queryRecords(a, col), /unable to authenticate|auth/i, 'a record moved to another collection fails to open');
  db.prepare('DELETE FROM data_records WHERE id IN (?, ?)').run(rec.id, other.id);
  const e = db.prepare('SELECT enc FROM data_collections WHERE id = ?').get(col.id) as any, t = db.prepare('SELECT id, enc FROM data_collections WHERE id = ?').get(team.id) as any;
  db.prepare('UPDATE data_collections SET enc = ? WHERE id = ?').run(e.enc, team.id);
  assert.throws(() => D.listCollections(bob as any), /auth/i, 'a collection sealed for another row fails to open');
  db.prepare('UPDATE data_collections SET enc = ? WHERE id = ?').run(t.enc, team.id);
});

test('locked keys: a locked user key is a LockedError, a locked team key only hides the team collections', () => {
  const b = bob as any, key = vault.userKey(b.id)!;
  D.createCollection(b, { name: 'Lockable' });
  vault.forgetUserKey(b.id);
  assert.throws(() => D.listCollections(b), (e: any) => e.code === 'locked' && e.scope === 'user');
  vault.rememberUserKey(b.id, key);
  const team = vault.getTeamKey()!;
  vault.setTeamKey(undefined);
  const r = D.listCollections(b);
  assert.equal(r.teamLocked, true); assert.ok(r.items.some((c) => c.name === 'Lockable'));
  assert.throws(() => D.getCol(b, 'clients-unknown'), (e: any) => e.code === 'locked' && e.scope === 'team');
  vault.setTeamKey(team);
  assert.equal(D.listCollections(b).teamLocked, false);
});

test('relations: targets must exist and be readable; users and scope rules', () => {
  const a = alice as any, b = bob as any, adm = admin as any;
  const projects = D.createCollection(a, { name: 'Projects', fields: [f('name', 'text', { required: true })] });
  const time = D.createCollection(a, { name: 'Time', fields: [f('project', 'relation', { collection: projects.id }), f('who', 'relation', { collection: 'users', default: '@me' }), f('more', 'relation', { collection: 'projects', multiple: true })] });
  assert.equal(time.fields[2]!.collection, projects.id, 'a slug is resolved to the id');
  const p1 = D.createRecord(a, projects, { name: 'Website' }), p2 = D.createRecord(a, projects, { name: 'App' });
  const t = D.createRecord(a, time, { project: p1.id, more: [p1.id, p2.id] });
  assert.equal(t.values.who, a.id, '@me default');
  fail(() => D.createRecord(a, time, { project: 'ghost' }), /does not exist/); fail(() => D.createRecord(a, time, { who: 'ghost-user' }), /does not exist/);
  // a record of another collection is not a valid target
  const other = D.createCollection(a, { name: 'Other', fields: [f('n', 'text')] }), o1 = D.createRecord(a, other, { n: 'x' });
  fail(() => D.createRecord(a, time, { project: o1.id }), /does not exist/);
  // expand and dotted filters
  const ex = D.queryRecords(a, time, { expand: 'project,who,more' }).items[0]!;
  assert.equal((ex.expand!.project as any).values.name, 'Website'); assert.equal((ex.expand!.who as any).name, 'alice'); assert.equal((ex.expand!.more as any[]).length, 2);
  assert.equal(D.queryRecords(a, time, { filter: 'project.name = "Website"' }).totalItems, 1); assert.equal(D.queryRecords(a, time, { filter: 'project.name ~ "app"' }).totalItems, 0);
  assert.equal(D.queryRecords(a, time, { filter: 'more.name = "App"' }).totalItems, 1); assert.equal(D.queryRecords(a, time, { filter: 'who.name = "alice"' }).totalItems, 1);
  fail(() => D.queryRecords(a, time, { filter: 'project.nope = 1' }), /unknown field/, FilterError); fail(() => D.queryRecords(a, time, { filter: 'project.name.x = 1' }), /one relation level/, FilterError);
  // schema rules
  fail(() => D.updateCollection(a, time, { fields: [f('project', 'relation', { collection: 'other', id: time.fields[0]!.id }), ...time.fields.slice(1)] }), /cannot change/);
  fail(() => D.createCollection(a, { name: 'Bad', fields: [f('x', 'relation', { collection: 'nowhere' })] }), /no collection/);
  fail(() => D.createCollection(adm, { name: 'TeamRel', scope: 'team', fields: [f('x', 'relation', { collection: projects.id })] }), /no collection/, DataError); // admin cannot even see alice's
  const teamProjects = D.createCollection(adm, { name: 'TeamProjects', scope: 'team', fields: [f('name', 'text')], access: { view: ['worker'] } });
  const adminPersonal = D.createCollection(adm, { name: 'AdminPersonal', fields: [f('n', 'text')] });
  fail(() => D.createCollection(adm, { name: 'TeamRel', scope: 'team', fields: [f('x', 'relation', { collection: adminPersonal.id })] }), /team collection can only relate/);
  const self = D.createCollection(a, { name: 'Tree', fields: [f('name', 'text'), f('parent', 'relation', { collection: 'self' })] });
  assert.equal(self.fields[1]!.collection, self.id);
  const root = D.createRecord(a, self, { name: 'root' }); assert.equal(D.createRecord(a, self, { name: 'leaf', parent: root.id }).values.parent, root.id);
  // personal collection may relate to a team collection the user can view; the team record must exist
  const tp = D.createRecord(adm, teamProjects, { name: 'Shared' });
  const mineToTeam = D.createCollection(b, { name: 'Notes', fields: [f('proj', 'relation', { collection: teamProjects.id })] });
  assert.equal(D.createRecord(b, mineToTeam, { proj: tp.id }).values.proj, tp.id);
  fail(() => D.deleteCollection(a, projects), /Still used by/); // referenced by Time
  D.updateCollection(adm, D.getCol(adm, teamProjects.id), { access: { view: [], edit: [] } });
  fail(() => D.createRecord(b, mineToTeam, { proj: tp.id }), /cannot access/), assert.equal(D.queryRecords(b, mineToTeam, { expand: 'proj' }).items[0]!.expand, undefined, 'expand skips what the user can no longer read');
});

test('unique fields, required, and the record limit', () => {
  const a = alice as any;
  const col = D.createCollection(a, { name: 'People', fields: [f('email', 'email', { unique: true }), f('code', 'number', { unique: true }), f('nick', 'text', { unique: true })] });
  D.createRecord(a, col, { email: 'a@x.test', code: 1, nick: 'a' });
  fail(() => D.createRecord(a, col, { email: 'A@X.test' }), /already used/); fail(() => D.createRecord(a, col, { code: 1 }), /already used/);
  D.createRecord(a, col, {}); D.createRecord(a, col, {}); // empty values never collide
  const b2 = D.createRecord(a, col, { email: 'b@x.test', nick: 'b' });
  fail(() => D.updateRecord(a, col, b2.id, { nick: 'a' }), /already used/); D.updateRecord(a, col, b2.id, { nick: 'b' }); // own value is fine
  assert.equal(D.MAX_RECORDS, 20000);
  const small = D.createCollection(a, { name: 'Many', fields: [f('n', 'number')] });
  const insert = db.prepare('INSERT INTO data_records (id, collection_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN'); for (let i = 0; i < D.MAX_RECORDS; i++) insert.run(`filler${i}`, small.id, 'x', 't', 't'); db.exec('COMMIT');
  fail(() => D.createRecord(a, small, { n: 1 }), /20,000 records/);
  assert.equal(D.counts().get(small.id), D.MAX_RECORDS);
  db.prepare('DELETE FROM data_records WHERE collection_id = ?').run(small.id);
});

test('schema changes migrate the records: rename, remove, add, option removal, refusals', () => {
  const a = alice as any;
  const col = D.createCollection(a, { name: 'Migrate', fields: [f('title', 'text'), f('old', 'text'), f('kind', 'select', { options: ['a', 'b', 'c'] }), f('tags', 'select', { options: ['x', 'y'], multiple: true })] });
  const r1 = D.createRecord(a, col, { title: 'T1', old: 'keep me', kind: 'c', tags: ['x', 'y'] });
  const ids = Object.fromEntries(col.fields.map((x) => [x.name, x.id]));
  const next = [{ ...col.fields[0]! }, { ...col.fields[1]!, name: 'renamed' }, { ...col.fields[2]!, options: ['a', 'b'] }, { ...col.fields[3]!, options: ['x'] }, f('added', 'number', { default: 7 })];
  const out = D.updateCollection(a, col, { fields: next });
  const got = D.getRecord(out, r1.id).values;
  assert.deepEqual(got, { title: 'T1', renamed: 'keep me', kind: null, tags: ['x'], added: 7 }, 'renamed keeps the value, removed options are cleared, new fields get their default');
  assert.equal(out.fields[1]!.id, ids.old);
  assert.equal(D.queryRecords(a, out, { filter: 'renamed = "keep me"' }).totalItems, 1);
  // removing a field drops the values
  const out2 = D.updateCollection(a, out, { fields: out.fields.filter((x) => x.name !== 'renamed') });
  assert.ok(!('renamed' in D.getRecord(out2, r1.id).values));
  // refusals leave everything as it was
  fail(() => D.updateCollection(a, out2, { fields: [...out2.fields, f('must', 'text', { required: true })] }), /would not fit/);
  fail(() => D.updateCollection(a, out2, { fields: out2.fields.map((x) => (x.name === 'title' ? { ...x, type: 'number' } : x)) }), /cannot change/);
  fail(() => D.updateCollection(a, out2, { fields: out2.fields.map((x) => (x.name === 'tags' ? { ...x, multiple: false } : x)) }), /cannot change/);
  D.createRecord(a, out2, { title: 'dup' }); D.createRecord(a, out2, { title: 'dup' });
  fail(() => D.updateCollection(a, out2, { fields: out2.fields.map((x) => (x.name === 'title' ? { ...x, unique: true } : x)) }), /cannot be unique/);
  assert.equal(D.getCol(a, out2.id).fields.length, out2.fields.length);
  // required with a default fills the existing records
  const out3 = D.updateCollection(a, out2, { fields: [...out2.fields, f('level', 'number', { required: true, default: 1 })] });
  assert.ok(D.queryRecords(a, out3).items.every((r) => r.values.level === 1));
  // plain metadata
  const meta = D.updateCollection(a, out3, { name: 'Renamed', icon: 'Briefcase', description: 'd', slug: 'renamed-slug' });
  assert.deepEqual([meta.name, meta.icon, meta.description, meta.slug], ['Renamed', 'Briefcase', 'd', 'renamed-slug']);
  fail(() => D.updateCollection(a, meta, { slug: 'Bad Slug' }), /slug/); fail(() => D.updateCollection(a, meta, { slug: 'tasks' }), /already used/);
  // delete removes the records
  D.deleteCollection(a, meta);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM data_records WHERE collection_id = ?').get(col.id) as any).n, 0);
  fail(() => D.getCol(a, col.id), /No collection/);
});

test('CSV: parser and writer, round trip, formula guard, mapping and errors', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, ""y""",\nz,"line\nbreak"\n'), [['a', 'b'], ['x, "y"', ''], ['z', 'line\nbreak']]);
  assert.deepEqual(parseCsv('﻿a;b\n'), [['a;b']]);
  assert.throws(() => parseCsv('a,"b'), /unterminated/);
  assert.equal(toCsv([['a', 'b,c'], ['"q"', 'x\ny']]), 'a,"b,c"\r\n"""q""","x\ny"\r\n');
  const a = alice as any;
  const projects = D.createCollection(a, { name: 'CsvProjects', fields: [f('name', 'text')] }), pr = D.createRecord(a, projects, { name: 'P' });
  const col = D.createCollection(a, { name: 'Csv', fields: [f('title', 'text', { required: true }), f('n', 'number'), f('ok', 'bool'), f('d', 'date'), f('s', 'select', { options: ['a', 'b'], multiple: true }), f('j', 'json'), f('mins', 'duration'), f('p', 'relation', { collection: projects.id })] });
  const rows = [
    { title: '=HYPERLINK("http://evil")', n: -5, ok: true, d: '2026-10-22', s: ['a', 'b'], j: { k: [1, 'x,y'] }, mins: 90, p: pr.id },
    { title: 'Line, with "quotes"\nand newline', n: 1.5, ok: false },
    { title: '@SUM(1)', mins: 0 }, { title: '  spaced  ' },
  ];
  for (const r of rows) D.createRecord(a, col, r);
  const csv = D.exportCsv(a, col, { sort: 'created' });
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`), 'a leading = is defused on export');
  assert.ok(csv.split('\r\n')[1]!.includes(',-5,'), 'numbers keep their sign');
  const copy = D.createCollection(a, { name: 'Csv copy', fields: col.fields.map((x) => ({ ...x, id: undefined })) });
  const rep = D.importCsv(a, copy, csv);
  assert.equal(rep.created, 4);
  const strip = (c: any, x: any) => D.queryRecords(a, c, { sort: 'created', perPage: 10 }).items.map((r: any) => r.values);
  assert.deepEqual(strip(copy, 0), strip(col, 0), 'export then import restores every value');
  // mapping, h:mm durations, partial import
  const text = 'Name;x\n'.replace(';', ',') + 'One,1\nTwo,2\n';
  const m = D.importCsv(a, col, 'Aufgabe,Dauer,Skip\nA,1:30,x\nB,45,y\n,5,z\n', { mapping: { Aufgabe: 'title', Dauer: 'mins', Skip: null }, skipInvalid: true });
  assert.deepEqual([m.created, m.invalid, m.errors[0]!.row], [2, 1, 4]);
  assert.deepEqual(D.queryRecords(a, col, { filter: 'title = "A"' }).items[0]!.values.mins, 90);
  const before = D.counts().get(col.id);
  assert.throws(() => D.importCsv(a, col, 'title,n\nok,1\nbad,abc\n'), (e: any) => e.status === 422 && /nothing was imported/.test(e.message) && e.details.errors[0].row === 3);
  assert.throws(() => D.importCsv(a, col, 'title,p\nx,ghost\n'), /does not exist/);
  assert.equal(D.counts().get(col.id), before, 'a refused import changes nothing');
  assert.equal(D.importCsv(a, col, 'title\nzzz\n', { dryRun: true }).created, 1); assert.equal(D.counts().get(col.id), before);
  fail(() => D.importCsv(a, col, 'nothing,here\n1,2\n'), /No CSV column/); fail(() => D.importCsv(a, col, 'a\n'), /header row/); fail(() => D.importCsv(a, col, 'x\n1', { mapping: { x: 'ghost' } }), /no field/);
  void text;
});

test('tRPC data.*: permission, shapes, CSV download (REST), import, bulk delete', async () => {
  assert.equal((await eve.trpc('data.collections.list')).status, 403);
  assert.equal((await trpcCall((p, i) => app.request(p, i), '', 'data.collections.list')).status, 401);
  const r = await alice.trpc('data.collections.create', { name: 'Http tasks', icon: 'Briefcase', fields: [f('title', 'text'), f('due', 'date')] }, true);
  assert.equal(r.status, 200);
  const col = r.json;
  assert.equal(col.canManage, true); assert.equal(col.records, 0);
  const list = (await alice.trpc('data.collections.list')).json;
  assert.ok(list.items.some((c: any) => c.id === col.id)); assert.equal(list.teamLocked, false);
  assert.equal((await bob.trpc('data.records.list', { collection: col.slug })).status, 404);
  const c1 = await alice.trpc('data.records.create', { collection: col.slug, values: { title: 'One', due: '2026-10-22' } }, true);
  assert.equal(c1.status, 200);
  const rec = c1.json;
  assert.deepEqual(Object.keys(rec).sort(), ['created', 'createdBy', 'id', 'updated', 'updatedBy', 'values']);
  const bad = await alice.trpc('data.records.create', { collection: col.slug, values: { title: 'x', due: 'soon' } }, true);
  assert.equal(bad.status, 422); assert.ok(bad.details.due);
  assert.equal((await alice.trpc('data.records.create', { collection: col.id, values: 'nope' }, true)).status, 400);
  await alice.trpc('data.records.create', { collection: col.id, values: { title: 'Two' } }, true);
  const q = (await alice.trpc('data.records.list', { collection: col.id, filter: 'due >= "2026-10-01"', sort: '-created', perPage: 1, page: 1 })).json;
  assert.deepEqual([q.totalItems, q.totalPages, q.items.length, q.page, q.perPage], [1, 1, 1, 1, 1]);
  assert.equal((await alice.trpc('data.records.list', { collection: col.id, filter: 'due >>' })).status, 400);
  const patched = (await alice.trpc('data.records.update', { collection: col.id, id: rec.id, values: { title: 'Uno' } }, true)).json;
  assert.equal(patched.values.title, 'Uno'); assert.equal((await alice.trpc('data.records.get', { collection: col.id, id: rec.id })).json.values.title, 'Uno');
  const csv = await alice.call(`/${col.id}/export.csv`);
  assert.match(csv.headers.get('content-type')!, /text\/csv/); assert.match(csv.headers.get('content-disposition')!, /http-tasks\.csv/); assert.equal(csv.headers.get('cache-control'), 'no-store');
  const text = await csv.text(); assert.ok(text.startsWith('title,due\r\n'));
  const imp = (await alice.trpc('data.importCsv', { collection: col.id, csv: 'title,due\nA,2026-01-01\nB,2026-01-02\n' }, true)).json;
  assert.equal(imp.created, 2);
  assert.equal((await alice.trpc('data.importCsv', { collection: col.id, csv: 'title,due\nA,nope\n' }, true)).status, 422);
  const all = (await alice.trpc('data.records.list', { collection: col.id, perPage: 100 })).json;
  const del = (await alice.trpc('data.records.delete', { collection: col.id, ids: all.items.slice(0, 2).map((x: any) => x.id) }, true)).json;
  assert.equal(del.deleted, 2);
  assert.equal((await alice.trpc('data.records.delete', { collection: col.id, ids: [all.items[2].id] }, true)).json.deleted, 1);
  assert.equal((await bob.trpc('data.records.delete', { collection: col.id, ids: ['x'] }, true)).status, 404);
  assert.equal((await alice.trpc('data.users')).status, 200); assert.ok((await alice.trpc('data.users')).json.every((u: any) => !('email' in u)));
  assert.equal((await alice.trpc('data.roles')).status, 403); assert.equal((await admin.trpc('data.roles')).status, 200);
  assert.equal((await alice.trpc('data.collections.create', { name: 'T', scope: 'team' }, true)).status, 403);
  assert.equal((await alice.trpc('data.collections.update', { collection: col.id, patch: { name: 'Http renamed' } }, true)).status, 200);
  assert.equal((await alice.trpc('data.collections.delete', { collection: col.id }, true)).status, 200);
  assert.equal((await alice.trpc('data.collections.get', { collection: col.id })).status, 404);
});

test('agent tools: list, query with filters and relations, create, update; access limits and no delete', async () => {
  const tools = (userId: string) => {
    const t: Record<string, any> = {};
    useDataTools(userId, ((d: any) => void (t[d.name] = d)) as any);
    return t;
  };
  const run = async (t: any, data: object) => { const out = await t.run({ data }); return out.startsWith('Error') ? out : JSON.parse(out); };
  assert.deepEqual(Object.keys(tools(eve.id)), [], 'no data.use, no tools');
  db.prepare("INSERT INTO roles (id, name, builtin, permissions) VALUES ('plain', 'Plain', 0, '[\"data.use\"]')").run(); // in no team collection's access list
  const nobody = await person('nobody@x.test', 'plain', ['data.use']);
  assert.deepEqual(Object.keys(tools(nobody.id)), [], 'no collections, no tools');
  const a = alice as any;
  const projects = D.createCollection(a, { name: 'Agent projects', fields: [f('name', 'text', { required: true })] });
  const time = D.createCollection(a, { name: 'Agent time', description: 'Booked hours', fields: [f('date', 'date', { default: '@today' }), f('project', 'relation', { collection: projects.id }), f('minutes', 'duration'), f('note', 'text')] });
  const p = D.createRecord(a, projects, { name: 'Website relaunch' });
  const t = tools(a.id);
  assert.deepEqual(Object.keys(t), ['data_collections', 'data_query', 'data_create', 'data_update']);
  assert.ok(!Object.keys(t).some((k) => /delete/.test(k)));
  assert.match(t.data_query.description, /@today/); assert.match(t.data_query.description, /project\.name/);
  const list = await run(t.data_collections, {});
  assert.match(list.today, /^\d{4}-\d{2}-\d{2}$/);
  const lt = list.collections.find((c: any) => c.slug === 'agent-time');
  assert.equal(lt.records, 0); assert.equal(lt.canEdit, true); assert.deepEqual(lt.fields.find((x: any) => x.name === 'project'), { name: 'project', type: 'relation', relatesTo: 'agent-projects' });
  const made = await run(t.data_create, { collection: 'agent-time', values: { project: p.id, minutes: 120, note: 'kickoff' } });
  assert.equal(made.minutes, 120); assert.equal(made.date, list.today); assert.deepEqual(made.project, { id: p.id, label: 'Website relaunch' });
  assert.match(await run(t.data_create, { collection: 'Agent time', values: { minutes: -5 } }), /^Error: .*minutes/);
  assert.match(await run(t.data_create, { collection: 'agent-time', values: { project: 'ghost' } }), /^Error: .*does not exist/);
  assert.match(await run(t.data_query, { collection: 'nope' }), /^Error: No collection/);
  assert.match(await run(t.data_query, { collection: 'agent-time', filter: 'minutes >> 1' }), /^Error: filter/);
  const q = await run(t.data_query, { collection: 'agent-time', filter: 'project.name ~ "relaunch" && date >= @weekStart && date <= @weekEnd', sort: '-minutes' });
  assert.equal(q.total, 1); assert.equal(q.records[0].id, made.id); assert.equal(q.records[0].project.label, 'Website relaunch');
  const up = await run(t.data_update, { collection: 'agent-time', id: made.id, values: { minutes: 150, note: null } });
  assert.deepEqual([up.minutes, up.note], [150, null]);
  assert.match(await run(t.data_update, { collection: 'agent-time', id: 'ghost', values: {} }), /^Error: No such record/);
  // other users see none of it; a team collection follows its access
  const bt = tools(bob.id);
  assert.match(await run(bt.data_query, { collection: 'agent-time' }), /^Error: No collection/);
  const team = D.createCollection(admin as any, { name: 'Agent team', scope: 'team', fields: [f('n', 'text')], access: { view: ['worker'] } });
  D.createRecord(admin as any, team, { n: 'shared' });
  const bt2 = tools(bob.id);
  assert.equal((await run(bt2.data_query, { collection: 'agent-team' })).total, 1);
  assert.match(await run(bt2.data_create, { collection: 'agent-team', values: { n: 'x' } }), /^Error: You can view this collection but not change it/);
  assert.equal((await run(bt2.data_collections, {})).collections.find((c: any) => c.slug === 'agent-team').canEdit, false);
  // a locked key answers with a message the model can pass on
  const key = vault.userKey(a.id)!; vault.forgetUserKey(a.id);
  assert.match(await t.data_query.run({ data: { collection: 'agent-time' } }), /^Error: .*locked/);
  vault.rememberUserKey(a.id, key);
});
