import type { MiddlewareHandler } from 'hono';
import { db as appDb } from './appdb.ts';
import { markStrictTeam, markStrictUser, rememberUserKey, setTeamKey } from './vault.ts';

// Agent side of the key transport: the web service sends the caller's keys with each /agents/* request (x-hefyn-user-key, optional
// x-hefyn-team-key, base64). They are kept in memory (sliding TTL) and removed from the request before anything else sees it. Never logged.
export const AGENT_KEY_TTL_MS = 30 * 60 * 1000;

// u_<userId>_<ulid>, as in usage.ts (anchored: a name can not smuggle in another user).
const CONVERSATION = /^u_([A-Za-z0-9-]+)_[0-9A-Za-z]+$/;
/** The user owning a conversation id (`u_<userId>_<ulid>`). */
export const userOfKey = (k: unknown): string | undefined => (typeof k === 'string' ? CONVERSATION.exec(k)?.[1] : undefined);

const decodeKey = (v: string | undefined) => { const k = v ? Buffer.from(v, 'base64') : undefined; return k?.length === 32 ? k : undefined; };
// The persisted "migrated" flags (user_keys.strict, instance_settings team_strict) make unsealed values an error instead of legacy data.
function markStrictFromAppDb(userId?: string) {
  try {
    if (userId) { if ((appDb.prepare('SELECT strict FROM user_keys WHERE user_id = ?').get(userId) as any)?.strict) markStrictUser(userId); }
    else if (['1', 'true'].includes(String((appDb.prepare("SELECT value FROM instance_settings WHERE key = 'team_strict'").get() as any)?.value))) markStrictTeam();
  } catch { /* column not there yet (older app.db): not strict */ }
}
export const acceptKeys: MiddlewareHandler = async (c, next) => {
  const userId = userOfKey(new URL(c.req.url).pathname.split('/')[3]);
  const user = decodeKey(c.req.header('x-hefyn-user-key')), team = decodeKey(c.req.header('x-hefyn-team-key'));
  if (userId && user) { rememberUserKey(userId, user, AGENT_KEY_TTL_MS); markStrictFromAppDb(userId); }
  if (team) { setTeamKey(team); markStrictFromAppDb(); }
  const headers = new Headers(c.req.raw.headers);
  headers.delete('x-hefyn-user-key');
  headers.delete('x-hefyn-team-key');
  c.req.raw = new Request(c.req.raw, { headers });
  await next();
};
