import { z } from 'zod';
import { perm, router } from '../../server/trpc.ts';
import { createFolder, deleteFolder, listFolders, moveFolder, renameFolder } from './folders.ts';

// folders.* (per user, never shared; folders.ts has the rules and FolderError keeps its status). Renaming, pinning, archiving and moving a CHAT go through PATCH /conversations/:id
// (the module's `conversation.patch`). A built-in, non-optional module: appRouter (server/router.ts) imports this router statically, which keeps the client's types.
const use = perm('models.use');
const id = z.string();
const place = { parentId: z.string().nullable().optional(), projectId: z.string().nullable().optional(), position: z.number().optional() };
const one = (me: string, folder: string) => listFolders(me).find((f) => f.id === folder);

export const foldersRouter = router({
  list: use.query(({ ctx }) => listFolders(ctx.me.id)),
  create: use.input(z.object({ name: z.string(), ...place })).mutation(({ ctx, input }) => one(ctx.me.id, createFolder(ctx.me.id, input))),
  rename: use.input(z.object({ id, name: z.string() })).mutation(({ ctx, input }) => (renameFolder(ctx.me.id, input.id, input.name), one(ctx.me.id, input.id))),
  // parentId / projectId present (null = top level) re-parents; position alone reorders.
  move: use.input(z.object({ id, ...place })).mutation(({ ctx, input: { id, ...to } }) => (moveFolder(ctx.me.id, id, to), one(ctx.me.id, id))),
  // mode lift (default): subfolders and chats move up a level. delete: they are deleted too (irreversible).
  delete: use.input(z.object({ id, mode: z.enum(['lift', 'delete']).default('lift') })).mutation(({ ctx, input }) => (deleteFolder(ctx.me.id, input.id, input.mode), { ok: true })),
});
