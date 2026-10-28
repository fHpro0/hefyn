import './server/startup.ts';
import './server/agent-runtime.ts';
import app from './app.ts';

// Entry of the agent service (bun src/agent.ts): a plain Bun.serve of src/app.ts. No build step.
const server = Bun.serve({ port: Number(process.env.PORT ?? 3000), fetch: app.fetch, idleTimeout: 0 });
console.log(`[hefyn] agent listening on http://localhost:${server.port}`);

const stop = async (code: number) => { await server.stop(); process.exit(code); };
process.on('SIGINT', () => void stop(130));
process.on('SIGTERM', () => void stop(143));
