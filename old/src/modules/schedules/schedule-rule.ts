// Recurrence rules for scheduled tasks (docs/SCHEDULES.md). Pure: no database, no clock, so it is testable and safe to import anywhere.
// Wall-clock rules ("17:00 Europe/Berlin") are resolved with Intl, so DST is handled: a time in the spring-forward gap runs right after
// the gap, a time that happens twice in autumn runs at its first occurrence.

export type Rule =
  | { kind: 'once'; at: string }                            // local 'YYYY-MM-DDTHH:MM' in the schedule's timezone
  | { kind: 'daily'; time: string }                          // 'HH:MM'
  | { kind: 'weekly'; days: number[]; time: string }         // 0 = Sunday … 6 = Saturday
  | { kind: 'monthly'; day: number; time: string }           // day 1-31; a shorter month runs on its last day
  | { kind: 'every'; minutes: number };                      // 15 … 44640, counted from the previous run

export const MIN_EVERY_MINUTES = 15, MAX_EVERY_MINUTES = 44_640;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const AT = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export class RuleError extends Error {}

export function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

/** Strict: unknown kinds, missing or out-of-range fields are errors; extra keys are dropped. */
export function parseRule(raw: unknown): Rule {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const time = () => { if (typeof r.time !== 'string' || !TIME.test(r.time)) throw new RuleError('time must be "HH:MM" (24 hours)'); return r.time; };
  switch (r.kind) {
    case 'once': {
      const m = typeof r.at === 'string' ? AT.exec(r.at) : null;
      const d = m && new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
      if (!m || d!.getUTCMonth() !== +m[2]! - 1 || d!.getUTCDate() !== +m[3]!) throw new RuleError('at must be a local date and time like "2026-12-24T09:00"');
      return { kind: 'once', at: r.at as string };
    }
    case 'daily': return { kind: 'daily', time: time() };
    case 'weekly': {
      const days = Array.isArray(r.days) ? [...new Set(r.days)].sort() : [];
      if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new RuleError('days must list weekdays as numbers 0 (Sunday) to 6 (Saturday)');
      return { kind: 'weekly', days: days as number[], time: time() };
    }
    case 'monthly':
      if (!Number.isInteger(r.day) || (r.day as number) < 1 || (r.day as number) > 31) throw new RuleError('day must be 1 to 31');
      return { kind: 'monthly', day: r.day as number, time: time() };
    case 'every':
      if (!Number.isInteger(r.minutes) || (r.minutes as number) < MIN_EVERY_MINUTES || (r.minutes as number) > MAX_EVERY_MINUTES) throw new RuleError(`minutes must be ${MIN_EVERY_MINUTES} to ${MAX_EVERY_MINUTES} (at least every 15 minutes)`);
      return { kind: 'every', minutes: r.minutes as number };
    default: throw new RuleError('kind must be once, daily, weekly, monthly or every');
  }
}

// ---- time zones ----
const fmts = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string) {
  let f = fmts.get(tz);
  if (!f) fmts.set(tz, f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, +x.value]));
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}
/** tz offset from UTC in ms at an instant. */
function offset(ms: number, tz: string) {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
/** The UTC instant of a wall-clock time in `tz` (see the DST notes at the top). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offs = [...new Set([offset(guess - 864e5, tz), offset(guess + 864e5, tz)])];
  const valid = offs.map((o) => guess - o).filter((u) => offset(u, tz) === guess - u).sort((a, b) => a - b);
  return valid[0] ?? guess - Math.min(...offs); // gap: the offset from before the transition lands just after it
}

const hm = (t: string) => [+t.slice(0, 2), +t.slice(3)] as const;

/**
 * The first run strictly after `after` (ms), or undefined (a one-off in the past). For `every`, `from` is the scheduled time of the
 * run that just happened (default `after`): the next one is the first from + k * minutes after `after`.
 */
export function nextRun(rule: Rule, tz: string, after: number, from = after): number | undefined {
  if (rule.kind === 'every') {
    const step = rule.minutes * 60_000;
    return from + (Math.floor((after - from) / step) + 1) * step;
  }
  if (rule.kind === 'once') {
    const m = AT.exec(rule.at)!;
    const t = zonedToUtc(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, tz);
    return t > after ? t : undefined;
  }
  const [h, mi] = hm(rule.time), start = parts(after, tz);
  for (let i = 0; i < 400; i++) { // calendar arithmetic on the local date (UTC used as a plain calendar)
    const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + i));
    const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate();
    const hit = rule.kind === 'daily' || (rule.kind === 'weekly' ? rule.days.includes(day.getUTCDay()) : d === Math.min(rule.day, new Date(Date.UTC(y, mo, 0)).getUTCDate()));
    if (!hit) continue;
    const t = zonedToUtc(y, mo, d, h, mi, tz);
    if (t > after) return t;
  }
}

export const nextRuns = (rule: Rule, tz: string, after: number, n: number): number[] => {
  const out: number[] = [];
  for (let t = nextRun(rule, tz, after); t !== undefined && out.length < n; t = nextRun(rule, tz, t)) out.push(t);
  return out;
};

/** "Every Friday at 17:00 (Europe/Berlin)". */
export function describeRule(rule: Rule, tz: string): string {
  const zone = ` (${tz})`;
  switch (rule.kind) {
    case 'once': return `Once on ${rule.at.slice(0, 10)} at ${rule.at.slice(11)}${zone}`;
    case 'daily': return `Every day at ${rule.time}${zone}`;
    case 'weekly': {
      const all = rule.days.join() === '0,1,2,3,4,5,6', work = rule.days.join() === '1,2,3,4,5';
      return `Every ${all ? 'day' : work ? 'weekday' : rule.days.map((d) => DAYS[d]).join(', ')} at ${rule.time}${zone}`;
    }
    case 'monthly': return `On day ${rule.day} of every month at ${rule.time}${zone}`;
    case 'every': {
      const m = rule.minutes;
      return m % 60 === 0 ? `Every ${m === 60 ? 'hour' : `${m / 60} hours`}` : `Every ${m} minutes`;
    }
  }
}
