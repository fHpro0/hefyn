import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { ADMIN_ROLE } from '../appdb.ts';
import { connectorFor, listConnectors } from '../mcp.ts';
import { fsFor } from '../runner.ts';
import { StorageError } from '../storage.ts';
import { addonById, checkName, createMcpAddon, createWebdav, credsOf, deleteAddon, setCreds, testAddon, visibleAddons } from '../storage-addons.ts';
import { perm, router } from '../trpc.ts';

// storageAddons.*: definitions are per user (private) or team; credentials are always per user
// (a team WebDAV add-on is a shared account only when created so by a team editor).
const use = perm('models.use'); // same gate as MCP connectors
const forbidden = () => new TRPCError({ code: 'FORBIDDEN', message: 'forbidden' });
const unknown = () => new TRPCError({ code: 'NOT_FOUND', message: 'unknown storage add-on' });
const id = z.object({ id: z.string() });

export const storageAddonsRouter = router({
  list: use.query(({ ctx: { me } }) => {
    const conns = new Map(listConnectors(me.id).map((k) => [k.id, k]));
    return visibleAddons(me.id).map((a) => ({
      id: a.id, name: a.name, kind: a.kind, visibility: a.visibility, mine: a.owner_id === me.id, mount: `/files/${a.name}`,
      ...(a.kind === 'webdav' ? { url: a.url, sharedAccount: !!a.shared, connected: !!credsOf(a, me.id) } : { connector: conns.get(a.connector_id!)?.name, connected: conns.get(a.connector_id!)?.connected ?? false }),
    }));
  }),

  create: use.input(z.object({
    kind: z.enum(['webdav', 'mcp']), name: z.string().optional(), connectorId: z.string().optional(), url: z.string().default(''), username: z.string().default(''), password: z.string().default(''),
    visibility: z.string().optional(), sharedAccount: z.boolean().optional(),
  })).mutation(async ({ ctx: { me }, input: b }) => {
    const team = b.visibility === 'team';
    if (team && !me.permissions.includes('profiles.edit_team')) throw forbidden();
    if (b.sharedAccount && !team) throw new StorageError(400, 'a shared account needs team visibility');
    const k = b.kind === 'mcp' ? connectorFor(me.id, b.connectorId ?? '') : undefined;
    if (b.kind === 'mcp') {
      if (!k) throw new StorageError(404, 'unknown MCP server');
      // Marking a server as storage is the owner's call (a team server: a team editor's).
      if (k.visibility === 'team' ? !me.permissions.includes('profiles.edit_team') : k.owner !== me.id) throw forbidden();
    }
    const name = checkName(me.id, b.name ?? k?.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
    // A local folder of that name would be hidden behind the add-on: refuse before that happens.
    if (await fsFor(me.id).stat(`/files/${name}`).then(() => true, () => false)) throw new StorageError(409, `there is already a local folder named ${name}; choose another name`);
    const a = k ? createMcpAddon(me.id, name, k) : createWebdav(me.id, { name, url: b.url, username: b.username, password: b.password, visibility: b.visibility, sharedAccount: !!b.sharedAccount });
    return { id: a.id, mount: `/files/${a.name}` };
  }),

  // Set or replace this user's credentials (a shared account: team editors only).
  setCredentials: use.input(id.extend({ username: z.string().min(1), password: z.string().min(1) })).mutation(({ ctx: { me }, input }) => {
    const a = addonById(me.id, input.id);
    if (!a || a.kind !== 'webdav') throw unknown();
    if (a.shared && !me.permissions.includes('profiles.edit_team')) throw forbidden();
    setCreds(a, me.id, { username: input.username, password: input.password });
    return { ok: true };
  }),

  test: use.input(id).mutation(({ ctx, input }) => {
    const a = addonById(ctx.me.id, input.id);
    if (!a) throw unknown();
    return testAddon(ctx.me.id, a);
  }),

  delete: use.input(id).mutation(({ ctx, input }) => {
    const a = addonById(ctx.me.id, input.id);
    if (!a) throw unknown();
    if (a.owner_id !== ctx.me.id && ctx.me.roleId !== ADMIN_ROLE) throw forbidden();
    deleteAddon(a.id);
    return { ok: true };
  }),
});
