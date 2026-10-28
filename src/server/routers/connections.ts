import { z } from 'zod';
import { createConnection, deleteConnection, fieldsOf, need, testRow, updateConnection, view } from '../connections/store.ts';
import { syncConnection, touch } from '../connections/sync.ts';
import { providerRegistry } from '../connections/types.ts';
import { db } from '../appdb.ts';
import { perm, router } from '../trpc.ts';
import type { ConnRow } from '../connections/store.ts';

// Files connections (docs/STORAGE.md): remotes (WebDAV, SFTP, FTP, MCP) synced both ways into /files/<name>. Private to the user; secrets are write-only.
const Id = z.strictObject({ id: z.string().max(64) });
const Values = z.record(z.string().max(60), z.union([z.string().max(20_000), z.number(), z.null()])).default({});
const Body = { name: z.string().max(60), config: Values, secrets: Values, remoteRoot: z.string().max(1024).optional() };
const files = perm('sandbox.shell');
const mine = (userId: string) => (db.prepare('SELECT * FROM connections WHERE user_id = ? ORDER BY name').all(userId) as unknown as ConnRow[]);

export const connectionsRouter = router({
  /** The kinds a connection can have and the fields each asks for (secret fields are write-only). */
  kinds: files.query(({ ctx: { me } }) => [...providerRegistry.values()].map((p) => ({ kind: p.kind, label: p.label, fields: fieldsOf(p, me.id) }))),
  list: files.query(({ ctx: { me } }) => { touch(me.id); return mine(me.id).map(view); }),
  status: files.input(Id).query(({ ctx: { me }, input }) => { touch(me.id); return view(need(me.id, input.id)); }),
  /** Tests the connection first; refuses (400) when it cannot connect. */
  create: files.input(z.strictObject({ kind: z.string().max(30), ...Body })).mutation(async ({ ctx: { me }, input }) => view(await createConnection(me.id, input))),
  update: files.input(z.strictObject({ id: z.string().max(64), name: Body.name.optional(), config: Values.optional(), secrets: Values.optional(), remoteRoot: Body.remoteRoot })).mutation(async ({ ctx: { me }, input }) => {
    const { id, ...rest } = input;
    return view(await updateConnection(me.id, id, rest));
  }),
  /** The remote is never touched; keepLocalCopy=false also removes /files/<folder>. */
  delete: files.input(z.strictObject({ id: z.string().max(64), keepLocalCopy: z.boolean() })).mutation(async ({ ctx: { me }, input }) => { await deleteConnection(me.id, input.id, input.keepLocalCopy); return { ok: true }; }),
  test: files.input(Id).mutation(({ ctx: { me }, input }) => testRow(need(me.id, input.id))),
  syncNow: files.input(Id).mutation(({ ctx: { me }, input }) => syncConnection(me.id, input.id)),
});
