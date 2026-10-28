import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { verifyPassword } from 'better-auth/crypto';
import { hkdfSync } from 'node:crypto';
import { ADMIN_ROLE, db } from './appdb.ts';
import { SECRET, decrypt } from './crypto.ts';
import { purgeUserFlueData } from './legacy-flue.ts';
import { chanAad } from './channels.ts';
import { providerAad } from './seal.ts';
import { AGENT_URL, INTERNAL_TOKEN } from './runtime.ts';
import { active, forgetInAll } from '../modules/active.ts';
import type { SealedSpec as Spec } from '../modules/types.ts';
import { UNLOCK_COOKIE, clearedCookieAttrs, createUnlockWrap, dropAllUnlockState, dropPasskeyWrap, dropUnlockWraps, openPasskeyWrap, openUnlockWrap, unlockCookieAttrs } from './unlock-wraps.ts';
import { forgetUserKey, getTeamKey, isSealed, kdf, markStrictTeam, markStrictUser, newKey, newRecoveryKey, newSalt, normalizeRecoveryKey, rememberUserKey, seal, setTeamKey, unwrap, userKey, wrap } from './vault.ts';

// Key lifecycle (docs/ENCRYPTION.md). Each user has a random data key (DEK) stored twice, wrapped by their password and by a recovery key;
// the team key is wrapped by every admin's DEK (+ an instance recovery key). Plaintext keys live in process memory only (vault.ts).

interface KeyRow { user_id: string; pw_salt: string; pw_wrapped: string | null; rec_salt: string; rec_wrapped: string; state: 'ok' | 'needs_recovery' }
const now = () => new Date().toISOString();
const b64 = (b: Buffer) => b.toString('base64');
const rowOf = (id: string) => db.prepare('SELECT * FROM user_keys WHERE user_id = ?').get(id) as KeyRow | undefined;
const pwAad = (id: string) => `user:${id}:pw`;
const recAad = (id: string) => `user:${id}:recovery`;
const teamAad = (id: string) => `team:${id}`;
const TEAM_RECOVERY = 'team_key_recovery';

const tx = <T>(f: () => T): T => {
  db.exec('BEGIN IMMEDIATE');
  try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};
