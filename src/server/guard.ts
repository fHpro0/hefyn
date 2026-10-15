import type { Context, MiddlewareHandler } from 'hono';
import { db } from './appdb.ts';
import { auth } from './auth.ts';
import { conversationModel } from './connectors.ts';
import { connectedIds } from './providers.ts';
import { loadProfile } from './profile.ts';
import type { Permission } from './permissions.ts';
import { userOfConversation } from './usage.ts';

export interface Me { id: string; email: string; name: string; roleId: string; role: string; permissions: Permission[] }
export type Env = { Variables: { me: Me } };

export function meFromUserId(id: string): Me | undefined {
  const r = db.prepare(`SELECT u.id, u.email, u.name, r.id AS roleId, r.name AS role, r.permissions
    FROM user u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.id = ?`).get(id) as any;
  return r && { ...r, permissions: JSON.parse(r.permissions) };
}

async function sessionMe(c: Context): Promise<Me | undefined> {
  const s = await auth.api.getSession({ headers: c.req.raw.headers });
  return s ? meFromUserId(s.user.id) : undefined;
}

export const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  const me = await sessionMe(c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  c.set('me', me);
  await next();
};

// Allows the request when the user holds ANY of the listed permissions.
export const requirePermission = (...keys: Permission[]): MiddlewareHandler<Env> => async (c, next) => {
  const me = await sessionMe(c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  if (!keys.some((k) => me.permissions.includes(k))) return c.json({ error: 'forbidden' }, 403);
  c.set('me', me);
  await next();
};

// In front of the Flue router: session, models.use, and the conversation must belong to the caller.
export const agentGuard: MiddlewareHandler<Env> = async (c, next) => {
  const me = await sessionMe(c);
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  if (!me.permissions.includes('models.use')) return c.json({ error: 'forbidden' }, 403);
  const id = new URL(c.req.url).pathname.split('/')[3];
  if (!id || userOfConversation(id) !== me.id) return c.json({ error: 'forbidden' }, 403);
  if (c.req.method === 'POST' && !conversationModel(id) && (!connectedIds().length || !loadProfile().model)) return c.json({ error: 'no model configured' }, 409);
  c.set('me', me);
  await next();
};
