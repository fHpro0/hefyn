import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Regression: "database is locked" (SQLITE_BUSY_SNAPSHOT, 517) when web (Better Auth creating the first admin) and the agent
// wrote app.db at the same time. Several processes hammer one app.db: agent-style state writes, usage inserts, user creation.
test('concurrent writers in separate processes never hit a lock error (agent state + usage + Better Auth sign-ups)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hefyn-contention-'));
  const child = (role: string, seconds: number) => new Promise<{ role: string; ok: number; errors: string[]; errorCount: number }>((ok, fail) =>
    execFile('node', ['test/contention-child.ts', role, dir, String(seconds)], { timeout: 60000 }, (e, out, err) => (e ? fail(new Error(`${role}: ${e.message}\n${err}`)) : ok(JSON.parse(out.trim().split('\n').at(-1)!)))));
  execFileSync('node', ['test/contention-child.ts', 'warmup', dir, '0'], { env: { ...process.env, HEFYN_DATA_DIR: dir } }); // creates the schema (web does this once at boot)
  // the first Better Auth import creates its tables; do it once before the race
  execFileSync('node', ['test/contention-child.ts', 'users', dir, '0']);
  const results = await Promise.all([child('agent', 6), child('agent', 6), child('usage', 6), child('users', 6), child('users', 6)]);
  for (const r of results) assert.equal(r.errorCount, 0, `${r.role}: ${JSON.stringify(r.errors)}`);
  assert.ok(results.filter((r) => r.role === 'users').every((r) => r.ok >= 1), 'users were created under load');
  assert.ok(results.every((r) => r.ok > 0));
});
