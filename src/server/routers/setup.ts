import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { ADMIN_ROLE, db } from '../appdb.ts';
import { auth } from '../auth.ts';
import { systemMailConfigured } from '../channels.ts';
import { cleanedHeaders, peerOf } from '../clientip.ts';
import { connectedIds } from '../providers.ts';
import { publicProcedure, router, userFacing } from '../trpc.ts';

// setup.*: the first account. Public by nature (nobody is signed in yet); `create` only works while there are no users.
const countUsers = () => (db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n;
let setupLock = false; // the first account is created once; the lock closes the check-then-create race

export const setupRouter = router({
  status: publicProcedure.query(() => ({ needsSetup: countUsers() === 0, providerConnected: connectedIds().length > 0, mailConfigured: systemMailConfigured() })),
  create: publicProcedure.input(z.object({ name: z.string(), email: z.string(), password: z.string() })).mutation(async ({ ctx: { c }, input: { name, email, password } }) => {
    if (setupLock || countUsers() > 0) throw new TRPCError({ code: 'CONFLICT', message: 'Setup is already done.' });
    setupLock = true;
    try {
      return await userFacing(async () => {
        const r = await auth.api.signUpEmail({ body: { name, email, password }, headers: cleanedHeaders(c.req.raw.headers, peerOf(c)) });
        db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, ADMIN_ROLE);
        return { ok: true };
      });
    } finally {
      setupLock = false;
    }
  }),
});
