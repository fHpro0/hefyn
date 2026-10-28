import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from './appdb.ts';
import { trpcRoutes } from './router.ts';
import { deviceRoutes } from './devices.ts';
import { type Env, requireAuth } from './guard.ts';
import { modelReady } from './agent-prefs.ts';
import { needsTwoFactorSetup } from './security.ts';
import { connectedIds } from './providers.ts';
import { modules } from '../modules/registry.ts';
import { adminSetPassword } from './keys.ts';
import { LockedError } from './vault.ts';

export const api = new Hono<Env>();

// The one place a locked key becomes an answer: 423, so the UI can ask for the password (or tell that an admin has to sign in).
api.onError((e, c) => {
  if (e instanceof LockedError) return c.json({ error: 'locked', scope: e.scope }, 423);
  if (e instanceof HTTPException) return e.getResponse();
  console.error('[hefyn]', e);
  return c.json({ error: 'internal error' }, 500);
});

// Stays REST: the 2FA / password-change gate (guard.ts gateError) lets only /api/me and /api/security/* through, and the console reads it to decide where to send the user.
api.get('/me', requireAuth, (c) => c.json({ ...c.var.me, twoFactorEnabled: !!(db.prepare('SELECT twoFactorEnabled AS t FROM user WHERE id = ?').get(c.var.me.id) as any)?.t, twoFactorSetupRequired: needsTwoFactorSetup(c.var.me.id, c.var.me.roleId), passwordChangeRequired: adminSetPassword(c.var.me.id), providerConnected: connectedIds().length > 0, modelReady: modelReady() }));

api.route('/trpc', trpcRoutes); // the console API (src/server/router.ts)
api.route('/devices', deviceRoutes); // public: a laptop pairs with a code and then uses its own bearer secret, no session
// Module routes; a catch-all `/` goes last so it cannot shadow the others.
for (const r of modules().flatMap((m) => m.routes ?? []).sort((a, b) => +(a.path === '/') - +(b.path === '/'))) api.route(r.path, r.app);