export const isAdmin = (id: string) => (db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').get(id) as { role_id: string } | undefined)?.role_id === ADMIN_ROLE;

// One-shot values for the UI: shown once through key-status, then gone.
const TOSHOW_MS = 30 * 60_000;
const toShow = new Map<string, { key: string; at: number }>();
const show = (id: string, key: string) => { if (!SERVER_MODE) toShow.set(id, { key, at: Date.now() }); }; // server mode: no recovery keys are shown

// ---------- server-held keys (HEFYN_KEY_MODE=server, docs/ENCRYPTION.md "Key modes") ----------
// Every data key and the team key are also wrapped by a key derived from HEFYN_SECRET, so nothing is ever locked and keys survive restarts.
// Default since 2026-10-27: server-held keys. The unlock UI (password, recovery key, passkey unlock) moved to old/, so "user" mode would lock people out; it stays only as an explicit opt-in for the server-side tests.
export const KEY_MODE = process.env.HEFYN_KEY_MODE || 'server';
export const SERVER_MODE = KEY_MODE === 'server';
const serverKek = () => Buffer.from(hkdfSync('sha256', SECRET, Buffer.alloc(0), 'hefyn-server-keys-v1', 32));
const serverAad = (id: string) => `user:${id}:server`;
const TEAM_SERVER = 'team_key_server';
const saveServerWrap = (id: string, dek: Buffer) =>
  void db.prepare('INSERT OR REPLACE INTO server_key_wraps (user_id, wrapped, created_at) VALUES (?,?,?)').run(id, wrap(serverKek(), dek, serverAad(id)), now());
const serverWrapRow = (id: string) => db.prepare('SELECT wrapped FROM server_key_wraps WHERE user_id = ?').get(id) as { wrapped: string } | undefined;
/** The user's data key from the server wrap; undefined when there is none or HEFYN_SECRET changed since. */
const serverDek = (id: string): Buffer | undefined => {
  const w = SERVER_MODE && serverWrapRow(id);
  if (!w) return;
  try { return unwrap(serverKek(), w.wrapped, serverAad(id)); } catch { return; }
};
let teamToShow: { userId: string; key: string; at: number } | undefined;
const take = (id: string) => { const v = toShow.get(id); toShow.delete(id); return v && Date.now() - v.at < TOSHOW_MS ? v.key : undefined; };

// ---------- user key ----------

/** Password the account was just verified with -> the DEK, creating the key set on first use. undefined = cannot unlock with the password alone. */
export const adminSetPassword = (id: string) => !!db.prepare('SELECT 1 FROM password_set_by_admin WHERE user_id = ?').get(id);

export async function deriveKey(userId: string, password: string): Promise<Buffer | undefined> {
  const held = serverDek(userId);
  if (held) { // the password only refreshes its own wrap (so a later switch to user mode works); never one an admin knows
    if (!adminSetPassword(userId) && rowOf(userId)) await setPasswordWrap(userId, held, password);
    return held;
  }
  if (adminSetPassword(userId)) return undefined; // an admin knows this password: it must never wrap a data key
  let row = rowOf(userId);
  if (!row) return createKeys(userId, password);
  // Also tried in state needs_recovery: the wrap is kept, so the right password restores 'ok' (one failed attempt destroys nothing).
  for (let attempt = 0; attempt < 2 && row?.pw_wrapped; attempt++) {
    try {
      const dek = unwrap(await kdf(password, Buffer.from(row.pw_salt, 'base64')), row.pw_wrapped, pwAad(userId));
      if (row.state !== 'ok') db.prepare("UPDATE user_keys SET state = 'ok', updated_at = ? WHERE user_id = ?").run(now(), userId);
      return dek;
    } catch {
      const again = rowOf(userId); // a password change may have re-wrapped it while we derived
      if (again?.pw_wrapped === row.pw_wrapped) break;
      row = again;
    }
  }
  // The password is right (verified by Better Auth) but does not open the key: changed by a path we did not see. Recovery key needed.
  if (row?.state === 'ok') needRecovery(userId);
  return undefined;
}

async function createKeys(userId: string, password: string, replace = false): Promise<Buffer | undefined> {
  const dek = newKey(), recovery = newRecoveryKey(), ps = newSalt(), rs = newSalt();
  const [pk, rk] = await Promise.all([kdf(password, ps), SERVER_MODE ? undefined : kdf(recovery, rs)]);
  const t = now();
  const r = db.prepare(`INSERT OR ${replace ? 'REPLACE' : 'IGNORE'} INTO user_keys (user_id, pw_salt, pw_wrapped, rec_salt, rec_wrapped, state, created_at, updated_at) VALUES (?,?,?,?,?,'ok',?,?)`)
    .run(userId, b64(ps), wrap(pk, dek, pwAad(userId)), rk ? b64(rs) : '', rk ? wrap(rk, dek, recAad(userId)) : '', t, t); // server mode: no recovery wrap (nobody would hold its key)
  if (!r.changes) return deriveKey(userId, password); // a parallel sign-in created it first
  show(userId, recovery);
  return dek;
}

/** A password reset (or an unreadable key): lock until the recovery key is used. The password wrap is kept, so a later right password can restore 'ok'. */
export function needRecovery(userId: string) {
  db.prepare("UPDATE user_keys SET state = 'needs_recovery', updated_at = ? WHERE user_id = ?").run(now(), userId);
  forgetUserKey(userId);
  dropAllUnlockState(userId); // restart and passkey wraps would otherwise keep opening the key we just locked
  agentForget(userId);
}

/** Recovery key + the account's current (verified) password -> DEK, and the key set is re-wrapped with that password. */
export async function recoverKey(userId: string, password: string, recoveryKey: string): Promise<Buffer | undefined> {
  const row = rowOf(userId);
  if (!row) return undefined;
  let dek: Buffer;
  try { dek = unwrap(await kdf(normalizeRecoveryKey(recoveryKey), Buffer.from(row.rec_salt, 'base64')), row.rec_wrapped, recAad(userId)); } catch { return undefined; }
  await setPasswordWrap(userId, dek, password);
  return dek;
}

async function setPasswordWrap(userId: string, dek: Buffer, password: string) {
  const salt = newSalt();
  db.prepare("UPDATE user_keys SET pw_salt = ?, pw_wrapped = ?, state = 'ok', updated_at = ? WHERE user_id = ?").run(b64(salt), wrap(await kdf(password, salt), dek, pwAad(userId)), now(), userId);
}

/** Unlocked: remember the key, move legacy values under it, then refuse unsealed values from now on (strict), and (admins) open the team key. Never throws into a sign-in. */
export async function finishUnlock(userId: string, dek: Buffer) {
  rememberUserKey(userId, dek);
  try {
    if (SERVER_MODE) saveServerWrap(userId, dek);
    const skipped = migrateUser(userId, dek);
    // Strict only once nothing legacy is left: from then on an unsealed value can only be a DB-write downgrade.
    if (!skipped) db.prepare('UPDATE user_keys SET strict = 1 WHERE user_id = ?').run(userId);
    await adminUnlocked(userId, dek);
  } catch (e) { console.error('[hefyn] unlock follow-up failed:', (e as Error).message); }
  if ((db.prepare('SELECT strict FROM user_keys WHERE user_id = ?').get(userId) as { strict: number } | undefined)?.strict) markStrictUser(userId);
}

// ---------- restart wrap + passkey unlock (unlock-wraps.ts) ----------

const restoring = new Map<string, Promise<boolean>>();
/** An authenticated request finds the user's key missing from memory (restart): reopen it from this session's wrap and cookie, through the
 *  same finishUnlock as a sign-in. Resolves true when the cookie is useless and should be cleared. A failure leaves the user simply locked. */
export function restoreUnlock(userId: string, sessionToken: string, cookie: string | undefined): Promise<boolean> {
  const k = `${userId}:${sessionToken}`;
  let p = restoring.get(k);
  if (!p) {
    p = (async () => {
      const held = serverDek(userId); // server mode: the 12 h in-memory expiry (or a sign-out) never leaves the user locked
      if (held) { await finishUnlock(userId, held); return false; }
      const r = openUnlockWrap(userId, sessionToken, cookie);
      if (r.dek) await finishUnlock(userId, r.dek);
      return !!r.clear;
    })().finally(() => restoring.delete(k));
    restoring.set(k, p);
  }
  return p;
}

/** The PRF output of a passkey the user enrolled -> unlocked (and the key is returned so the caller can create the session's restart wrap). */
export async function unlockWithPasskey(userId: string, credentialId: string, prf: Buffer): Promise<Buffer | undefined> {
  if (adminSetPassword(userId) || keyState(userId).state !== 'ok') return;
  const dek = openPasskeyWrap(userId, credentialId, prf);
  if (dek) await finishUnlock(userId, dek);
  return dek;
}

/** Cookie setter shared by the Better Auth hooks (ctx.setCookie) and the Hono routes. */
export const rememberAcrossRestart = (set: (name: string, value: string, attrs: typeof unlockCookieAttrs) => unknown, userId: string, sessionToken: string, dek: Buffer) =>
  void set(UNLOCK_COOKIE, createUnlockWrap(userId, sessionToken, dek), unlockCookieAttrs);

export async function rotateRecoveryKey(userId: string, dek: Buffer): Promise<string> {
  const recovery = newRecoveryKey(), salt = newSalt();
  db.prepare('UPDATE user_keys SET rec_salt = ?, rec_wrapped = ?, updated_at = ? WHERE user_id = ?').run(b64(salt), wrap(await kdf(recovery, salt), dek, recAad(userId)), now(), userId);
  return recovery;
}

/** "Start fresh": the old key is unrecoverable, so the data sealed with it goes. New key set; returns the new recovery key. */
export async function resetData(userId: string, password: string): Promise<string> {
  if (adminSetPassword(userId)) throw new Error('Choose your own password first.');
  const prefix = `u_${userId}_`;
  // The agent aborts the user's in-flight runs and drops its key first; if that fails nothing is purged (a running attempt could still write).
  const gone = await agentForget(userId);
  if (!gone) throw Object.assign(new Error('Could not reach the agent to stop your running tasks. Nothing was deleted; try again.'), { status: 502 });
  tx(() => {
    for (const t of ['cli_events']) db.prepare(`DELETE FROM ${t} WHERE substr(conversation_id, 1, ?) = ?`).run(prefix.length, prefix);
    // 'outbox' is legacy, no writer since outbox removal: existing sealed rows still go with the account
    db.prepare('DELETE FROM connection_state WHERE connection_id IN (SELECT id FROM connections WHERE user_id = ?)').run(userId); // the secrets of a connection are sealed with the key that is gone
    for (const t of ['conversations', 'outbox', 'user_credentials', 'mcp_tokens', 'connections']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
    forgetInAll((m) => m.onUserDelete?.(userId)); // the modules' rows (projects, folders, schedules…): sealed with the key that is gone — also of modules switched off now
    db.prepare("UPDATE mcp_connectors SET enc = NULL WHERE owner_id = ? AND visibility = 'private'").run(userId); // keep the definition, reconnect to sign in again
    db.prepare('DELETE FROM team_key_wraps WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM server_key_wraps WHERE user_id = ?').run(userId); // else restoreUnlock would resurrect the old key
  });
  forgetUserKey(userId);
  dropAllUnlockState(userId);
  await purgeUserFlueData(userId);
  const dek = (await createKeys(userId, password, true))!;
  const recovery = take(userId)!;
  await finishUnlock(userId, dek);
  return recovery;
}

export const takeRecoveryKey = take;
export function takeTeamRecoveryKey(userId: string) {
  const t = teamToShow;
  if (!t || t.userId !== userId) return undefined;
  teamToShow = undefined;
  return Date.now() - t.at < TOSHOW_MS ? t.key : undefined;
}

export function keyState(userId: string) {
  const r = rowOf(userId);
  const held = !!serverDek(userId);
  return { state: (held && r ? 'ok' : r?.state ?? 'none') as 'none' | 'ok' | 'needs_recovery', hasRecoveryKey: !SERVER_MODE && !!r?.rec_wrapped };
}

// ---------- password check (passkey users unlock with their password) ----------

export async function passwordOk(userId: string, password: string): Promise<boolean> {
  const a = db.prepare("SELECT password FROM account WHERE userId = ? AND providerId = 'credential'").get(userId) as { password: string | null } | undefined;
  return !!a?.password && verifyPassword({ hash: a.password, password }).catch(() => false);
}

// Unlock attempts are a password oracle: 8 per user per 10 minutes.
const tries = new Map<string, { n: number; at: number }>();
export function throttled(userId: string): boolean {
  const t = tries.get(userId);
  if (!t || Date.now() - t.at > 600_000) { tries.set(userId, { n: 1, at: Date.now() }); return false; }
  return ++t.n > 8;
}

// ---------- team key ----------

const wrapRow = (id: string) => db.prepare('SELECT wrapped FROM team_key_wraps WHERE user_id = ?').get(id) as { wrapped: string } | undefined;
const addWrap = (id: string, dek: Buffer, team: Buffer) =>
  void db.prepare('INSERT OR REPLACE INTO team_key_wraps (user_id, wrapped, created_at) VALUES (?,?,?)').run(id, wrap(dek, team, teamAad(id)), now());
export const dropTeamWrap = (id: string) => { db.prepare('DELETE FROM team_key_wraps WHERE user_id = ?').run(id); db.prepare('DELETE FROM team_key_grants WHERE user_id = ?').run(id); };
const teamExists = () => !!db.prepare('SELECT 1 FROM team_key_wraps').get() || !!db.prepare('SELECT 1 FROM instance_settings WHERE key IN (?, ?)').get(TEAM_RECOVERY, TEAM_SERVER);
const loadTeam = (key: Buffer) => {
  setTeamKey(key);
  if (SERVER_MODE) db.prepare('INSERT OR REPLACE INTO instance_settings (key, value) VALUES (?, ?)').run(TEAM_SERVER, wrap(serverKek(), key, 'team:server'));
  if (db.prepare("SELECT 1 FROM instance_settings WHERE key = 'team_strict'").get()) markStrictTeam();
};

// Admin unlocks run one at a time: two first admins must not both create a team key (the second would overwrite the first and lose its secrets).
let unlockChain: Promise<unknown> = Promise.resolve();
function adminUnlocked(userId: string, dek: Buffer): Promise<void> {
  const run = unlockChain.then(() => adminUnlockedNow(userId, dek));
  unlockChain = run.catch(() => {});
  return run;
}

/** An unlocked admin: open the team key from their wrap, take a granted wrap, or create the team key on a fresh/upgraded instance. */
async function adminUnlockedNow(userId: string, dek: Buffer) {
  if (!isAdmin(userId)) return;
  const w = wrapRow(userId);
  if (w) {
    try { if (!getTeamKey()) loadTeam(unwrap(dek, w.wrapped, teamAad(userId))); return; } catch { dropTeamWrap(userId); } // wrap of an older key: fall through
  }
  const loaded = getTeamKey();
  if (loaded) { // a new admin gets a wrap only after an unlocked admin confirmed it (grantTeamAccess); a role row alone is not enough
    if (SERVER_MODE || db.prepare('SELECT 1 FROM team_key_grants WHERE user_id = ?').get(userId)) { addWrap(userId, dek, loaded); db.prepare('DELETE FROM team_key_grants WHERE user_id = ?').run(userId); }
    return;
  }
  if (teamExists()) return; // stays locked: another admin signs in, or POST /api/security/team-unlock with the instance recovery key
  const team = newKey(), recovery = newRecoveryKey(), salt = newSalt();
  const recWrapped = SERVER_MODE ? '' : wrap(await kdf(recovery, salt), team, 'team:recovery'); // server mode: no team recovery key
  const created = tx(() => {
    if (teamExists() || getTeamKey()) return false; // lost a race: keep the existing team key
    addWrap(userId, dek, team);
    if (!SERVER_MODE) db.prepare('INSERT OR REPLACE INTO instance_settings (key, value) VALUES (?, ?)').run(TEAM_RECOVERY, JSON.stringify({ salt: b64(salt), wrapped: recWrapped }));
    if (!migrate(team, teamSpecs())) db.prepare("INSERT OR REPLACE INTO instance_settings (key, value) VALUES ('team_strict', '1')").run();
    return true;
  });
  if (!created) return;
  loadTeam(team);
  if (!SERVER_MODE) teamToShow = { userId, key: recovery, at: Date.now() };
}

/** Admins (by role) without a wrap, waiting for an unlocked admin to confirm them. */
export const pendingAdmins = () => SERVER_MODE ? [] : db.prepare(`SELECT u.id, u.email, u.name, EXISTS (SELECT 1 FROM team_key_grants g WHERE g.user_id = u.id) AS granted
  FROM user_roles ur JOIN user u ON u.id = ur.user_id WHERE ur.role_id = ? AND ur.user_id NOT IN (SELECT user_id FROM team_key_wraps) ORDER BY u.createdAt`).all(ADMIN_ROLE);

/** An unlocked admin confirms another admin: the wrap is added now if that admin is unlocked, else at their next unlock. */
export function grantTeamAccess(granterId: string, targetId: string): boolean {
  const team = getTeamKey();
  if (!team || !userKey(granterId) || !isAdmin(granterId) || granterId === targetId || !isAdmin(targetId) || wrapRow(targetId)) return false;
  db.prepare('INSERT OR REPLACE INTO team_key_grants (user_id, granted_by, created_at) VALUES (?,?,?)').run(targetId, granterId, now());
  const dek = userKey(targetId);
  if (dek) { addWrap(targetId, dek, team); db.prepare('DELETE FROM team_key_grants WHERE user_id = ?').run(targetId); }
  return true;
}

/** Admin without a working wrap: the instance recovery key opens the team key (and gives this admin a wrap). */
export async function teamUnlock(userId: string, recoveryKey: string): Promise<boolean> {
  const s = db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(TEAM_RECOVERY) as { value: string } | undefined;
  if (!s) return false;
  const { salt, wrapped } = JSON.parse(s.value) as { salt: string; wrapped: string };
  let team: Buffer;
  try { team = unwrap(await kdf(normalizeRecoveryKey(recoveryKey), Buffer.from(salt, 'base64')), wrapped, 'team:recovery'); } catch { return false; }
  loadTeam(team);
  const dek = userKey(userId);
  if (dek && isAdmin(userId)) addWrap(userId, dek, team);
  return true;
}

// ---------- migration: legacy plaintext / server-key values -> sealed ----------

/** Seals every legacy value; returns how many unreadable ones were left (strict mode must not be switched on while any remain). */
function migrate(key: Buffer, specs: Spec[]): number {
  let skipped = 0;
  for (const s of specs) {
    for (const r of db.prepare(s.sql).all(...(s.args as any[])) as any[]) {
      for (const [col, aad] of Object.entries(s.cols)) {
        const v = r[col];
        if (v == null || isSealed(v)) continue;
        let plain: string;
        try { plain = s.server ? decrypt(v) : v; } catch { skipped++; continue; } // unreadable legacy value: leave it
        db.prepare(`UPDATE ${s.table} SET ${col} = ? WHERE ${s.where.map((w) => `${w} = ?`).join(' AND ')}`).run(seal(key, plain, aad(r)), ...s.where.map((w) => r[w]));
      }
    }
  }
  return skipped;
}
// Routing fields are bound into the AAD (url / base_url): a DB writer who redirects a connector cannot make the server send its secrets elsewhere.
const userSpecs = (u: string): Spec[] => {
  const prefix = `u_${u}_`, own = 'substr(conversation_id, 1, ?) = ?';
  return [
    { sql: 'SELECT id, title FROM conversations WHERE user_id = ?', args: [u], table: 'conversations', where: ['id'], cols: { title: (r) => `conv:${r.id}:title` }, server: false },
    // legacy, no writer since outbox removal: existing sealed rows still rotate with the user key
    { sql: 'SELECT id, recipient, subject, body, error FROM outbox WHERE user_id = ?', args: [u], table: 'outbox', where: ['id'], server: false,
      cols: { recipient: (r) => `outbox:${r.id}:recipient`, subject: (r) => `outbox:${r.id}:subject`, body: (r) => `outbox:${r.id}:body`, error: (r) => `outbox:${r.id}:error` } },
    { sql: `SELECT conversation_id, seq, data FROM cli_events WHERE ${own}`, args: [prefix.length, prefix], table: 'cli_events', where: ['conversation_id', 'seq'], cols: { data: (r) => `cli:${r.conversation_id}:${r.seq}` }, server: false },
    { sql: 'SELECT user_id, provider, base_url, enc FROM user_credentials WHERE user_id = ?', args: [u], table: 'user_credentials', where: ['user_id', 'provider'], cols: { enc: (r) => `cred:${r.user_id}:${r.provider}:${r.base_url ?? ''}` }, server: true },
    { sql: 'SELECT t.connector_id, t.user_id, t.enc, c.url FROM mcp_tokens t JOIN mcp_connectors c ON c.id = t.connector_id WHERE t.user_id = ?', args: [u], table: 'mcp_tokens', where: ['connector_id', 'user_id'], cols: { enc: (r) => `mcptok:${r.connector_id}:${r.user_id}:${r.url}` }, server: true },
    { sql: "SELECT id, url, enc FROM mcp_connectors WHERE owner_id = ? AND visibility = 'private'", args: [u], table: 'mcp_connectors', where: ['id'], cols: { enc: (r) => `mcp:${r.id}:${r.url}` }, server: true },
    { sql: 'SELECT id, user_id, enc FROM connections WHERE user_id = ? AND enc IS NOT NULL', args: [u], table: 'connections', where: ['id'], cols: { enc: (r) => `conn:${r.id}:${r.user_id}` }, server: true },
    ...active().flatMap((m) => m.sealed?.user?.(u) ?? []), // the modules' own sealed columns (projects, schedules…)
  ];
};
const teamSpecs = (): Spec[] => [
  { sql: 'SELECT id, base_url, enc_key FROM providers', args: [], table: 'providers', where: ['id'], cols: { enc_key: (r) => providerAad(r.id, r.base_url) }, server: true },
  { sql: "SELECT id, url, enc FROM mcp_connectors WHERE visibility = 'team'", args: [], table: 'mcp_connectors', where: ['id'], cols: { enc: (r) => `mcp:${r.id}:${r.url}` }, server: true },
  { sql: 'SELECT id, kind, config, enc FROM channels', args: [], table: 'channels', where: ['id'], cols: { enc: (r) => chanAad(r.id, r.kind, JSON.parse(r.config)) }, server: true },
  ...active().flatMap((m) => m.sealed?.team?.() ?? []),
];
export const migrateUser = (userId: string, key: Buffer) => tx(() => migrate(key, userSpecs(userId)));

// ---------- agent process ----------

/** The agent keeps its own key cache (filled from request headers); drop the user's entry there. Best effort. */
export const agentForget = (userId: string): Promise<boolean> =>
  fetch(`${AGENT_URL}/internal/forget`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hefyn-internal': INTERNAL_TOKEN }, body: JSON.stringify({ userId }), signal: AbortSignal.timeout(10_000) }).then((r) => r.ok, () => false);

// ---------- Better Auth hooks ----------

// 2FA: the unwrapped key waits here and is only remembered once the second factor succeeded for that very user.
const pending = new Map<string, { key: Buffer; at: number }>();
const PENDING_MS = 5 * 60_000;
export const pendingUnlock = (userId: string) => pending.has(userId);

const TWO_FACTOR_DONE = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code', '/two-factor/verify-otp']);

export const vaultBefore = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== '/sign-out' && ctx.path !== '/passkey/delete-passkey') return;
  const s = await getSessionFromCtx(ctx).catch(() => null);
  if (!s) return;
  if (ctx.path === '/sign-out') { forgetUserKey(s.user.id); dropUnlockWraps(s.user.id); agentForget(s.user.id); } // locks every session of this user
  else { // the passkey's PRF wrap goes with it (ownership is checked here too; the endpoint checks it again)
    const row = db.prepare('SELECT credentialID FROM passkey WHERE id = ? AND userId = ?').get(String((ctx.body as any)?.id ?? ''), s.user.id) as { credentialID: string } | undefined;
    if (row) dropPasskeyWrap(s.user.id, row.credentialID);
  }
});

