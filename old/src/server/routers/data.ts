import { z } from 'zod';
import { colOut, counts, createCollection, createRecord, deleteCollection, deleteRecords, getCol, getRecord, importCsv, listCollections, queryRecords, roleChoices, updateCollection, updateRecord, userChoices } from '../data.ts';
import { perm, router } from '../trpc.ts';

// data.*: collections and records (docs/DATA.md). `collection` is a collection id, slug or name. Field/value rules live in data-schema.ts (DataError: 400/403/404/409/413/422 keep their status, 422 carries `details`).
// The CSV export stays REST (GET /api/data/:c/export.csv, a download).
const use = perm('data.use');
const body = z.record(z.string(), z.unknown());
const collection = z.string();
const values = z.record(z.string(), z.unknown());

const collections = router({
  list: use.query(({ ctx }) => {
    const n = counts(), { items, teamLocked } = listCollections(ctx.me);
    return { items: items.map((x) => colOut(x, n.get(x.id) ?? 0)), teamLocked };
  }),
  get: use.input(z.object({ collection })).query(({ ctx, input }) => { const x = getCol(ctx.me, input.collection); return colOut(x, counts().get(x.id) ?? 0); }),
  create: use.input(body).mutation(({ ctx, input }) => colOut(createCollection(ctx.me, input), 0)),
  update: use.input(z.object({ collection, patch: body })).mutation(({ ctx, input }) => colOut(updateCollection(ctx.me, getCol(ctx.me, input.collection), input.patch))),
  delete: use.input(z.object({ collection })).mutation(({ ctx, input }) => (deleteCollection(ctx.me, getCol(ctx.me, input.collection)), { ok: true })),
});

const records = router({
  list: use.input(z.object({ collection, filter: z.string().optional(), sort: z.string().optional(), q: z.string().optional(), page: z.number().optional(), perPage: z.number().optional(), expand: z.string().optional() }))
    .query(({ ctx, input: { collection, ...o } }) => queryRecords(ctx.me, getCol(ctx.me, collection), o)),
  get: use.input(z.object({ collection, id: z.string() })).query(({ ctx, input }) => getRecord(getCol(ctx.me, input.collection), input.id)),
  create: use.input(z.object({ collection, values })).mutation(({ ctx, input }) => createRecord(ctx.me, getCol(ctx.me, input.collection), input.values)),
  update: use.input(z.object({ collection, id: z.string(), values })).mutation(({ ctx, input }) => updateRecord(ctx.me, getCol(ctx.me, input.collection), input.id, input.values)),
  delete: use.input(z.object({ collection, ids: z.array(z.string()).max(1000) })).mutation(({ ctx, input }) => ({ deleted: deleteRecords(ctx.me, getCol(ctx.me, input.collection), input.ids) })),
});

export const dataRouter = router({
  collections,
  records,
  importCsv: use.input(z.object({ collection, csv: z.string(), mapping: z.record(z.string(), z.string().nullable()).optional(), skipInvalid: z.boolean().optional(), dryRun: z.boolean().optional() }))
    .mutation(({ ctx, input: { collection, csv, ...o } }) => importCsv(ctx.me, getCol(ctx.me, collection), csv, o)),
  // Pickers: user names for relation fields, role names for team access (managers only).
  users: use.query(() => userChoices()),
  roles: perm('data.manage').query(() => roleChoices()),
});
