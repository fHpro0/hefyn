import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { createChannel, deleteChannel, getChannel, listChannels, testChannel, updateChannel } from '../channels.ts';
import { perm, router, userFacing } from '../trpc.ts';

// mail.*: the system mail (SMTP) settings (channels.manage). Responses never contain secrets, only hasSecret.
const manage = perm('channels.manage');
const fields = { name: z.string().optional(), config: z.record(z.string(), z.unknown()), secret: z.string().optional(), enabled: z.boolean().optional() };
const notFound = () => new TRPCError({ code: 'NOT_FOUND', message: 'Not found.' });

export const mailRouter = router({
  list: manage.query(() => listChannels()),
  create: manage.input(z.object(fields)).mutation(({ input }) => userFacing(() => createChannel(input))),
  update: manage.input(z.object({ id: z.string(), ...fields, config: fields.config.optional(), system: z.boolean().optional() })).mutation(({ input: { id, ...patch } }) =>
    userFacing(() => updateChannel(id, patch) ?? Promise.reject(notFound()))),
  delete: manage.input(z.object({ id: z.string() })).mutation(({ input }) => (deleteChannel(input.id), { ok: true })),
  test: manage.input(z.object({ id: z.string(), to: z.string() })).mutation(async ({ input }) => {
    if (!getChannel(input.id)) throw notFound();
    await userFacing(() => testChannel(input.id, input.to));
    return { ok: true };
  }),
});
