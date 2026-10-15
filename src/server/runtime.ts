import { db } from './appdb.ts';

// Shared secret between the web proxy and the agent service (only they may talk to each other).
export const INTERNAL_TOKEN = process.env.HEFYN_INTERNAL_TOKEN ?? 'hefyn-dev-internal-token';

export type RuntimeState = 'running' | 'draining' | 'restarting';
interface Row { state: RuntimeState; requested_at: string | null; requested_by: string | null; running_tasks: number; heartbeat_at: string | null }
const row = () => db.prepare('SELECT * FROM runtime WHERE id = 1').get() as unknown as Row;

export const runtimeState = () => row().state;

/** Ask the agent process to restart once no task runs; new submissions are refused until it is back. Idempotent. */
export function requestRestart(by: string) {
  db.prepare("UPDATE runtime SET state = 'draining', requested_at = ?, requested_by = ? WHERE id = 1 AND state = 'running'").run(new Date().toISOString(), by);
}

export const AGENT_URL = (process.env.HEFYN_AGENT_URL ?? 'http://localhost:5174').replace(/\/$/, '');
let probeAt = 0, probeUp = false;
/** Is the agent answering HTTP? (cached 2 s) Replaces the old per-second DB heartbeat: no writes for liveness. */
export async function agentUp(): Promise<boolean> {
  if (Date.now() - probeAt < 2000) return probeUp;
  probeUp = await fetch(AGENT_URL + '/', { headers: { 'x-hefyn-internal': INTERNAL_TOKEN }, signal: AbortSignal.timeout(1500) }).then((r) => r.status < 500, () => false);
  probeAt = Date.now();
  return probeUp;
}

export async function runtimeInfo() {
  const r = row();
  const up = await agentUp();
  return { state: r.state, runningTasks: up ? r.running_tasks : 0, agentUp: up, requestedAt: r.requested_at, requestedBy: r.requested_by };
}
