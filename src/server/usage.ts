import { db } from './appdb.ts';

// u_<userId>_<ulid>; Better Auth ids are alphanumeric, so the split is unambiguous.
export const userOfConversation = (id: string) => /^u_([A-Za-z0-9-]+)_[0-9A-Za-z]+$/.exec(id)?.[1];

export function usageSummary(userId?: string, days = 30) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const where = userId ? 'WHERE ts >= ? AND user_id = ?' : 'WHERE ts >= ?';
  const args = userId ? [since, userId] : [since];
  const agg = (group: string) =>
    db.prepare(`SELECT ${group} AS key, COUNT(*) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite, SUM(cost) AS cost
      FROM usage ${where} GROUP BY key ORDER BY key`).all(...args);
  return {
    perDay: agg('substr(ts, 1, 10)'),
    perModel: agg("provider || '/' || model"),
    perUser: userId ? [] : db.prepare(`SELECT u.user_id AS key, COALESCE(x.email, u.user_id) AS label, COUNT(*) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(cost) AS cost
      FROM usage u LEFT JOIN user x ON x.id = u.user_id WHERE ts >= ? GROUP BY u.user_id ORDER BY cost DESC`).all(since),
  };
}
