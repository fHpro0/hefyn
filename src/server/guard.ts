import type { Context, MiddlewareHandler } from 'hono';
import { db } from './appdb.ts';
import { auth } from './auth.ts';
import type { AnyPermission } from './permissions.ts';
import { needsTwoFactorSetup } from './security.ts';
import { getCookie, deleteCookie, setCookie } from 'hono/cookie';
import { adminSetPassword, restoreUnlock } from './keys.ts';
import { UNLOCK_COOKIE, touchUnlockWrap, unlockCookieAttrs } from './unlock-wraps.ts';
import { userOfConversation } from './usage.ts';
import { touchChat } from './chats.ts';
import { runnerConfigured, shellEnabled } from './runner.ts';
import { assistantGrantsAgent } from './assistants.ts';
import { rememberUserKey, userKey } from './vault.ts';

export interface Me { id: string; email: string; name: string; image: string | null; roleId: string; role: string; permissions: AnyPermission[] }
export type Env = { Variables: { me: Me } };

export function meFromUserId(id: string): Me | undefined {
  const r = db.prepare(`SELECT u.id, u.email, u.name, u.image, r.id AS roleId, r.name AS role, r.permissions
    FROM user u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.id = ?`).get(id) as any;
  return r && { ...r, permissions: JSON.parse(r.permissions) };
}

async function sessionMe(c: Context): Promise<Me | undefined> {
  const s = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!s) return undefined;
  const k = userKey(s.user.id), token = s.session?.token; // no token (e.g. a stubbed session): no restart wrap to touch or restore
  if (k) {
    rememberUserKey(s.user.id, k); // activity keeps the unlocked key (and its restart wrap) alive (sliding TTL)
    const kc = getCookie(c, UNLOCK_COOKIE);
    if (token && kc && touchUnlockWrap(token)) setCookie(c, UNLOCK_COOKIE, kc, unlockCookieAttrs); // the cookie slides with the row (every ~10 min)
  } else if (token && await restoreUnlock(s.user.id, token, getCookie(c, UNLOCK_COOKIE))) deleteCookie(c, UNLOCK_COOKIE, { path: '/' }); // after a restart
  return meFromUserId(s.user.id);
}

// The single choke point for the two-factor policy: every guard below ends here. Until the user has set up TOTP, only /api/me and
// the Security-page routes (/api/security/*) work; Better Auth's own /api/auth/* routes never pass through a guard.
const setupRequired = (c: Context, me: Me) =>
  needsTwoFactorSetup(me.id, me.roleId) && c.req.path !== '/api/me' && !c.req.path.startsWith('/api/security/');
// An admin chose this account's password: until the user picks their own (Security page), nothing but /api/me and /api/security works.
const gateError = (c: Context, me: Me) =>
  setupRequired(c, me) ? '2fa_setup_required'
  : adminSetPassword(me.id) && c.req.path !== '/api/me' && !c.req.path.startsWith('/api/security/') ? 'password_change_required' : undefined;
const gate = (c: Context, me: Me) => { const e = gateError(c, me); return e ? c.json({ error: e }, 403) : undefined; };

/** The one auth decision (session, 2FA / password-change gate, optional any-of permissions): the user, or the status and error to answer. tRPC procedures use it too. */
export async function authorize(c: Context, keys: AnyPermission[] = []): Promise<Me | { status: 401 | 403; error: string }> {
  const me = await sessionMe(c);
  if (!me) return { status: 401, error: 'unauthorized' };
  const blocked = gateError(c, me);
  if (blocked) return { status: 403, error: blocked };
  if (keys.length && !keys.some((k) => me.permissions.includes(k))) return { status: 403, error: 'forbidden' };
  return me;
}

const guard = (keys: AnyPermission[]): MiddlewareHandler<Env> => async (c, next) => {
  const r = await authorize(c, keys);
  if (!('id' in r)) return c.json({ error: r.error }, r.status);
  c.set('me', r);
  await next();
};
export const requireAuth = guard([]);

// Allows the request when the user holds ANY of the listed permissions.
export const requirePermission = (...keys: [AnyPermission, ...AnyPermission[]]): MiddlewareHandler<Env> => guard(keys); // at least one: an empty list would mean "anyone signed in"

// In front of the agent service's routes: session, models.use, and the conversation must belong to the caller.
export const agentGuard: MiddlewareHandler<Env> = async (c, next) => {
  const me = await sessionMe(c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  { const blocked = gate(c, me); if (blocked) return blocked; }
  if (!me.permissions.includes('models.use')) return c.json({ error: 'forbidden' }, 403);
  const id = new URL(c.req.url).pathname.split('/')[3];
  if (!id || userOfConversation(id) !== me.id) return c.json({ error: 'forbidden' }, 403);
  // The sign-in terminal of Agent accounts (src/cli-agents/account.ts): one per user, no chat behind it; needs the sandbox runner, not the shell permission (it runs `claude auth login` only).
  if (new URL(c.req.url).pathname.split('/')[2] === 'account') {
    if (id !== `u_${me.id}_signin` || !runnerConfigured()) return c.json({ error: 'not found' }, 404);
    c.set('me', me);
    return next();
  }
  // A deleted chat is gone: its history is 404, not an empty thread. A message bumps the chat's last activity.
  if (c.req.method === 'GET' && !db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)) return c.json({ error: 'not found' }, 404);
  const path = new URL(c.req.url).pathname;
  if (path.split('/')[2] !== 'cli') return c.json({ error: 'forbidden' }, 403); // the only agent route a browser may reach
  // hosted CLI agents (src/cli-agents): the conversation must have one, and the user the sandbox it runs in
  const conv = db.prepare('SELECT agent FROM conversations WHERE id = ?').get(id) as { agent: string | null } | undefined;
  if (!conv || conv.agent === null) return c.json({ error: 'not found' }, 404);
  // raw agent use needs sandbox.shell; an Assistant on the agent grants that agent's sandbox to the roles it lists.
  if (!shellEnabled(me.id) && !(runnerConfigured() && assistantGrantsAgent(me.id, id))) return c.json({ error: 'The sandbox is not available to you.' }, 403);
  if (c.req.method === 'POST' && path.endsWith('/prompt')) touchChat(id);
  c.set('me', me);
  return next();
};
