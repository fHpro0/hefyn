import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { createAppPassword } from '../app-passwords.ts';
import { db } from '../appdb.ts';
import { perm, router, userFacing } from '../trpc.ts';

// Settings, Connected apps: passwords for WebDAV and similar clients (src/server/dav.ts). Same permission as the Files page.
const Name = z.string().trim().min(1, 'Give it a name').max(64).transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, ''));

export const appPasswordsRouter = router({
  list: perm('sandbox.shell').query(({ ctx: { me } }) =>
    (db.prepare('SELECT id, name, prefix, scopes, created_at, last_used_at FROM app_passwords WHERE user_id = ? ORDER BY created_at DESC').all(me.id) as { id: string; name: string; prefix: string; scopes: string; created_at: string; last_used_at: string | null }[])
      .map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, write: r.scopes.includes('files:write'), createdAt: r.created_at, lastUsedAt: r.last_used_at }))),
  /** The only time the password is visible. */
  create: perm('sandbox.shell').input(z.strictObject({ name: Name, write: z.boolean() })).mutation(({ ctx: { me }, input }) =>
    userFacing(() => ({ password: createAppPassword(me.id, input.name, input.write).password }))),
  revoke: perm('sandbox.shell').input(z.strictObject({ id: z.string() })).mutation(({ ctx: { me }, input }) => {
    if (!db.prepare('DELETE FROM app_passwords WHERE id = ? AND user_id = ?').run(input.id, me.id).changes) throw new TRPCError({ code: 'NOT_FOUND', message: 'App password not found' });
    return { ok: true };
  }),
});
