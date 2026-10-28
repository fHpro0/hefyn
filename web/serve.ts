import { join } from 'node:path';
import { writeShell } from './shell.ts';

// Dev server for the console (replaces `astro dev`): Bun's fullstack server bundles the HTML shell (React, Tailwind via
// bun-plugin-tailwind in bunfig.toml, the @/ alias from web/tsconfig.json) with HMR. /api and /agents go to the Hono web process
// (`bun run dev:web` starts it on 5173); /brand comes from assets/brand.
const API = process.env.HEFYN_API ?? 'http://localhost:5173';
const brand = join(import.meta.dir, '../assets/brand');
const proxy = (req: Request) => {
  const u = new URL(req.url);
  // while `bun --watch` restarts the API the fetch is refused: answer like a real gateway would (JSON 502), not with Bun's HTML error page
  return fetch(API + u.pathname + u.search, { method: req.method, headers: req.headers, body: req.body, redirect: 'manual', duplex: 'half' } as RequestInit)
    .catch(() => Response.json({ error: 'hefyn is restarting' }, { status: 502 }));
};
const shell = (await import(await writeShell())).default;

const port = Number(process.env.PORT ?? 4321);
Bun.serve({
  port,
  hostname: process.env.HEFYN_DEV_HOST ?? 'localhost', // 0.0.0.0 in the dev container
  idleTimeout: 0, // SSE streams through the proxy
  development: { hmr: true, console: true },
  routes: {
    '/*': shell, // every page URL (including /m/<id>/<screen>) is the one shell; entry.tsx routes
    '/api/*': proxy,
    '/agents/*': proxy,
    '/dav': proxy, // WebDAV (docs/STORAGE.md); every method, so Bun routes it as a plain handler
    '/dav/*': proxy,
    '/brand/*': (req) => new Response(Bun.file(join(brand, new URL(req.url).pathname.slice('/brand/'.length)))),
  },
});
console.log(`console dev server on :${port}`);
