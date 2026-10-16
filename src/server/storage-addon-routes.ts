import { Hono } from 'hono';
import { ADMIN_ROLE } from './appdb.ts';
import { type Env, requirePermission } from './guard.ts';
import { connectorFor, listConnectors } from './mcp.ts';
import { fsFor } from './runner.ts';
import { StorageError } from './storage.ts';
import { addonById, checkName, createMcpAddon, createWebdav, credsOf, deleteAddon, setCreds, testAddon, visibleAddons } from './storage-addons.ts';

// Mounted at /api/storage-addons. Definitions are per user (private) or team; credentials are always per user
// (a team WebDAV add-on is a shared account only when created so by a team editor).
export const storageAddonRoutes = new Hono<Env>();
const use = requirePermission('models.use'); // same gate as MCP connectors
const fail = (c: any, e: unknown) => c.json({ error: (e as Error).message }, ((e as any)?.status ?? 400) as 400);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

storageAddonRoutes.get('/', use, (c) => {
  const me = c.var.me;
  const conns = new Map(listConnectors(me.id).map((k) => [k.id, k]));
  return c.json(visibleAddons(me.id).map((a) => ({
    id: a.id, name: a.name, kind: a.kind, visibility: a.visibility, mine: a.owner_id === me.id, mount: `/files/${a.name}`,
    ...(a.kind === 'webdav' ? { url: a.url, sharedAccount: !!a.shared, connected: !!credsOf(a, me.id) } : { connector: conns.get(a.connector_id!)?.name, connected: conns.get(a.connector_id!)?.connected ?? false }),
  })));
});

storageAddonRoutes.post('/', use, async (c) => {
  const me = c.var.me, b = await c.req.json().catch(() => ({}));
  try {
    const team = b.visibility === 'team';
    if (team && !me.permissions.includes('profiles.edit_team')) return c.json({ error: 'forbidden' }, 403);
    if (b.sharedAccount && !team) throw new StorageError(400, 'a shared account needs team visibility');
    const k = b.kind === 'mcp' ? connectorFor(me.id, str(b.connectorId)) : undefined;
    if (b.kind === 'mcp') {
      if (!k) throw new StorageError(404, 'unknown MCP server');
      // Marking a server as storage is the owner's call (a team server: a team editor's).
      if (k.visibility === 'team' ? !me.permissions.includes('profiles.edit_team') : k.owner !== me.id) return c.json({ error: 'forbidden' }, 403);
    } else if (b.kind !== 'webdav') throw new StorageError(400, 'kind must be webdav or mcp');
    const name = checkName(me.id, b.name ?? k?.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
    // A local folder of that name would be hidden behind the add-on: refuse before that happens.
    if (await fsFor(me.id).stat(`/files/${name}`).then(() => true, () => false)) throw new StorageError(409, `there is already a local folder named ${name}; choose another name`);
    const a = k ? createMcpAddon(me.id, name, k) : createWebdav(me.id, { name, url: str(b.url), username: str(b.username), password: str(b.password), visibility: b.visibility, sharedAccount: !!b.sharedAccount });
    return c.json({ id: a.id, mount: `/files/${a.name}` });
  } catch (e) { return fail(c, e); }
});

// Set or replace this user's credentials (a shared account: team editors only).
storageAddonRoutes.put('/:id/credentials', use, async (c) => {
  const me = c.var.me, a = addonById(me.id, c.req.param('id'));
  if (!a || a.kind !== 'webdav') return c.json({ error: 'unknown storage add-on' }, 404);
  if (a.shared && !me.permissions.includes('profiles.edit_team')) return c.json({ error: 'forbidden' }, 403);
  const b = await c.req.json().catch(() => ({}));
  if (!str(b.username) || !str(b.password)) return fail(c, new StorageError(400, 'username and app password are required'));
  setCreds(a, me.id, { username: b.username, password: b.password });
  return c.json({ ok: true });
});

storageAddonRoutes.post('/:id/test', use, async (c) => {
  const a = addonById(c.var.me.id, c.req.param('id'));
  return a ? c.json(await testAddon(c.var.me.id, a)) : c.json({ error: 'unknown storage add-on' }, 404);
});

storageAddonRoutes.delete('/:id', use, (c) => {
  const a = addonById(c.var.me.id, c.req.param('id'));
  if (!a) return c.json({ error: 'unknown storage add-on' }, 404);
  if (a.owner_id !== c.var.me.id && c.var.me.roleId !== ADMIN_ROLE) return c.json({ error: 'forbidden' }, 403);
  deleteAddon(a.id);
  return c.json({ ok: true });
});
