import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-contract-'));
process.env.HEFYN_SECRET = 'contract-test-secret-contract-test-12';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const { modules } = await import('../src/modules/registry.ts');
const { active, setActive } = await import('../src/modules/active.ts');
const app = new Hono().route('/api', api);

test('every built-in module\'s sealed columns exist after migrate', () => {
  let checked = 0;
  for (const m of modules()) {
    for (const s of [...(m.sealed?.user?.('u1') ?? []), ...(m.sealed?.team?.() ?? [])]) {
      const have = new Set((db.prepare(`PRAGMA table_info(${s.table})`).all() as { name: string }[]).map((c) => c.name));
      assert.ok(have.size, `${m.id}: table ${s.table} does not exist`);
      for (const c of [...Object.keys(s.cols), ...s.where]) assert.ok(have.has(c), `${m.id}: ${s.table}.${c} does not exist`);
      db.prepare(s.sql).all(...(s.args as any[])); // the selection itself is valid SQL over those columns
      checked++;
    }
  }
  assert.ok(checked >= 1, 'folders declares a sealed table');
});

test('modules that touch conversations migrate their own columns', () => {
  const cols = new Set((db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).map((c) => c.name));
  for (const c of ['folder_id', 'position']) assert.ok(cols.has(c), c);
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
}
test('no core file imports from src/modules/projects, folders or schedules (static scan)', () => {
  const root = join(import.meta.dirname, '..');
  // The registries' own assembly (server builtin.ts / light.ts, console registry.ts), the route table (entry.tsx) and the tRPC router table (router.ts: a built-in module's router is imported statically to keep the client's types) are the places that list the modules.
  const allowed = new Set(['src/modules/builtin.ts', 'src/modules/light.ts', 'web/src/modules/registry.ts', 'web/src/entry.tsx', 'src/server/router.ts']);
  const own = /^(src\/modules\/(projects|folders|schedules)\/|web\/src\/modules\/(projects|folders|schedules)\/)/;
  const hits: string[] = [];
  for (const f of [...walk(join(root, 'src')), ...walk(join(root, 'web/src'))]) {
    const rel = relative(root, f);
    if (own.test(rel) || allowed.has(rel)) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]*\/(?:projects|folders|schedules)(?:\/[^'"]*)?)['"]/g)) hits.push(`${rel} -> ${m[1]}`);
  }
  assert.deepEqual(hits, []);
});

test('a module\'s onConversationDelete hook is called on chat delete and bulk delete', async () => {
  const calls: string[] = [];
  setActive([...active(), { id: 'spy', name: 'Spy', onConversationDelete: (id, u) => void calls.push(`del ${id} ${u}`) }]);
  const r = await auth.api.signUpEmail({ body: { name: 'Zed', email: 'zed@x.test', password: 'password-12345' } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, 'admin');
  const cookie = (await auth.api.signInEmail({ body: { email: 'zed@x.test', password: 'password-12345' }, returnHeaders: true })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const trpc = (proc: string, input?: unknown) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, true);
  const a = (await trpc('conversations.create', { title: 'a' })).json.id, b = (await trpc('conversations.create', { title: 'b' })).json.id;
  assert.equal((await trpc('conversations.delete', { id: a })).status, 200);
  assert.deepEqual(calls, [`del ${a} ${r.user.id}`]);
  assert.equal((await trpc('conversations.bulk', { ids: [b], action: 'delete' })).status, 200);
  assert.deepEqual(calls, [`del ${a} ${r.user.id}`, `del ${b} ${r.user.id}`]);
});
