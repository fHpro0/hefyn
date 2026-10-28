import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from '../src/server/vault.ts';

test('seal/open: round trip, AAD binds the value to its place, tampering and wrong keys fail', () => {
  const k = v.newKey();
  const s = v.seal(k, 'Grüße an Anna', 'conv:1:title');
  assert.ok(v.isSealed(s) && !s.includes('Anna'));
  assert.equal(v.open(k, s, 'conv:1:title').toString('utf8'), 'Grüße an Anna');
  assert.notEqual(v.seal(k, 'x', 'a'), v.seal(k, 'x', 'a')); // fresh IV each time
  assert.throws(() => v.open(k, s, 'conv:2:title'));
  assert.throws(() => v.open(v.newKey(), s, 'conv:1:title'));
  const raw = Buffer.from(s.slice(4), 'base64'); raw[raw.length - 1] ^= 1;
  assert.throws(() => v.open(k, 'hx1:' + raw.toString('base64'), 'conv:1:title'));
  assert.throws(() => v.seal(Buffer.alloc(16), 'x', 'a'));
});

test('wrap/unwrap with a password and a recovery key', async () => {
  const dek = v.newKey(), salt = v.newSalt();
  const w = v.wrap(await v.kdf('correct horse', salt), dek, 'user:u1:pw');
  assert.ok(v.unwrap(await v.kdf('correct horse', salt), w, 'user:u1:pw').equals(dek));
  const wrong = await v.kdf('wrong horse', salt);
  assert.throws(() => v.unwrap(wrong, w, 'user:u1:pw'));
  assert.throws(() => v.unwrap(dek, w, 'user:u2:pw'));

  const rk = v.newRecoveryKey();
  assert.match(rk, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  const rs = v.newSalt();
  const wr = v.wrap(await v.kdf(rk, rs), dek, 'user:u1:recovery');
  const typed = rk.toLowerCase().replace(/-/g, ' ');
  assert.ok(v.unwrap(await v.kdf(v.normalizeRecoveryKey(typed), rs), wr, 'user:u1:recovery').equals(dek));
});

test('key cache: locked until remembered, expiry, forget; legacy plaintext passes through', async () => {
  assert.throws(() => v.sealForUser('u1', 'x', 'a'), (e: any) => e instanceof v.LockedError && e.scope === 'user');
  assert.equal(v.openForUser('u1', 'plain from before encryption', 'a'), 'plain from before encryption');
  const k = v.newKey();
  v.rememberUserKey('u1', k);
  const s = v.sealForUser('u1', 'secret', 'a');
  assert.equal(v.openForUser('u1', s, 'a'), 'secret');
  v.forgetUserKey('u1');
  assert.throws(() => v.openForUser('u1', s, 'a'), v.LockedError);
  v.rememberUserKey('u2', v.newKey(), -1);
  assert.equal(v.userKey('u2'), undefined);
  assert.throws(() => v.sealForTeam('x', 'a'), (e: any) => e.scope === 'team');
  v.setTeamKey(v.newKey());
  assert.equal(v.openForTeam(v.sealForTeam('tok', 'p:1'), 'p:1'), 'tok');
  v.setTeamKey(undefined);
});

test('hardening: all-zero keys refused, held buffers survive forget, TTL never shortened, strict mode refuses unsealed values', () => {
  assert.throws(() => v.seal(Buffer.alloc(32), 'x', 'a'), /all-zero/);
  const k = v.newKey(), held = Buffer.from(k);
  v.rememberUserKey('u3', k);
  v.forgetUserKey('u3');
  assert.ok(k.equals(held)); // a caller mid-await still has a usable key
  v.rememberUserKey('u4', k, 60_000);
  v.rememberUserKey('u4', k, 1); // the agent's short TTL must not cut the web's longer one
  assert.ok(v.userKey('u4'));
  v.rememberUserKey('u4', k, 60_000);
  const s = v.sealForUser('u4', 'ok', 'a');
  v.markStrictUser('u4');
  assert.equal(v.openForUser('u4', s, 'a'), 'ok');
  assert.throws(() => v.openForUser('u4', 'planted plaintext', 'a'), v.DowngradeError);
  assert.equal(v.openForUser('u5', 'legacy', 'a'), 'legacy'); // not migrated yet: still readable
  v.markStrictTeam();
  assert.throws(() => v.openForTeam('planted', 'p:1'), v.DowngradeError);
});
