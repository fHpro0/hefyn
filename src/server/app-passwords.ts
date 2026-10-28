import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './appdb.ts';

// App passwords: long random secrets for clients that cannot do a browser sign-in (WebDAV, docs/STORAGE.md "Access from other apps").
// The server mints, shows once, keeps only a salted scrypt hash (N=2^15; the secret has ~158 bits, the cost only slows a leaked table); the account password never works for them.
const hashOf = (pw: string, salt = randomBytes(16)) => `${salt.toString('hex')}$${scryptSync(pw, salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
const matches = (pw: string, stored: string) => {
  const [salt, h] = stored.split('$');
  return timingSafeEqual(Buffer.from(hashOf(pw, Buffer.from(salt, 'hex')).split('$')[1], 'hex'), Buffer.from(h, 'hex'));
};
db.exec(`CREATE TABLE IF NOT EXISTS app_passwords (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL, prefix TEXT NOT NULL,
  scopes TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, last_used_ip TEXT)`);
db.exec('CREATE INDEX IF NOT EXISTS app_passwords_user ON app_passwords(user_id, prefix)');

export const MAX_APP_PASSWORDS = 20;
export type Scope = 'files:read' | 'files:write';
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes; 32 chars = ~158 bits
/** Case and dashes are cosmetic: clients may drop them. */
export const normalize = (s: string) => s.toLowerCase().replace(/-/g, '');

export function createAppPassword(userId: string, name: string, write: boolean) {
  if ((db.prepare('SELECT COUNT(*) AS n FROM app_passwords WHERE user_id = ?').get(userId) as { n: number }).n >= MAX_APP_PASSWORDS) throw Object.assign(new Error(`You can have at most ${MAX_APP_PASSWORDS} app passwords. Revoke one you no longer use.`), { status: 409 });
  const raw = Array.from({ length: 32 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const id = randomUUID();
  db.prepare('INSERT INTO app_passwords (id, user_id, name, hash, prefix, scopes, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, userId, name, hashOf(raw), raw.slice(0, 6), write ? 'files:read files:write' : 'files:read', new Date().toISOString());
  return { id, password: raw.match(/.{4}/g)!.join('-') };
}

// A verified secret is remembered by its sha256 (Finder sends hundreds of requests; scrypt per request would be slow). The row is re-read each time, so a revoke bites at once.
const verified = new Map<string, string>();

/** The scopes of the app password `secret` of this user, or null. */
export function checkAppPassword(userId: string, secret: string): { id: string; write: boolean } | null {
  const pw = normalize(secret);
  if (!/^[a-z0-9]{32}$/.test(pw)) return null;
  const rows = db.prepare('SELECT id, hash, scopes FROM app_passwords WHERE user_id = ? AND prefix = ?').all(userId, pw.slice(0, 6)) as { id: string; hash: string; scopes: string }[];
  const key = createHash('sha256').update(pw).digest('hex');
  for (const r of rows) {
    if (verified.get(key) !== r.id) {
      if (!matches(pw, r.hash)) continue;
      if (verified.size > 1000) verified.clear();
      verified.set(key, r.id);
    }
    return { id: r.id, write: r.scopes.includes('files:write') };
  }
  return null;
}

/** At most once a minute per password. */
export function touchAppPassword(id: string, ip: string) {
  const now = new Date();
  db.prepare('UPDATE app_passwords SET last_used_at = ?, last_used_ip = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)').run(now.toISOString(), ip, id, new Date(now.getTime() - 60_000).toISOString());
}
