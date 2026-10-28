import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../appdb.ts';
import { normalizeCode, throttled } from '../devices.ts';
import { authed, perm, router } from '../trpc.ts';

// Settings, Devices (docs/DEVICES.md): the user types the code their laptop shows; the device is then bound to them.
const Code = z.strictObject({ code: z.string().max(32).transform(normalizeCode).pipe(z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/, 'That is not a device code')) });
const guess = (userId: string) => { if (throttled(`user:${userId}`)) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many tries. Wait a few minutes.' }); };
const none = () => new TRPCError({ code: 'NOT_FOUND', message: 'No device is waiting with this code' });

export const devicesRouter = router({
  list: authed.query(({ ctx: { me } }) =>
    db.prepare('SELECT id, name, approved_at AS approvedAt, last_seen_at AS lastSeenAt FROM devices WHERE user_id = ? ORDER BY approved_at DESC').all(me.id) as { id: string; name: string; approvedAt: string; lastSeenAt: string | null }[]),
  lookup: perm('devices.connect').input(Code).query(({ ctx: { me }, input }) => {
    guess(me.id);
    const r = db.prepare('SELECT name FROM devices WHERE code = ? AND user_id IS NULL AND expires_at > ?').get(input.code, new Date().toISOString()) as { name: string } | undefined;
    if (!r) throw none();
    return { name: r.name };
  }),
  approve: perm('devices.connect').input(Code).mutation(({ ctx: { me }, input }) => {
    guess(me.id);
    const now = new Date().toISOString();
    const r = db.prepare('UPDATE devices SET user_id = ?, approved_at = ?, code = NULL, expires_at = NULL WHERE code = ? AND user_id IS NULL AND expires_at > ? RETURNING id, name').get(me.id, now, input.code, now) as { id: string; name: string } | undefined;
    if (!r) throw none();
    return r;
  }),
  revoke: authed.input(z.strictObject({ id: z.string() })).mutation(({ ctx: { me }, input }) => {
    if (!db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?').run(input.id, me.id).changes) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });
    return { ok: true };
  }),
});
