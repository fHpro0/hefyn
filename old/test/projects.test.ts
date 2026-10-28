import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-projects-'));
process.env.HEFYN_SECRET = 'projects-test-secret-projects-test-123';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const { projectInstructions } = await import('../src/modules/projects/projects.ts');
const { openForTeam, openForUser } = await import('../src/server/vault.ts');
const app = new Hono().route('/api', api);

const PW = 'password-12345';
const cookieOf = (h: Headers) => h.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function mk(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email.split('@')[0]!, email, password: PW } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = cookieOf((await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true })).headers);
  return { id: r.user.id, trpc: (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate), call: async (path: string, method = 'GET', body?: unknown) => { const res = await app.request(`/api${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, json: (await res.json().catch(() => ({}))) as any }; } };
}
const admin = await mk('admin@x.test', 'admin'); // first admin: creates the team key
const ann = await mk('ann@x.test', 'worker');
const bob = await mk('bob@x.test', 'worker');
const cat = await mk('cat@x.test', 'worker');
db.prepare("INSERT INTO roles (id, name, builtin, permissions) VALUES ('plain', 'Plain', 0, ?)").run(JSON.stringify(['models.use']));
const dan = await mk('dan@x.test', 'plain');
const row = (id: string) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
const chat = async (u: typeof ann, projectId?: string) => (await u.trpc('conversations.create', { title: 'c', projectId }, true)).json.id as string;
const FIELDS = [{ id: 'f1', label: 'Kunde', type: 'text', value: 'ACME GmbH' }, { id: 'f2', label: 'Budget', type: 'number', value: '12000' }];
const TEAM = { everyone: true, roleIds: [], userIds: [], access: { '*': 'viewer' } };

test('a role without projects.share can not make a project team-visible; the Worker default has it', async () => {
  assert.equal((await dan.call('/projects', 'POST', { title: 'T', scope: 'team', sharing: TEAM })).status, 403);
  const own = (await dan.call('/projects', 'POST', { title: 'Mine' })).json;
  assert.equal((await dan.call(`/projects/${own.id}`, 'PATCH', { scope: 'team', sharing: TEAM })).status, 403);
  assert.equal((await ann.call('/projects', 'POST', { title: 'Shared', scope: 'team', sharing: TEAM })).status, 200);
});

test('scope switch re-seals: private = owner key, team = team key, no plaintext either way', async () => {
  const p = (await ann.call('/projects', 'POST', { title: 'Mandant Müller', description: 'Geheime Beschreibung', instructions: 'Aktenzeichen KX-4711', fields: FIELDS })).json;
  assert.deepEqual([p.scope, p.access, p.title, p.fields[1].value], ['private', 'owner', 'Mandant Müller', 12000]);
  const plain = ['Müller', 'Geheime', 'KX-4711', 'ACME'];
  const clean = (r: any) => assert.ok(!plain.some((s) => JSON.stringify(r).includes(s)), 'plaintext at rest');
  clean(row(p.id));
  assert.equal(openForUser(ann.id, row(p.id).name, `proj:${p.id}:name`), 'Mandant Müller');
  assert.equal((await bob.call(`/projects/${p.id}`)).status, 404); // private: owner only

  const t = await ann.call(`/projects/${p.id}`, 'PATCH', { scope: 'team', sharing: TEAM });
  assert.equal(t.status, 200);
  clean(row(p.id));
  assert.equal(openForTeam(row(p.id).name, `proj:${p.id}:name`), 'Mandant Müller');
  assert.equal(openForTeam(row(p.id).description, `proj:${p.id}:description`), 'Geheime Beschreibung');
  assert.throws(() => openForUser(ann.id, row(p.id).name, `proj:${p.id}:name`)); // no longer the owner's key
  assert.equal((await bob.call(`/projects/${p.id}`)).json.title, 'Mandant Müller');

  assert.equal((await ann.call(`/projects/${p.id}`, 'PATCH', { scope: 'private' })).status, 200);
  clean(row(p.id));
  assert.equal(openForUser(ann.id, row(p.id).fields, `proj:${p.id}:fields`).includes('ACME'), true);
  assert.equal(row(p.id).sharing, null);
  assert.equal((await bob.call(`/projects/${p.id}`)).status, 404);
});

test('members: viewer sees and uses it, editor edits, non-members get 404, chats stay private per user', async () => {
  const INSTR = 'Immer duzen.';
  const sharing = { everyone: false, roleIds: [], userIds: [bob.id, cat.id], access: { [bob.id]: 'viewer', [cat.id]: 'editor' } };
  const p = (await ann.call('/projects', 'POST', { title: 'Team P', instructions: INSTR, scope: 'team', sharing })).json;
  assert.equal((await dan.call(`/projects/${p.id}`)).status, 404); // not a member
  assert.ok(!(await dan.call('/projects')).json.some((x: any) => x.id === p.id));
  const b = (await bob.call(`/projects/${p.id}`)).json;
  assert.deepEqual([b.access, b.canManage, b.owner.id, b.scope], ['viewer', false, ann.id, 'team']);
  assert.equal(b.instructions, INSTR);
  assert.equal((await bob.call(`/projects/${p.id}`, 'PATCH', { title: 'x' })).status, 403); // viewer
  assert.equal((await bob.call(`/projects/${p.id}`, 'PATCH', { sharing: TEAM })).status, 403);
  assert.equal((await bob.call(`/projects/${p.id}`, 'DELETE')).status, 403);
  assert.equal((await cat.call(`/projects/${p.id}`, 'PATCH', { description: 'edited by cat' })).json.description, 'edited by cat'); // editor
  assert.equal((await cat.call(`/projects/${p.id}`, 'PATCH', { sharing: TEAM })).status, 403); // editors do not change access
  assert.equal((await cat.call(`/projects/${p.id}`, 'PATCH', { scope: 'private' })).status, 403);

  // chats: each member starts their own, nobody sees the others'
  const [ca, cb] = [await chat(ann, p.id), await chat(bob, p.id)];
  assert.equal(projectInstructions(ca), INSTR);
  assert.equal(projectInstructions(cb), INSTR); // reaches every member's chat config
  assert.deepEqual(((await ann.trpc('conversations.list', { project: p.id })).json as any[]).map((r) => r.id), [ca]);
  assert.deepEqual(((await bob.trpc('conversations.list', { project: p.id })).json as any[]).map((r) => r.id), [cb]);
  assert.equal((await ann.call(`/projects/${p.id}`)).json.chatCount, 1);
  assert.equal((await cat.call(`/projects/${p.id}`)).json.chatCount, 0);
  assert.equal((await dan.trpc('conversations.create', { projectId: p.id }, true)).status, 403); // not a member: can not put a chat in it
  assert.equal((await ann.trpc('conversations.update', { id: cb, title: 'x' }, true)).status, 403);

  // losing access moves that person's chats out (nothing is deleted)
  await ann.call(`/projects/${p.id}`, 'PATCH', { sharing: { ...sharing, userIds: [cat.id] } });
  assert.equal((await bob.call(`/projects/${p.id}`)).status, 404);
  assert.equal(projectInstructions(cb), undefined);
  assert.equal(((await bob.trpc('conversations.list')).json as any[]).find((r) => r.id === cb).projectId, null);
});

test('roles and everyone as members; projects.manage_team can re-share and delete any team project', async () => {
  const p = (await ann.call('/projects', 'POST', { title: 'Roles', scope: 'team', sharing: { everyone: false, roleIds: ['worker'], userIds: [], access: { worker: 'editor' } } })).json;
  assert.equal((await bob.call(`/projects/${p.id}`)).json.access, 'editor'); // via the Worker role
  assert.equal((await dan.call(`/projects/${p.id}`)).status, 404); // other role
  assert.deepEqual(p.members.roles.map((r: any) => [r.id, r.access]), [['worker', 'editor']]);
  const a = await admin.call(`/projects/${p.id}`, 'PATCH', { sharing: { everyone: true, roleIds: [], userIds: [], access: {} } });
  assert.equal(a.status, 200);
  assert.equal((await dan.call(`/projects/${p.id}`)).json.access, 'viewer'); // everyone, default viewer
  assert.equal((await admin.call(`/projects/${p.id}`, 'PATCH', { scope: 'private' })).status, 403); // only the owner flips scope
  const cb = await chat(bob, p.id);
  assert.equal((await admin.call(`/projects/${p.id}`, 'DELETE')).status, 204);
  assert.equal((await ann.call(`/projects/${p.id}`)).status, 404);
  assert.equal(((await bob.trpc('conversations.list')).json as any[]).find((r) => r.id === cb).projectId, null); // bob's chat survives

  const q = (await ann.call('/projects', 'POST', { title: 'Own', scope: 'team', sharing: TEAM })).json;
  assert.equal((await bob.call(`/projects/${q.id}`, 'DELETE')).status, 403);
  assert.equal((await ann.call(`/projects/${q.id}`, 'DELETE')).status, 204);
  const dir = (await ann.call('/projects/directory')).json;
  assert.ok(dir.users.some((u: any) => u.id === bob.id && u.email) && dir.roles.some((r: any) => r.id === 'worker'));
  assert.ok((await dan.call('/projects/directory')).json.users.every((u: any) => !('email' in u))); // no projects.share: names only
});

test('validation: fields, sharing, color, limits', async () => {
  const post = (b: object) => ann.call('/projects', 'POST', { title: 'V', ...b });
  const f = (x: object) => [{ id: 'a', label: 'L', type: 'text', value: '', ...x }];
  assert.equal((await post({ fields: f({}) })).status, 200);
  assert.equal((await post({ fields: f({ type: 'nope' }) })).status, 400);
  assert.equal((await post({ fields: f({ label: '' }) })).status, 400);
  assert.equal((await post({ fields: [...f({}), ...f({})] })).status, 400); // duplicate id
  assert.equal((await post({ fields: f({ type: 'number', value: 'abc' }) })).status, 400);
  assert.equal((await post({ fields: f({ type: 'date', value: '2026-13-40' }) })).status, 400);
  assert.equal((await post({ fields: f({ type: 'date', value: '2026-10-22' }) })).status, 200);
  assert.equal((await post({ fields: f({ type: 'url', value: 'javascript:alert(1)' }) })).status, 400);
  assert.equal((await post({ fields: f({ type: 'url', value: 'https://x.test/a' }) })).status, 200);
  assert.equal((await post({ fields: f({ type: 'email', value: 'nope' }) })).status, 400);
  assert.equal((await post({ fields: f({ type: 'select', options: ['a', 'b'], value: 'c' }) })).status, 400);
  assert.equal((await post({ fields: f({ type: 'select', options: ['a', 'b'], value: 'b' }) })).status, 200);
  assert.equal((await post({ fields: f({ type: 'select', value: '' }) })).status, 400); // select needs options
  assert.equal((await post({ fields: f({ type: 'user', value: 'ghost' }) })).status, 400);
  assert.equal((await post({ fields: f({ type: 'user', value: bob.id }) })).status, 200);
  assert.equal((await post({ fields: f({ type: 'longtext', value: 'x'.repeat(2001) }) })).status, 400);
  assert.equal((await post({ fields: Array.from({ length: 31 }, (_, i) => ({ id: `f${i}`, label: 'x', type: 'text', value: '' })) })).status, 400);
  assert.equal((await post({ description: 'x'.repeat(501) })).status, 400);
  assert.equal((await post({ color: 'red' })).status, 400);
  assert.equal((await post({ scope: 'public' })).status, 400);
  assert.equal((await post({ scope: 'team', sharing: { roleIds: ['ghost'] } })).status, 400);
  assert.equal((await post({ scope: 'team', sharing: { userIds: [bob.id], access: { [bob.id]: 'owner' } } })).status, 400);
  assert.equal((await ann.call('/projects', 'POST', { title: '' })).status, 400);
});
