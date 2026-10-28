import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { db } from './appdb.ts';
import { unwrap, wrap, USER_KEY_TTL_MS } from './vault.ts';

// Two extra wraps of a user's data key (docs/ENCRYPTION.md, "Keys and unlock flows"). Storage only; keys.ts decides when to use them.
//  - unlock_wraps: survives a restart. The key is wrapped by a random K_c that lives only in the browser's HttpOnly cookie `hefyn_unlock`.
//  - passkey_key_wraps: the key wrapped by HKDF(WebAuthn PRF output), so a passkey touch unlocks.
// Created here (not in appdb.ts); a deleted user takes both along.
db.exec(`
CREATE TABLE IF NOT EXISTS unlock_wraps (session_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, wrap TEXT NOT NULL, expires_at TEXT NOT NULL, touched_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS unlock_wraps_user ON unlock_wraps (user_id);
`);
const PASSKEY_WRAPS = 'CREATE TABLE IF NOT EXISTS passkey_key_wraps (user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, credential_id TEXT NOT NULL, wrap TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, credential_id))';
// Better Auth's credentialID is not unique across users, so the wrap is keyed by (user_id, credential_id). Early dev databases had credential_id alone as key: copy over.
if (/credential_id TEXT PRIMARY KEY/.test((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'passkey_key_wraps'").get() as { sql: string } | undefined)?.sql ?? '')) {
  db.exec('DROP INDEX IF EXISTS passkey_key_wraps_user; ALTER TABLE passkey_key_wraps RENAME TO passkey_key_wraps_old');
  db.exec(PASSKEY_WRAPS);
  db.exec('INSERT OR IGNORE INTO passkey_key_wraps SELECT user_id, credential_id, wrap, created_at FROM passkey_key_wraps_old; DROP TABLE passkey_key_wraps_old');
} else db.exec(PASSKEY_WRAPS);

const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------- restart wrap (session-bound) ----------

export const UNLOCK_COOKIE = 'hefyn_unlock';
const SESSION_MAX_AGE = 7 * 86400; // Better Auth's default session lifetime; the row itself idles out after 12 h
// Secure exactly when Better Auth's own cookies are (https base URL, see auth.ts).
export const unlockCookieAttrs = { httpOnly: true, sameSite: 'Strict' as const, path: '/', secure: (process.env.HEFYN_URL ?? 'http://localhost:3000').startsWith('https://'), maxAge: SESSION_MAX_AGE };
export const clearedCookieAttrs = { ...unlockCookieAttrs, maxAge: 0 };
const TOUCH_MS = 10 * 60_000;
const rowAad = (userId: string, hash: string) => `unlock:${userId}:${hash}`;

/** Stores AES-GCM(K_c, dek) for this session; returns K_c for the cookie. The session token itself is never stored, only its hash. */
export function createUnlockWrap(userId: string, sessionToken: string, dek: Buffer): string {
  const kc = randomBytes(32), h = sha(sessionToken), t = iso();
  db.prepare('DELETE FROM unlock_wraps WHERE expires_at < ?').run(t);
  db.prepare('INSERT OR REPLACE INTO unlock_wraps (session_hash, user_id, wrap, expires_at, touched_at) VALUES (?,?,?,?,?)')
    .run(h, userId, wrap(kc, dek, rowAad(userId, h)), iso(USER_KEY_TTL_MS), t);
  return kc.toString('base64url');
}

/** dek = restored. clear = the cookie is useless (no row, expired or wrong): drop it. Neither = no cookie, nothing to do. */
export function openUnlockWrap(userId: string, sessionToken: string, cookie: string | undefined): { dek?: Buffer; clear?: boolean } {
  if (!cookie) return {};
  const h = sha(sessionToken);
  const row = db.prepare('SELECT user_id, wrap, expires_at FROM unlock_wraps WHERE session_hash = ?').get(h) as { user_id: string; wrap: string; expires_at: string } | undefined;
  const bad = () => { db.prepare('DELETE FROM unlock_wraps WHERE session_hash = ?').run(h); return { clear: true }; };
  if (!row || row.user_id !== userId) return { clear: true };
  if (row.expires_at < iso()) return bad();
  try {
    const kc = Buffer.from(cookie, 'base64url');
    if (kc.length !== 32) return bad();
    const dek = unwrap(kc, row.wrap, rowAad(userId, h));
    touchUnlockWrap(sessionToken);
    return { dek };
  } catch { return bad(); }
}

/** Sliding 12 h idle expiry, written at most every ~10 min. True when it was extended (the caller then re-issues the cookie with a fresh Max-Age). */
export const touchUnlockWrap = (sessionToken: string): boolean =>
  Number(db.prepare('UPDATE unlock_wraps SET expires_at = ?, touched_at = ? WHERE session_hash = ? AND touched_at < ?').run(iso(USER_KEY_TTL_MS), iso(), sha(sessionToken), iso(-TOUCH_MS)).changes) > 0;

/** All of the user's rows, or all but the one for `keepToken` (a session that stays and keeps its cookie). */
export const dropUnlockWraps = (userId: string, keepToken?: string) =>
  void db.prepare('DELETE FROM unlock_wraps WHERE user_id = ? AND session_hash != ?').run(userId, keepToken ? sha(keepToken) : '');

// ---------- passkey wrap (WebAuthn PRF) ----------

const pkAad = (userId: string, credentialId: string) => `passkey:${userId}:${credentialId}`;
/** The PRF output never leaves this function's callers' stack: it is only used to derive the wrapping key. */
const prfKey = (prf: Buffer, credentialId: string) => Buffer.from(hkdfSync('sha256', prf, Buffer.alloc(0), `hefyn-unlock-v1:${credentialId}`, 32));

export function savePasskeyWrap(userId: string, credentialId: string, prf: Buffer, dek: Buffer) {
  if (prf.length !== 32) throw new Error('unexpected PRF output length');
  db.prepare('INSERT OR REPLACE INTO passkey_key_wraps (user_id, credential_id, wrap, created_at) VALUES (?,?,?,?)')
    .run(userId, credentialId, wrap(prfKey(prf, credentialId), dek, pkAad(userId, credentialId)), iso());
}
// Only wraps whose passkey still exists count: any deletion path (also raw SQL, e.g. the admin 2FA reset) takes the wrap's power with it.
const LIVE = 'FROM passkey_key_wraps w JOIN passkey p ON p.userId = w.user_id AND p.credentialID = w.credential_id WHERE w.user_id = ?';
export function openPasskeyWrap(userId: string, credentialId: string, prf: Buffer): Buffer | undefined {
  const r = db.prepare(`SELECT w.wrap ${LIVE} AND w.credential_id = ?`).get(userId, credentialId) as { wrap: string } | undefined;
  if (!r || prf.length !== 32) return;
  try { return unwrap(prfKey(prf, credentialId), r.wrap, pkAad(userId, credentialId)); } catch { return; }
}
/** credential id -> when it was enrolled, for passkeys that still exist. */
export const passkeyWraps = (userId: string) => Object.fromEntries((db.prepare(`SELECT w.credential_id, w.created_at ${LIVE}`).all(userId) as { credential_id: string; created_at: string }[]).map((r) => [r.credential_id, r.created_at]));
export const passkeyWrapIds = (userId: string) => Object.keys(passkeyWraps(userId));
export const dropPasskeyWrap = (userId: string, credentialId: string) => void db.prepare('DELETE FROM passkey_key_wraps WHERE user_id = ? AND credential_id = ?').run(userId, credentialId);
export const dropPasskeyWraps = (userId: string) => void db.prepare('DELETE FROM passkey_key_wraps WHERE user_id = ?').run(userId);

/** The data key can no longer be trusted or has been replaced: nothing derived from the old one may open anything. */
export const dropAllUnlockState = (userId: string) => { dropUnlockWraps(userId); dropPasskeyWraps(userId); };
