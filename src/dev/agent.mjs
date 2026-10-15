// Dev supervisor for the agent service: the restart coordinator makes it exit when a restart is due
// (Docker's restart policy does that in production), so start it again here. Ctrl-C / SIGTERM stops for good.
import { spawn } from 'node:child_process';

const port = process.env.HEFYN_AGENT_PORT ?? '5174';
const host = process.env.HEFYN_DEV_HOST ? ['--host', process.env.HEFYN_DEV_HOST] : [];
let child;
let stopping = false;

function start() {
  child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'dev', '--port', port, ...host], { stdio: 'inherit' });
  child.on('exit', (code) => (stopping ? process.exit(code ?? 0) : (console.log(`[agent] exited (${code}); restarting`), setTimeout(start, 500))));
  // Vite loads the app lazily: poke it so the restart coordinator runs before the first request.
  const poke = () => fetch(`http://localhost:${port}/`, { headers: { 'x-hefyn-internal': process.env.HEFYN_INTERNAL_TOKEN ?? 'hefyn-dev-internal-token' } }).catch(() => setTimeout(poke, 500));
  setTimeout(poke, 1500);
}
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stopping = true; child?.kill(s); });
start();
