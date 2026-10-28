import { Hono } from 'hono';
import { type Env, requirePermission } from '../../server/guard.ts';
import { runNow } from './scheduler.ts';
import { ScheduleError, createSchedule, deleteSchedule, getSchedule, listSchedules, previewRule, updateSchedule } from './schedules.ts';

// /api/schedules: the caller's own scheduled tasks (docs/SCHEDULES.md). Everything is owner-only; another user's id is a plain 404.
export const scheduleRoutes = new Hono<Env>();
scheduleRoutes.use('*', requirePermission('models.use'));
const body = (c: any) => c.req.json().catch(() => ({})) as Promise<any>;
const fail = (c: any, e: unknown) => { if (e instanceof ScheduleError) return c.json({ error: e.message }, e.status as 400); throw e; };

scheduleRoutes.get('/', (c) => c.json(listSchedules(c.var.me.id)));
scheduleRoutes.post('/preview', async (c) => { const b = await body(c); try { return c.json(previewRule(b.rule, b.timezone)); } catch (e) { return fail(c, e); } });
scheduleRoutes.post('/', async (c) => { try { return c.json(createSchedule(c.var.me.id, await body(c)), 201); } catch (e) { return fail(c, e); } });
scheduleRoutes.get('/:id', (c) => { const s = getSchedule(c.var.me.id, c.req.param('id')); return s ? c.json(s) : c.json({ error: 'not found' }, 404); });
scheduleRoutes.patch('/:id', async (c) => {
  try { const s = updateSchedule(c.var.me.id, c.req.param('id'), await body(c)); return s ? c.json(s) : c.json({ error: 'not found' }, 404); } catch (e) { return fail(c, e); }
});
scheduleRoutes.delete('/:id', (c) => (deleteSchedule(c.var.me.id, c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)));
scheduleRoutes.post('/:id/run-now', async (c) => {
  const r = await runNow(c.var.me.id, c.req.param('id'));
  return 'error' in r ? c.json(r.status === 423 ? { error: 'locked', scope: 'user' } : { error: r.error }, r.status) : c.json(r, 202);
});
