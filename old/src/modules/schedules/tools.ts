import type { useTool } from '@flue/runtime';
import * as v from 'valibot';
import { db } from '../../server/appdb.ts';
import { ScheduleError, createSchedule, deleteSchedule, listSchedules } from './schedules.ts';
import { LockedError } from '../../server/vault.ts';

// Agent tools for scheduled tasks (docs/SCHEDULES.md): "remind me every Friday at 17:00 to write the weekly report". The tools act for the
// chat's user only. A chat that a schedule started gets none (a schedule cannot spawn schedules).

const rule = v.object({
  kind: v.picklist(['once', 'daily', 'weekly', 'monthly', 'every']),
  at: v.optional(v.string()), time: v.optional(v.string()), days: v.optional(v.array(v.number())), day: v.optional(v.number()), minutes: v.optional(v.number()),
});
const RULE_HELP = 'rule: {kind:"once", at:"2026-12-24T09:00"} (local time) | {kind:"daily", time:"08:30"} | {kind:"weekly", days:[5], time:"17:00"} (0 = Sunday … 6 = Saturday) | {kind:"monthly", day:1, time:"09:00"} | {kind:"every", minutes:60} (at least 15). Times are 24-hour, in the time zone.';

function guarded(f: () => string): string {
  try { return f(); } catch (e) {
    if (e instanceof ScheduleError) return `Error: ${e.message}`;
    if (e instanceof LockedError) return 'Error: the user’s data is locked until they sign in again.';
    throw e;
  }
}

export function useScheduleTools(userId: string, conversationId: string, use: typeof useTool) {
  if ((db.prepare('SELECT schedule_id AS s FROM conversations WHERE id = ?').get(conversationId) as { s: string | null } | undefined)?.s) return;
  use({
    name: 'schedule_create',
    description: `Schedule a recurring or one-off task for the user: at the given time hefyn starts a new chat and sends it the prompt. Use it for reminders and regular reports. ${RULE_HELP} `
      + '`timezone` is an IANA name such as Europe/Berlin (use the user’s if you know it, otherwise ask). The prompt must be self-contained: the new chat does not see this one.',
    input: v.object({ title: v.string(), prompt: v.string(), rule, timezone: v.optional(v.string()) }),
    async run({ data }) {
      return guarded(() => {
        const s = createSchedule(userId, { title: data.title, prompt: data.prompt, rule: data.rule, timezone: data.timezone ?? 'UTC' });
        return `Scheduled "${s.title}" (id ${s.id}): ${s.ruleText}. ${s.nextRunAt ? `Next run: ${s.nextRunAt}.` : ''}`;
      });
    },
  });
  use({
    name: 'schedule_list',
    description: 'List the user’s scheduled tasks (id, title, when, next run, enabled).',
    input: v.object({}),
    async run() {
      return guarded(() => { const l = listSchedules(userId); return l.length ? l.map((s) => `- ${s.id}: "${s.title}", ${s.ruleText}${s.enabled ? `, next run ${s.nextRunAt}` : ', paused'}`).join('\n') : 'No scheduled tasks.'; });
    },
  });
  use({
    name: 'schedule_delete',
    description: 'Delete one of the user’s scheduled tasks by its id (from schedule_list).',
    input: v.object({ id: v.string() }),
    async run({ data }) { return guarded(() => (deleteSchedule(userId, data.id) ? `Deleted the scheduled task ${data.id}.` : `No scheduled task with id ${data.id}.`)); },
  });
}
