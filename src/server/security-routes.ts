import { randomBytes } from 'node:crypto';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { auth, baseURL } from './auth.ts';
import { db } from './appdb.ts';
import { type Env, requireAuth, requirePermission } from './guard.ts';
import { KEY_MODE, adminSetPassword, deriveKey, finishUnlock, grantTeamAccess, pendingAdmins, isAdmin, keyState, passwordOk, recoverKey, rememberAcrossRestart, resetData, rotateRecoveryKey, takeRecoveryKey, takeTeamRecoveryKey, teamUnlock, throttled, unlockWithPasskey } from './keys.ts';
import { dropPasskeyWrap, passkeyWraps, savePasskeyWrap } from './unlock-wraps.ts';
import { getTeamKey, userKey } from './vault.ts';

// /api/security: encryption status and the unlock flows (docs/ENCRYPTION.md). Allowed before two-factor setup (guard.ts).
export const securityRoutes = new Hono<Env>();
const bad = (c: any, error: string, status = 400) => c.json({ error }, status);
const body = (c: any) => c.req.json().catch(() => ({})) as Promise<Record<string, unknown>>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
// The key was just released for this session: also wrap it for a restart (cookie hefyn_unlock, unlock-wraps.ts).
const stay = async (c: any, id: string, dek: Buffer | undefined) => {
  const s = dek && (await auth.api.getSession({ headers: c.req.raw.headers }));
  if (s && dek) rememberAcrossRestart((n, v, a) => setCookie(c, n, v, a), id, s.session.token, dek);
};

// The one-shot recovery keys are handed out by the first call without ?peek=1 (the Security page peeks so it cannot swallow them).
securityRoutes.get('/key-status', requireAuth, (c) => {
  const id = c.var.me.id, admin = isAdmin(id), peek = !!c.req.query('peek'), at = passkeyWraps(id); // credential id -> enrolled at
  c.header('Cache-Control', 'no-store');
  return c.json({ unlocked: !!userKey(id), ...keyState(id), recoveryKeyToShow: peek ? undefined : takeRecoveryKey(id), teamUnlocked: !!getTeamKey(), teamRecoveryKeyToShow: admin && !peek ? takeTeamRecoveryKey(id) : undefined, isAdmin: admin, keyMode: KEY_MODE, passkeyUnlock: Object.keys(at), passkeyUnlockAt: at });
});

// Passkey sign-in has no password: this is where it unlocks. needs_recovery (after a password reset) also needs the recovery key.
securityRoutes.post('/unlock', requireAuth, async (c) => {
  const id = c.var.me.id, { password, recoveryKey } = await body(c);
  if (throttled(id)) return bad(c, 'Too many attempts. Try again in a few minutes.', 429);
  if (!str(password) || !(await passwordOk(id, str(password)))) return bad(c, 'That password is not right.', 401);
  if (adminSetPassword(id)) return bad(c, 'password_change_required', 403);
  const needs = keyState(id).state === 'needs_recovery';
  if (needs && !str(recoveryKey)) return bad(c, 'recovery_key_required', 409);
  const dek = needs ? await recoverKey(id, str(password), str(recoveryKey)) : await deriveKey(id, str(password));
  if (!dek) return bad(c, needs ? 'That recovery key is not right.' : 'recovery_key_required', needs ? 401 : 409);
  await finishUnlock(id, dek);
  await stay(c, id, dek);
  return c.json({ ok: true });
});

// Passkey unlock (WebAuthn PRF). The browser sends the PRF output once; it only derives the key that opens this credential's wrap and is never stored or logged.
// Used right after a passkey sign-in (Better Auth's client drops clientExtensionResults, so the PRF cannot ride along on its verify call) and from the unlock bar.
const prfBytes = (v: unknown) => Buffer.from(str(v), 'base64url');
securityRoutes.post('/passkey-unlock', requireAuth, async (c) => {
  const id = c.var.me.id, { credentialId, prf } = await body(c);
  if (throttled(id)) return bad(c, 'Too many attempts. Try again in a few minutes.', 429);
  const dek = await unlockWithPasskey(id, str(credentialId), prfBytes(prf));
  if (!dek) return bad(c, 'That passkey cannot unlock your data. Use your password.', 401);
  await stay(c, id, dek);
  return c.json({ ok: true });
});

