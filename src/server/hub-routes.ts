import { Hono } from 'hono';
import { requireAuth, type Env, type Me } from './guard.ts';
import * as hub from './hub.ts';

export interface HubDeps {
  auth?: typeof requireAuth;
  /** Called after a successful install with the connector entries an MCP package needs (Connectors owns that table). */
  onMcpInstall?: (me: Me, target: 'me' | 'team', connectors: hub.ConnectorData[]) => void;
  /** Called after an uninstall so Connectors can drop the entries with source `hub:<packageId>`. */
  onMcpUninstall?: (me: Me, target: 'me' | 'team', packageId: string) => void;
}

// Mount: app.route('/api/hub', hubRoutes()). Permission checks live in hub.ts (HubError -> status).
export function hubRoutes(deps: HubDeps = {}) {
  const r = new Hono<Env>();
  r.use('*', deps.auth ?? requireAuth);
  r.onError((e, c) => (e instanceof hub.HubError ? c.json({ error: e.message }, e.status) : c.json({ error: 'internal error' }, 500)));
  const body = (c: any) => c.req.json().catch(() => ({})) as Promise<any>;
  const me = (c: any): Me => c.get('me');

  r.get('/packages', (c) => c.json(hub.listPackages(me(c), { q: c.req.query('q'), kind: c.req.query('kind'), status: c.req.query('status'), mine: c.req.query('mine') === '1' })));
  r.get('/packages/:id', (c) => c.json(hub.getPackage(me(c), c.req.param('id'))));
  r.get('/packages/:id/file', (c) => c.body(hub.getFile(me(c), c.req.param('id'), c.req.query('path') ?? ''), 200, {
    'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
  }));
  r.post('/packages', async (c) => c.json(await hub.createPackage(me(c), await body(c))));
  r.patch('/packages/:id', async (c) => c.json(await hub.updatePackage(me(c), c.req.param('id'), await body(c))));
  r.delete('/packages/:id', (c) => { hub.deletePackage(me(c), c.req.param('id')); return c.body(null, 204); });
  r.post('/import', async (c) => { const b = await body(c); return c.json(await hub.importFromUrl(me(c), b.url, b.ref)); });
  r.get('/registry/mcp', async (c) => { hub.need(me(c), 'hub.install'); return c.json((await hub.registrySearch(c.req.query('q') ?? '')).map(({ auth: _a, ...h }) => h)); });
  r.post('/registry/mcp/import', async (c) => c.json(await hub.registryImport(me(c), (await body(c)).name)));
  r.post('/packages/:id/publish', async (c) => c.json(await hub.publish(me(c), c.req.param('id'))));
  r.post('/packages/:id/approve', (c) => c.json(hub.approve(me(c), c.req.param('id'))));
  r.post('/packages/:id/reject', async (c) => c.json(hub.reject(me(c), c.req.param('id'), (await body(c)).reason)));
  r.post('/packages/:id/install', async (c) => {
    const target = (await body(c)).target;
    const p = hub.install(me(c), c.req.param('id'), target);
    deps.onMcpInstall?.(me(c), target, hub.onMcpInstall(me(c).id, p.id));
    return c.json(p);
  });
  r.delete('/packages/:id/install', (c) => {
    const target = c.req.query('target');
    const p = hub.uninstall(me(c), c.req.param('id'), target);
    deps.onMcpUninstall?.(me(c), target as 'me' | 'team', c.req.param('id'));
    return c.json(p);
  });
  r.get('/installed', (c) => c.json(hub.installedList(me(c))));
  r.get('/review', (c) => c.json(hub.reviewQueue(me(c))));
  return r;
}
