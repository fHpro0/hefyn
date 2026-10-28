import { setProvider, observe } from '@flue/runtime';
import { resetActivity, setActivity } from './activity.ts';
import { db } from './appdb.ts';
import { openProviderSecret } from './seal.ts';
import { companyResolver, userProviders } from './connectors.ts';
import { build } from './providers.ts';
import { installModelAccess } from './model-access.ts';
import { userOfConversation } from './usage.ts';
import { LockedError, userKey } from './vault.ts';

// Agent-process side: provider registration, usage, and the restart coordinator (see runtime.ts).

// The web process writes providers to app.db; register new or changed rows before any model is resolved.
const seen = new Map<string, string>();
export function syncProviders() {
  for (const r of db.prepare('SELECT id, base_url, enc_key, models, kind FROM providers').all() as any[]) {
    const sig = r.kind === 'oauth' ? `${r.kind}|${r.base_url}|${r.models}` : `${r.base_url}|${r.enc_key}|${r.models}`; // oauth: tokens are read per request
    if (seen.get(r.id) === sig) continue;
    try {
      setProvider(build({ id: r.id, baseUrl: r.base_url ?? undefined, models: r.models ? JSON.parse(r.models) : undefined }, r.kind === 'oauth' ? companyResolver(r.id) : openProviderSecret(r)));
      seen.set(r.id, sig);
    } catch (e) { if (!(e instanceof LockedError)) console.error(`[hefyn] could not register provider ${r.id}:`, (e as Error).message); } // locked: retried on the next request, once the admin's team key arrives
  }
  // Per-user providers (u-<userId>-<provider>): credentials are read per request, so a changed key needs no re-registration.
  for (const u of userProviders()) {
    const sig = `${u.row.base_url}|${u.row.models}`;
    if (seen.get(u.id) === sig) continue;
    try { setProvider(u.make()); seen.set(u.id, sig); } catch (e) { console.error(`[hefyn] could not register provider ${u.id}:`, (e as Error).message); }
  }
}

// Flue's instanceId is the conversation id from the URL (u_<userId>_<ulid>), also on delegated-task turns.
// Unsettled submissions (queued or running) are what a restart must wait for.
// Submissions of users whose key is gone (locked) can not run: Flue's lists skip them (flue-vault.ts) and they stay queued until the
// user's key arrives with their next request, so they must not hold up a restart (Flue resumes them afterwards anyway).
const busy = new Map<string, { instance?: string; user?: string }>();
const busyCount = () => [...busy.values()].filter((b) => !b.user || userKey(b.user)).length;
/** Conversations of this user with unsettled submissions (for /internal/forget to abort them). */
export const busyInstancesOf = (userId: string) => [...new Set([...busy.values()].filter((b) => b.user === userId && b.instance).map((b) => b.instance!))];
resetActivity(); // this process is new: nothing it published before is still running
/** Tells conversations.activity whether a classic chat has unsettled submissions (hidden flow-step instances are not conversations and are skipped). */
function publish(instance: string | undefined, user: string | undefined) {
  if (!instance || !user) return;
  const working = [...busy.values()].some((b) => b.instance === instance);
  if (!working) setActivity(instance, user);
  else if (db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(instance)) setActivity(instance, user, { state: 'running' });
}
observe((e) => {
  if (e.type === 'submission_queued' || e.type === 'submission_running') { const b = { instance: e.instanceId, user: e.instanceId ? userOfConversation(e.instanceId) : undefined }; busy.set(e.submissionId, b); publish(b.instance, b.user); }
  else if (e.type === 'submission_settled') { const b = busy.get(e.submissionId); busy.delete(e.submissionId); if (b) publish(b.instance, b.user); }
  if (e.type !== 'turn' || !e.response.usage || !e.instanceId) return;
  const userId = userOfConversation(e.instanceId);
  if (!userId) return;
  const u = e.response.usage;
  db.prepare('INSERT INTO usage (user_id, conversation_id, provider, model, input, output, cache_read, cache_write, cost, ts) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(userId, e.instanceId, e.request.providerId, e.request.requestedModel, u.input, u.output, u.cacheRead, u.cacheWrite, u.cost.total, e.timestamp);
});

installModelAccess();
syncProviders();
const bootedAt = Date.now();
let lastReported = 0;
let announced = false; // 'running' is announced on the first tick, by which time the server accepts connections

const DRAIN_MS = Number(process.env.HEFYN_DRAIN_TIMEOUT_MS ?? 10 * 60_000);
setInterval(() => {
  if (!announced) {
    announced = true;
    db.prepare("UPDATE runtime SET state = 'running', requested_at = NULL, requested_by = NULL, running_tasks = 0 WHERE id = 1").run();
  }
  // Only write on change: the agent must not hit the shared app.db every second. Liveness is the HTTP probe (runtime.ts).
  const n = busyCount();
  if (n !== lastReported) { lastReported = n; db.prepare('UPDATE runtime SET running_tasks = ? WHERE id = 1').run(n); }
  const r = db.prepare('SELECT state, requested_at FROM runtime WHERE id = 1').get() as { state: string; requested_at: string };
  if (r.state !== 'draining') return;
  // Idle (after a short grace so recovered submissions can report in) or out of time: restart. A forced restart is
  // safe because Flue resumes interrupted submissions on boot.
  if ((n === 0 && Date.now() - bootedAt > 3000) || Date.now() - Date.parse(r.requested_at) > DRAIN_MS) {
    db.prepare("UPDATE runtime SET state = 'restarting' WHERE id = 1").run();
    process.kill(process.pid, 'SIGTERM'); // Flue's graceful shutdown; the supervisor (Docker / dev script) starts us again
    setTimeout(() => process.exit(0), 15_000).unref();
  }
}, 1000);
