import { cliHost } from '../cli-agents/host.ts';
import { resetActivity } from './activity.ts';
import { db } from './appdb.ts';

// Agent-process side of the restart coordinator (see runtime.ts): announces 'running' and, once a restart is requested, waits for the
// hosted CLI agents' turns to finish (or the drain timeout) before the process ends and its supervisor (Docker / the dev script) starts it again.
resetActivity(); // this process is new: nothing it published before is still running
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
  const n = cliHost().busyCount();
  if (n !== lastReported) { lastReported = n; db.prepare('UPDATE runtime SET running_tasks = ? WHERE id = 1').run(n); }
  const r = db.prepare('SELECT state, requested_at FROM runtime WHERE id = 1').get() as { state: string; requested_at: string };
  if (r.state !== 'draining') return;
  if ((n === 0 && Date.now() - bootedAt > 3000) || Date.now() - Date.parse(r.requested_at) > DRAIN_MS) {
    db.prepare("UPDATE runtime SET state = 'restarting' WHERE id = 1").run();
    process.kill(process.pid, 'SIGTERM');
    setTimeout(() => process.exit(0), 15_000).unref();
  }
}, 1000);
