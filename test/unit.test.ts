import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-unit-'));

test('key encryption round-trips and rejects a wrong secret', async () => {
  const { decrypt, encrypt } = await import('../src/server/crypto.ts');
  const blob = encrypt('sk-test-123', 'secret-a');
  assert.ok(!blob.includes('sk-test'));
  assert.equal(decrypt(blob, 'secret-a'), 'sk-test-123');
  assert.throws(() => decrypt(blob, 'secret-b'));
  assert.notEqual(encrypt('x', 'secret-a'), encrypt('x', 'secret-a')); // random IV
});

test('usage aggregation: per day / model / user, scoped by user, 30-day window', async () => {
  await import('../src/server/auth.ts'); // creates the Better Auth tables the per-user join needs
  const { db } = await import('../src/server/appdb.ts');
  const { usageSummary, userOfConversation } = await import('../src/server/usage.ts');
  const ins = db.prepare('INSERT INTO usage (user_id, conversation_id, provider, model, input, output, cache_read, cache_write, cost, ts) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 40 * 864e5).toISOString();
  ins.run('uA', 'u_uA_01', 'anthropic', 'm1', 10, 5, 0, 0, 0.5, now);
  ins.run('uA', 'u_uA_01', 'anthropic', 'm2', 20, 5, 0, 0, 0.25, now);
  ins.run('uB', 'u_uB_01', 'anthropic', 'm1', 1, 1, 0, 0, 1, now);
  ins.run('uB', 'u_uB_01', 'anthropic', 'm1', 99, 99, 0, 0, 99, old);
  const all = usageSummary() as any;
  assert.equal(all.perDay.length, 1);
  assert.equal(all.perDay[0].calls, 3);
  assert.equal(all.perModel.find((r: any) => r.key === 'anthropic/m1').cost, 1.5);
  assert.deepEqual(all.perUser.map((r: any) => [r.key, r.cost]), [['uB', 1], ['uA', 0.75]]);
  const a = usageSummary('uA') as any;
  assert.equal(a.perDay[0].calls, 2);
  assert.equal(userOfConversation('u_abc123_01HZX0'), 'abc123');
  assert.equal(userOfConversation('someone-else'), undefined);
});
