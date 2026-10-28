import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { db } from './appdb.ts';
import { clientIp, peerOf } from './clientip.ts';

// A laptop pairs itself: it mints the secret and sends only its hash, so the server never holds a usable credential.
// user_id NULL = waiting for the user to type the code in the console; revoking deletes the row.
db.exec(`CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, code TEXT, token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, expires_at TEXT, approved_at TEXT, last_seen_at TEXT)`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS devices_code ON devices(code) WHERE code IS NOT NULL');

export const PAIR_MINUTES = 10;
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[-\s]/g, '');

/** The approved device behind `Authorization: Bearer <secret>`, or null. */
export function deviceOf(authorization: string | null | undefined): { id: string; userId: string; name: string } | null {
  const secret = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
  if (!secret) return null;
  const r = db.prepare('SELECT id, user_id, name FROM devices WHERE token_hash = ? AND user_id IS NOT NULL').get(createHash('sha256').update(secret).digest('hex')) as { id: string; user_id: string; name: string } | undefined;
  return r ? { id: r.id, userId: r.user_id, name: r.name } : null;
}

// Pairing guesses are an oracle for binding other people's laptops: 10 per key per 10 minutes.
const tries = new Map<string, { n: number; at: number }>();
export function throttled(key: string): boolean {
  const t = tries.get(key);
  if (!t || Date.now() - t.at > 600_000) {
    if (tries.size > 10_000) for (const [k, v] of tries) if (Date.now() - v.at > 600_000) tries.delete(k);
    tries.set(key, { n: 1, at: Date.now() }); return false; }
  return ++t.n > 10;
}

const nowIso = () => new Date().toISOString();
const rowOf = (authorization: string | undefined) => {
  const secret = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
  return secret ? db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(createHash('sha256').update(secret).digest('hex')) as { id: string; user_id: string | null; name: string; expires_at: string | null } | undefined : undefined;
};

// Public: the laptop has no session. Mounted in api.ts, which applies no global auth.
export const deviceRoutes = new Hono();

deviceRoutes.post('/pair', async (c) => {
  const b = await c.req.json().catch(() => null) as { name?: unknown; code?: unknown; secretHash?: unknown } | null;
  const name = typeof b?.name === 'string' ? b.name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  const code = typeof b?.code === 'string' ? normalizeCode(b.code) : '';
  if (!name || name.length > 64 || !/^[A-HJ-NP-Z2-9]{8}$/.test(code) || typeof b?.secretHash !== 'string' || !/^[0-9a-f]{64}$/.test(b.secretHash)) return c.json({ error: 'invalid pairing request' }, 400);
  if (throttled(`pair:${clientIp(peerOf(c), { xff: c.req.header('x-forwarded-for'), realIp: c.req.header('x-real-ip') })}`)) return c.json({ error: 'too many pairing attempts, try again later' }, 429);
  db.prepare('DELETE FROM devices WHERE user_id IS NULL AND expires_at <= ?').run(nowIso());
  // shortcut: global cap on pending pairings, upgrade to per-IP caps if it ever trips
  if ((db.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id IS NULL').get() as { n: number }).n >= 500) return c.json({ error: 'too many pending pairings' }, 503);
  const expiresAt = new Date(Date.now() + PAIR_MINUTES * 60_000).toISOString();
  try { db.prepare('INSERT INTO devices (id, name, code, token_hash, created_at, expires_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), name, code, b.secretHash, nowIso(), expiresAt); }
  catch { return c.json({ error: 'code or secret already in use, pair again' }, 409); }
  return c.json({ expiresAt }, 201);
});

deviceRoutes.get('/self', (c) => {
  const r = rowOf(c.req.header('authorization'));
  if (!r) return c.json({ error: 'unknown device' }, 401);
  if (!r.user_id) {
    if ((r.expires_at ?? '') > nowIso()) return c.json({ status: 'pending' }, 202);
    db.prepare('DELETE FROM devices WHERE id = ?').run(r.id);
    return c.json({ error: 'pairing expired' }, 410);
  }
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(nowIso(), r.id);
  const user = db.prepare('SELECT email, name FROM user WHERE id = ?').get(r.user_id);
  return c.json({ id: r.id, name: r.name, user }, 200);
});

deviceRoutes.delete('/self', (c) => {
  const r = rowOf(c.req.header('authorization'));
  if (!r) return c.json({ error: 'unknown device' }, 401);
  db.prepare('DELETE FROM devices WHERE id = ?').run(r.id);
  return c.body(null, 204);
});
