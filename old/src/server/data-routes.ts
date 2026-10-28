import { Hono } from 'hono';
import { exportCsv, getCol } from './data.ts';
import { DataError } from './data-schema.ts';
import { type Env, requirePermission } from './guard.ts';
import { LockedError } from './vault.ts';

// Mounted at /api/data (docs/DATA.md). Only the CSV download stays REST; everything else is data.* in routers/data.ts. No-store: records are the user's data.
export const dataRoutes = new Hono<Env>();
dataRoutes.use('*', requirePermission('data.use'));
dataRoutes.onError((e, c) => {
  if (e instanceof DataError) return c.json({ error: e.message, details: e.details }, e.status);
  if (e instanceof LockedError) return c.json({ error: 'locked', scope: e.scope }, 423);
  console.error('[hefyn] data', e);
  return c.json({ error: 'internal error' }, 500);
});

dataRoutes.get('/:c/export.csv', (c) => {
  const q = c.req.query(), x = getCol(c.var.me, c.req.param('c'));
  return new Response(exportCsv(c.var.me, x, { filter: q.filter, sort: q.sort, q: q.q }), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${x.slug}.csv"`, 'cache-control': 'no-store' } });
});
