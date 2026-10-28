import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Per-user and team encryption (docs/ENCRYPTION.md). Keys exist in process memory only; nothing here touches the DB.
// Value format: `hx1:` + base64(iv 12 | tag 16 | ciphertext). The AAD binds a value to its place (e.g. `conv:<id>:title`),
// so a ciphertext copied into another row or column fails to open.

const PREFIX = 'hx1:';
export const KEY_BYTES = 32;

export class LockedError extends Error {
  readonly code = 'locked';
  readonly scope: 'user' | 'team';
  readonly userId?: string;
  constructor(scope: 'user' | 'team', userId?: string) {
    super(scope === 'team' ? 'Team secrets are locked until an admin signs in' : 'Your data is locked: sign in again to unlock it');
    this.scope = scope;
    this.userId = userId;
  }
}

export const isSealed = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PREFIX);
export const newKey = () => randomBytes(KEY_BYTES);

export function seal(key: Buffer, plain: string | Buffer, aad: string): string {
  if (key.length !== KEY_BYTES) throw new Error('vault: bad key length');
  if (!key.some((b) => b !== 0)) throw new Error('vault: refusing an all-zero key');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([c.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

/** Throws on a wrong key, wrong AAD or tampered value. */
export function open(key: Buffer, value: string, aad: string): Buffer {
  if (!isSealed(value)) throw new Error('vault: not a sealed value');
  const b = Buffer.from(value.slice(PREFIX.length), 'base64');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}

// scrypt N=2^15, r=8 (32 MiB, ~100 ms): password and recovery-key derivation. Salt is per user, stored next to the wrapped key.
const KDF = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const newSalt = () => randomBytes(16);
export const kdf = (secret: string, salt: Buffer) =>
  new Promise<Buffer>((res, rej) => scrypt(secret.normalize('NFKC'), salt, KEY_BYTES, KDF, (e, k) => (e ? rej(e) : res(k))));

export const wrap = (kek: Buffer, key: Buffer, aad: string) => seal(kek, key, `wrap:${aad}`);
export function unwrap(kek: Buffer, wrapped: string, aad: string): Buffer {
  const k = open(kek, wrapped, `wrap:${aad}`);
  if (k.length !== KEY_BYTES) throw new Error('vault: bad wrapped key');
  return k;
}

// Recovery key: 160 random bits as 8 groups of 4 Crockford base32 chars. Shown once; only its KDF output wraps a key.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newRecoveryKey(): string {
  const b = randomBytes(20);
  let bits = '', out = '';
  for (const x of b) bits += x.toString(2).padStart(8, '0');
  for (let i = 0; i < 160; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out.match(/.{4}/g)!.join('-');
}
/** Accepts lower case, spaces, missing dashes and the usual look-alikes (O→0, I/L→1). */
export const normalizeRecoveryKey = (s: string) =>
  s.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').match(/.{1,4}/g)?.join('-') ?? '';

// In-memory key cache. User keys expire (sliding) and are dropped on sign-out; the team key lives until restart.
// Buffers are copied in and never zeroed: callers may still hold a key across an await (a zeroed key would wrap to zeros).
const userKeys = new Map<string, { key: Buffer; until: number }>();
export const USER_KEY_TTL_MS = 12 * 60 * 60 * 1000;
let teamKey: Buffer | undefined;

/** Never shortens an existing expiry (the agent's 30-min TTL must not cut the web's 12 h). */
export function rememberUserKey(userId: string, key: Buffer, ttlMs = USER_KEY_TTL_MS) {
  const old = userKeys.get(userId);
  const until = Math.max(Date.now() + ttlMs, old && old.key.length === key.length && timingSafeEqual(old.key, key) ? old.until : 0);
  userKeys.set(userId, { key: Buffer.from(key), until });
}
export function userKey(userId: string): Buffer | undefined {
  const e = userKeys.get(userId);
  if (!e) return;
  if (e.until < Date.now()) { forgetUserKey(userId); return; }
  return e.key;
}
export const forgetUserKey = (userId: string) => void userKeys.delete(userId);
export const setTeamKey = (k: Buffer | undefined) => { teamKey = k && Buffer.from(k); };
export const getTeamKey = () => teamKey;

const needUser = (userId: string) => { const k = userKey(userId); if (!k) throw new LockedError('user', userId); return k; };
const needTeam = () => { if (!teamKey) throw new LockedError('team'); return teamKey; };

// Strict mode: once a user's (or the team's) legacy data is migrated, an unsealed value can only be a DB-write downgrade.
// Callers mark it from the persisted flag (user_keys / instance_settings) when a key is loaded.
const strictUsers = new Set<string>();
let strictTeam = false;
export const markStrictUser = (userId: string) => void strictUsers.add(userId);
export const markStrictTeam = () => { strictTeam = true; };
export class DowngradeError extends Error { readonly code = 'downgrade'; }
const passthrough = (strict: boolean, aad: string, v: string) => { if (strict) throw new DowngradeError(`vault: unsealed value refused (${aad.split(':')[0]})`); return v; };

export const sealForUser = (userId: string, plain: string, aad: string) => seal(needUser(userId), plain, aad);
/** Values written before encryption existed are returned as they are until the user's migration has run (then refused). */
export const openForUser = (userId: string, v: string, aad: string) =>
  isSealed(v) ? open(needUser(userId), v, aad).toString('utf8') : passthrough(strictUsers.has(userId), aad, v);
export const sealForTeam = (plain: string, aad: string) => seal(needTeam(), plain, aad);
export const openForTeam = (v: string, aad: string) => (isSealed(v) ? open(needTeam(), v, aad).toString('utf8') : passthrough(strictTeam, aad, v));
