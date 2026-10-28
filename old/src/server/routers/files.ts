import { z } from 'zod';
import { fileOps } from '../storage-routes.ts';
import { authed, router } from '../trpc.ts';

// files.*: the signed-in user's own files (paths relative to /files; StorageError keeps its status). Upload and download stay REST (binary / multipart): /api/files/upload, /api/files/download.
const path = z.string();
export const filesRouter = router({
  usage: authed.query(({ ctx }) => fileOps.usage(ctx.me.id)),
  list: authed.input(z.object({ path: path.optional() })).query(({ ctx, input }) => fileOps.list(ctx.me.id, input.path)),
  delete: authed.input(z.object({ path })).mutation(({ ctx, input }) => fileOps.rm(ctx.me.id, input.path)),
  mkdir: authed.input(z.object({ path })).mutation(({ ctx, input }) => fileOps.mkdir(ctx.me.id, input.path)),
  rename: authed.input(z.object({ from: path, to: path })).mutation(({ ctx, input }) => fileOps.rename(ctx.me.id, input.from, input.to)),
  keep: authed.input(z.object({ conversationId: z.string(), path, dir: path.optional() })).mutation(({ ctx, input }) => fileOps.keep(ctx.me.id, input.conversationId, input.path, input.dir)),
});
