import { defineModule } from '../types.ts';
import { deleteSchedulesOf, unlinkConversation } from './schedules.ts';
import { useScheduleTools } from './tools.ts';

// The light half of the schedules module (what the agent process loads too): its tables, its sealed columns and the agent tools.
// index.ts adds routes, nav and the scheduler job. Scheduled tasks: docs/SCHEDULES.md.
export const schedulesLight = defineModule({
  id: 'schedules', name: 'Schedules', icon: 'CalendarClock', optional: true,
  migrate(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, data TEXT NOT NULL, rule TEXT NOT NULL, timezone TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT, lease_until TEXT, last_run_at TEXT, last_status TEXT, last_detail TEXT, last_conversation_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules (enabled, next_run_at);
CREATE INDEX IF NOT EXISTS schedules_user ON schedules (user_id);`);
    try { db.exec('ALTER TABLE conversations ADD COLUMN schedule_id TEXT'); } catch { /* column exists */ }
  },
  // data and the failure detail are always written sealed, so rotation only has to make sure none is left over from before.
  sealed: {
    user: (u) => [{ sql: 'SELECT id, data, last_detail FROM schedules WHERE user_id = ?', args: [u], table: 'schedules', where: ['id'], server: false,
      cols: { data: (r) => `schedule:${r.id}:data`, last_detail: (r) => `schedule:${r.id}:detail` } }],
  },
  onConversationDelete: (id, userId) => unlinkConversation(userId, id),
  onUserDelete: deleteSchedulesOf, // sealed with the key that is gone
  conversation: {
    list: { select: ['c.schedule_id IS NOT NULL AS scheduled'], fields: (r) => ({ scheduled: !!r.scheduled }) },
  },
  agent: { tools: ({ userId, conversationId, use }) => useScheduleTools(userId, conversationId, use) },
});
