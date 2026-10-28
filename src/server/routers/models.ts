import { z } from 'zod';
import { availableModels, companyConnections } from '../connectors.ts';
import { connect, connectedModels, disconnect, listProviders, validate } from '../providers.ts';
import { perm, router, userFacing } from '../trpc.ts';

// models.*: what a user may pick (`available`, `connected`) and the company's providers.
const manage = perm('models.manage');

export const modelsRouter = router({
  // Models are an admin's choice (Assistants carry them): everyone else gets an empty list, so no model picker has anything to show.
  available: perm('models.use').query(({ ctx: { me } }) => (me.permissions.includes('models.manage') ? availableModels(me.id) : [])),
  connected: perm('models.use', 'models.manage').query(({ ctx: { me } }) => (me.permissions.includes('models.manage') ? connectedModels() : [])),
  providers: manage.query(async () => ({ available: listProviders(), connected: await companyConnections() })),
  connect: manage.input(z.object({ provider: z.string().min(1), apiKey: z.string().min(1), baseUrl: z.string().optional(), models: z.array(z.string()).optional() })).mutation(({ input }) =>
    userFacing(async () => {
      const conn = { id: input.provider, baseUrl: input.baseUrl || undefined, models: input.models };
      await validate(conn, input.apiKey);
      connect(conn, input.apiKey);
      return { ok: true };
    })),
  disconnect: manage.input(z.object({ id: z.string() })).mutation(({ input }) => (disconnect(input.id), { ok: true })),
});