export const vaultAfter = createAuthMiddleware(async (ctx) => {
  const failed = (ctx.context.returned as unknown) instanceof Error;
  const s = ctx.context.newSession;
  // The restart wrap is only made once the key is really released (never for the 5-minute 2FA pending state).
  const stay = (userId: string, token: string, dek: Buffer) => rememberAcrossRestart(ctx.setCookie, userId, token, dek);
  try {
    if (ctx.path === '/sign-out') ctx.setCookie(UNLOCK_COOKIE, '', clearedCookieAttrs);
    else if (ctx.path === '/sign-in/email' && s && !failed) {
      const dek = await deriveKey(s.user.id, String((ctx.body as any)?.password ?? ''));
      if (!dek) return;
      // Runs before the two-factor plugin's hook (it clears newSession when a code is still due), so ask the user record.
      if ((s.user as any).twoFactorEnabled) {
        for (const [id, p] of pending) if (Date.now() - p.at > PENDING_MS) { p.key.fill(0); pending.delete(id); }
        pending.set(s.user.id, { key: dek, at: Date.now() });
      } else { await finishUnlock(s.user.id, dek); stay(s.user.id, s.session.token, dek); }
    } else if (TWO_FACTOR_DONE.has(ctx.path) && s && !failed) {
      const p = pending.get(s.user.id);
      pending.delete(s.user.id);
      if (p && Date.now() - p.at <= PENDING_MS) { await finishUnlock(s.user.id, p.key); stay(s.user.id, s.session.token, p.key); }
      else if (userKey(s.user.id)) stay(s.user.id, s.session.token, userKey(s.user.id)!); // enabling 2FA rotates the session: the new one needs its own wrap
    } else if ((ctx.path === '/two-factor/enable' || ctx.path === '/two-factor/disable') && s && !failed && userKey(s.user.id)) {
      stay(s.user.id, s.session.token, userKey(s.user.id)!); // session rotated; never reached for /sign-in/email, where newSession exists while 2FA is pending
    } else if (ctx.path === '/change-password' && !failed) {
      const sess = s ?? (await getSessionFromCtx(ctx).catch(() => null));
      const id = sess?.user.id;
      // Rotated session (revokeOtherSessions): every row goes and the new session gets a wrap below. Otherwise the current session keeps its row and cookie
      // (the data key itself is unchanged) and the others lose theirs.
      if (id) dropUnlockWraps(id, s ? undefined : sess?.session.token);
      const { currentPassword, newPassword } = (ctx.body ?? {}) as { currentPassword?: string; newPassword?: string };
      const row = id && rowOf(id);
      if (id && newPassword && adminSetPassword(id)) {
        // The user now chose their own password: only this one may wrap a data key.
        db.prepare('DELETE FROM password_set_by_admin WHERE user_id = ?').run(id);
        const dek = await deriveKey(id, newPassword);
        if (dek) await finishUnlock(id, dek);
      } else if (id && row && newPassword && serverDek(id)) {
        await setPasswordWrap(id, serverDek(id)!, newPassword); // server mode: the key comes from the server wrap, whatever state the old password wrap is in
      } else if (row && row.state === 'ok' && row.pw_wrapped && currentPassword && newPassword) {
        // Everything is computed first, then written in one statement: a failure leaves the old wrap (and the recovery wrap) intact.
        const dek = unwrap(await kdf(currentPassword, Buffer.from(row.pw_salt, 'base64')), row.pw_wrapped, pwAad(id));
        const salt = newSalt();
        const wrapped = wrap(await kdf(newPassword, salt), dek, pwAad(id));
        db.prepare('UPDATE user_keys SET pw_salt = ?, pw_wrapped = ?, updated_at = ? WHERE user_id = ?').run(b64(salt), wrapped, now(), id);
      }
      const open = id ? userKey(id) : undefined;
      if (id && s && open) stay(id, sess.session.token, open);
    }
  } catch (e) {
    console.error('[hefyn] key handling failed:', (e as Error).message);
  }
});