// Enrolment: the server issues the challenge and checks the assertion against the stored public key before it wraps anything.
const challenges = new Map<string, { challenge: string; at: number }>();
securityRoutes.post('/passkey-prf/challenge', requireAuth, (c) => {
  if (!userKey(c.var.me.id)) return bad(c, 'locked', 423);
  const challenge = randomBytes(32).toString('base64url');
  challenges.set(c.var.me.id, { challenge, at: Date.now() });
  return c.json({ challenge });
});
securityRoutes.post('/passkey-prf/enroll', requireAuth, async (c) => {
  const id = c.var.me.id, dek = userKey(id), { response, prf } = await body(c) as { response?: any; prf?: unknown };
  const ch = challenges.get(id);
  challenges.delete(id);
  if (!dek) return bad(c, 'locked', 423);
  if (!ch || Date.now() - ch.at > 120_000 || !response || typeof response.id !== 'string') return bad(c, 'The passkey check expired. Try again.');
  const pk = db.prepare('SELECT credentialID, publicKey, counter, transports FROM passkey WHERE credentialID = ? AND userId = ?').get(response.id, id) as { credentialID: string; publicKey: string; counter: number; transports: string | null } | undefined;
  if (!pk) return bad(c, 'Unknown passkey.', 404);
  try {
    const v = await verifyAuthenticationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: baseURL, expectedRPID: new URL(baseURL).hostname, requireUserVerification: true,
      credential: { id: pk.credentialID, publicKey: Buffer.from(pk.publicKey, 'base64'), counter: pk.counter, transports: pk.transports?.split(',').filter(Boolean) as any } });
    if (!v.verified) throw new Error('not verified');
    db.prepare('UPDATE passkey SET counter = ? WHERE credentialID = ? AND userId = ?').run(v.authenticationInfo.newCounter, pk.credentialID, id);
    savePasskeyWrap(id, pk.credentialID, prfBytes(prf), dek);
  } catch { return bad(c, 'The passkey could not be verified.', 401); }
  return c.json({ ok: true });
});
securityRoutes.post('/passkey-prf/remove', requireAuth, async (c) => {
  const id = c.var.me.id, { credentialId } = await body(c);
  dropPasskeyWrap(id, str(credentialId));
  return c.json({ ok: true });
});

securityRoutes.post('/recovery-key/rotate', requireAuth, async (c) => {
  const id = c.var.me.id, { password } = await body(c), dek = userKey(id);
  if (!dek) return bad(c, 'locked', 423);
  if (throttled(id)) return bad(c, 'Too many attempts. Try again in a few minutes.', 429);
  if (!(await passwordOk(id, str(password)))) return bad(c, 'That password is not right.', 401);
  return c.json({ recoveryKey: await rotateRecoveryKey(id, dek) });
});

// Lost password AND recovery key: the data cannot be opened, so it is deleted and a new key set starts.
securityRoutes.post('/reset-data', requireAuth, async (c) => {
  const id = c.var.me.id, { password, confirm } = await body(c);
  if (confirm !== 'DELETE MY DATA') return bad(c, 'Type DELETE MY DATA to confirm.');
  if (throttled(id)) return bad(c, 'Too many attempts. Try again in a few minutes.', 429);
  if (!(await passwordOk(id, str(password)))) return bad(c, 'That password is not right.', 401);
  if (adminSetPassword(id)) return bad(c, 'password_change_required', 403);
  try { const recoveryKey = await resetData(id, str(password)); await stay(c, id, userKey(id)); return c.json({ ok: true, recoveryKey }); } catch (e) { return bad(c, (e as Error).message, (e as any).status ?? 500); }
});

// No admin wrap works (e.g. after every admin reset their data): the instance recovery key opens the team key.
securityRoutes.post('/team-unlock', requirePermission('users.manage'), async (c) => {
  const id = c.var.me.id, { recoveryKey } = await body(c);
  if (throttled(id)) return bad(c, 'Too many attempts. Try again in a few minutes.', 429);
  return (await teamUnlock(id, str(recoveryKey))) ? c.json({ ok: true }) : bad(c, 'That recovery key is not right.', 401);
});

// New admins wait here until an unlocked admin confirms them; a role row alone never hands out the team key.
securityRoutes.get('/team-pending', requirePermission('users.manage'), (c) => c.json({ teamUnlocked: !!getTeamKey(), pending: pendingAdmins() }));
securityRoutes.post('/team-grant', requirePermission('users.manage'), async (c) => {
  const { userId } = await body(c);
  return grantTeamAccess(c.var.me.id, str(userId)) ? c.json({ ok: true }) : bad(c, 'Unlock team secrets first, and pick another admin without access.', 409);
});
