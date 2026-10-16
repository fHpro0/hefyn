import { setProvider, observe } from '@flue/runtime';
import { db } from './appdb.ts';
import { decrypt } from './crypto.ts';
import { companyResolver, userProviders } from './connectors.ts';
import { build } from './providers.ts';
import { installFetchGuard } from './netguard.ts';
import { installGate } from './redact.ts';
import { userOfConversation } from './usage.ts';

// Agent-process side: provider registration, usage, and the restart coordinator (see runtime.ts).

// The web process writes providers to app.db; register new or changed rows before any model is resolved.
const seen = new Map<string, string>();
export function syncProviders() {
  for (const r of db.prepare('SELECT id, base_url, enc_key, models, kind FROM providers').all() as any[]) {
    const sig = r.kind === 'oauth' ? `${r.kind}|${r.base_url}|${r.models}` : `${r.base_url}|${r.enc_key}|${r.models}`; // oauth: tokens are read per request
    if (seen.get(r.id) === sig) continue;
    try {
      setProvider(build({ id: r.id, baseUrl: r.base_url ?? undefined, models: r.models ? JSON.parse(r.models) : undefined }, r.kind === 'oauth' ? companyResolver(r.id) : decrypt(r.enc_key)));
      seen.set(r.id, sig);
    } catch (e) { console.error(`[hefyn] could not register provider ${r.id}:`, (e as Error).message); }
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
const busy = new Set<string>();
observe((e) => {
  if (e.type === 'submission_queued' || e.type === 'submission_running') busy.add(e.submissionId);
  else if (e.type === 'submission_settled') busy.delete(e.submissionId);
  if (e.type !== 'turn' || !e.response.usage || !e.instanceId) return;
  const userId = userOfConversation(e.instanceId);
  if (!userId) return;
  const u = e.response.usage;
  db.prepare('INSERT INTO usage (user_id, conversation_id, provider, model, input, output, cache_read, cache_write, cost, ts) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(userId, e.instanceId, e.request.providerId, e.request.requestedModel, u.input, u.output, u.cacheRead, u.cacheWrite, u.cost.total, e.timestamp);
});

// The privacy layer comes first: gate every model request and guard outbound fetch. The redaction service (GLiNER) is separate and
// stays warm across agent restarts; the gate checks its readiness per request and fails closed, so the agent does not wait for it.
installGate();
await installFetchGuard();
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
  if (busy.size !== lastReported) { lastReported = busy.size; db.prepare('UPDATE runtime SET running_tasks = ? WHERE id = 1').run(busy.size); }
  const r = db.prepare('SELECT state, requested_at FROM runtime WHERE id = 1').get() as { state: string; requested_at: string };
  if (r.state !== 'draining') return;
  // Idle (after a short grace so recovered submissions can report in) or out of time: restart. A forced restart is
  // safe because Flue resumes interrupted submissions on boot.
  if ((busy.size === 0 && Date.now() - bootedAt > 3000) || Date.now() - Date.parse(r.requested_at) > DRAIN_MS) {
    db.prepare("UPDATE runtime SET state = 'restarting' WHERE id = 1").run();
    process.kill(process.pid, 'SIGTERM'); // Flue's graceful shutdown; the supervisor (Docker / dev script) starts us again
    setTimeout(() => process.exit(0), 15_000).unref();
  }
}, 1000);
