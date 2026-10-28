import { defineModule } from '../types.ts';
import { schedulesLight } from './agent.ts';
import { scheduleRoutes } from './routes.ts';
import { recoverStale, TICK_MS, tick } from './scheduler.ts';

// Scheduled tasks (docs/SCHEDULES.md): /api/schedules, the schedule_* agent tools, the scheduler job, and the "Scheduled" chat badge in the console.
export const schedules = defineModule({
  ...schedulesLight,
  nav: [{ place: 'main', label: 'Schedules', href: '/schedules', icon: 'CalendarClock', permission: 'models.use', order: 36 }],
  commands: [{ label: 'Schedules', href: '/schedules', icon: 'CalendarClock', permission: 'models.use', order: 17 }],
  routes: [{ path: '/schedules', app: scheduleRoutes }],
  jobs: [{ name: 'scheduler', everyMs: TICK_MS, first: 5000, init: recoverStale, run: () => tick() }],
});
