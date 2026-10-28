# Scheduled tasks

A user can have hefyn start a chat at a set time.

## Scheduled tasks

A schedule is `{ id, title, target: { kind: "chat", prompt }, rule, timezone, enabled, nextRunAt, lastRunAt, lastStatus, lastConversationId }`. When it fires, hefyn creates a new conversation titled `<title> · <YYYY-MM-DD>` and sends the prompt to the chat agent exactly like a chat message. The chat is flagged (`scheduled: true` in `GET /api/conversations`, a "Scheduled" badge in the sidebar and chat header) and has no `schedule_*` tools.

Permission: `models.use` (no new permission; a new one would not reach existing custom roles).

### Rules

All times are 24-hour wall-clock times in the schedule's IANA `timezone`.

| `rule` | Meaning |
|---|---|
| `{ "kind": "once", "at": "2026-12-24T09:00" }` | one-off at a local date and time; the schedule then disables itself |
| `{ "kind": "daily", "time": "08:30" }` | every day |
| `{ "kind": "weekly", "days": [1,3,5], "time": "17:00" }` | on these weekdays, 0 = Sunday … 6 = Saturday |
| `{ "kind": "monthly", "day": 15, "time": "09:00" }` | on this day (1-31); a shorter month runs on its last day |
| `{ "kind": "every", "minutes": 120 }` | every N minutes (15 to 44640), counted from the previous scheduled time |

DST is handled with `Intl` (`src/modules/schedules/schedule-rule.ts`): a time inside the spring-forward gap (02:30 on 2026-03-29 in Europe/Berlin) runs right after the gap; a time that happens twice in autumn runs at its first occurrence, once. Weekly/daily times keep their local hour across the switch. Unknown keys are dropped, bad values are 400.

### Scheduler (web process)

`src/modules/schedules/scheduler.ts` (a module job), one loop in the web process, tick every 30 s (first one 5 s after boot).

- **No double fire.** Claiming a due schedule is one conditional `UPDATE` that requires the `next_run_at` that was read and no live lease, and moves `next_run_at` on in the same statement. Two ticks, two processes or a restart cannot fire the same time twice. `lease_until` (30 min) additionally keeps a schedule from firing while its previous fire still works (also for "Run now").
- **Missed fires.** A time more than 1 hour in the past (server down) is skipped: status `missed`, `next_run_at` moved on. Inside the hour it runs once on the first tick. A one-off that is missed finishes (disabled).
- **Keys.** Title and prompt are sealed with the owner's user key (`schedule:<id>:data`); rule, time zone, times and a fixed status word stay in clear because the scheduler must compute them without a key. In server key mode keys are always there. In user key mode a due schedule of a locked user gets status `locked — sign in to let schedules run` and stays due; after the user signs in it fires on a later tick if it is still inside the grace window, otherwise it is `missed`.
- **Limits.** 20 schedules per user, 1 concurrent fire per schedule (409), 3 fires at the same time overall (ticks leave the rest due for the next tick, "Run now" answers 429).
- **Status.** `running` while the turn works, then `ok`, `failed` (reason in `lastDetail`, sealed), `missed`, or the locked text. A fire interrupted by a restart is `failed`.

### Agent tools

Registered in chats of users with `models.use`, except in chats a schedule started.

- `schedule_create({ title, prompt, rule, timezone? })`: `rule` has the shape above (flat object; fields not used by the kind are ignored); `timezone` defaults to `UTC` (the model should ask for the user's). Returns a sentence such as `Scheduled "Friday report" (id …): Every Friday at 17:00 (Europe/Berlin). Next run: 2026-…`.
- `schedule_list()` returns one line per schedule with id, title, rule in words, next run.
- `schedule_delete({ id })`.

They act only on the chat's user's schedules.