/** Password reset / invite: the old password is gone, so only the recovery key opens existing data. No row yet = nothing to protect. */
export const onPasswordReset = async ({ user }: { user: { id: string } }) => {
  db.prepare('DELETE FROM password_set_by_admin WHERE user_id = ?').run(user.id); // a reset password is the user's own choice
  if (!rowOf(user.id)) return;
  // Server mode: the server wrap still opens the data and the next sign-in re-wraps it; until then the stale password wrap is recorded.
  if (serverDek(user.id)) db.prepare("UPDATE user_keys SET state = 'needs_recovery', updated_at = ? WHERE user_id = ?").run(now(), user.id);
  else needRecovery(user.id);
};


/** Web start. Server mode: reopen every server-wrapped key (team first, then each user through the normal unlock follow-up, which also reaches the agent via request headers).
 *  User mode: delete leftover server wraps so switching back to zero-access leaves nothing the server can read. Exported for tests (a restart loses only memory). */
export async function startKeyMode() {
  if (!SERVER_MODE) {
    // A user whose password wrap is stale (reset in server mode) or missing would lose their data when the server wrap goes.
    const stale = (db.prepare("SELECT w.user_id FROM server_key_wraps w LEFT JOIN user_keys k ON k.user_id = w.user_id WHERE k.user_id IS NULL OR k.state != 'ok'").all() as { user_id: string }[]).map((r) => r.user_id);
    if (stale.length && !process.env.HEFYN_KEY_MODE_FORCE) {
      const who = stale.map((id) => (db.prepare('SELECT email FROM user WHERE id = ?').get(id) as { email: string } | undefined)?.email ?? id).join(', ');
      throw new Error(`HEFYN_KEY_MODE=user would make the data of these users unreadable: ${who}. Start in server mode and have them sign in with their password first, or set HEFYN_KEY_MODE_FORCE=1 to delete the server-held keys anyway.`);
    }
    const n = Number(db.prepare('DELETE FROM server_key_wraps').run().changes) + Number(db.prepare('DELETE FROM instance_settings WHERE key = ?').run(TEAM_SERVER).changes);
    if (n) console.log('[hefyn] HEFYN_KEY_MODE=user: deleted the server-held key wraps');
    return;
  }
  const t = db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(TEAM_SERVER) as { value: string } | undefined;
  if (t) try { loadTeam(unwrap(serverKek(), t.value, 'team:server')); } catch { console.error('[hefyn] team server wrap unreadable (HEFYN_SECRET changed?); admins unlock it by signing in'); }
  for (const { user_id } of db.prepare('SELECT user_id FROM server_key_wraps').all() as { user_id: string }[]) {
    const dek = serverDek(user_id);
    if (dek) await finishUnlock(user_id, dek);
    else console.error(`[hefyn] server wrap of ${user_id} unreadable (HEFYN_SECRET changed?); they unlock with their password`);
  }
}
await startKeyMode();
