import { z } from 'zod';
import { installModule, uninstallHubModule } from '../../modules/installed.ts';
import * as hub from '../hub.ts';
import { skillsmpSearch } from '../hub-sources.ts';
import { removeHubConnectors, upsertHubConnectors } from '../mcp.ts';
import { authed, router } from '../trpc.ts';

// hub.*: the package catalogue the console browses (docs/HUB-API.md). Permission checks live in hub.ts (HubError -> status); bodies are validated by the domain (draftFromBody).
const id = z.object({ id: z.string() });
const target = z.enum(['me', 'team']);
const body = z.record(z.string(), z.unknown());
const conn = (t: 'me' | 'team') => (t === 'team' ? 'team' : 'private');

export const hubRouter = router({
  list: authed.input(z.object({ q: z.string().optional(), kind: z.string().optional(), status: z.string().optional(), mine: z.boolean().optional() }).default({})).query(({ ctx, input }) => hub.listPackages(ctx.me, input)),
  get: authed.input(id).query(({ ctx, input }) => hub.getPackage(ctx.me, input.id)),
  file: authed.input(id.extend({ path: z.string() })).query(({ ctx, input }) => hub.getFile(ctx.me, input.id, input.path)),
  create: authed.input(body).mutation(({ ctx, input }) => hub.createPackage(ctx.me, input)),
  update: authed.input(id.extend({ body })).mutation(({ ctx, input }) => hub.updatePackage(ctx.me, input.id, input.body)),
  delete: authed.input(id).mutation(({ ctx, input }) => { hub.deletePackage(ctx.me, input.id); return { ok: true }; }),
  import: authed.input(z.object({ url: z.string(), ref: z.string().optional() })).mutation(({ ctx, input }) => hub.importFromUrl(ctx.me, input.url, input.ref)),
  registrySearch: authed.input(z.object({ q: z.string().default('') })).query(async ({ ctx, input }) => {
    hub.need(ctx.me, 'hub.install');
    return (await hub.registrySearch(input.q)).map(({ auth: _a, ...h }) => h);
  }),
  registryImport: authed.input(z.object({ name: z.string() })).mutation(({ ctx, input }) => hub.registryImport(ctx.me, input.name)),
  skillsmpSearch: authed.input(z.object({ q: z.string().default(''), page: z.number().optional() })).query(({ ctx, input }) => {
    hub.need(ctx.me, 'hub.install');
    return skillsmpSearch(input.q, input.page || 1);
  }),
  publish: authed.input(id).mutation(({ ctx, input }) => hub.publish(ctx.me, input.id)),
  approve: authed.input(id).mutation(({ ctx, input }) => hub.approve(ctx.me, input.id)),
  reject: authed.input(id.extend({ reason: z.string().optional() })).mutation(({ ctx, input }) => hub.reject(ctx.me, input.id, input.reason)),
  install: authed.input(id.extend({ target })).mutation(({ ctx, input }) => {
    const p = hub.install(ctx.me, input.id, input.target);
    upsertHubConnectors(ctx.me.id, conn(input.target), hub.onMcpInstall(ctx.me.id, p.id));
    if (p.kind !== 'module') return p;
    installModule(ctx.me, hub.moduleSource(p.id), p.id);
    return { ...p, installed: { ...p.installed, team: true } };
  }),
  uninstall: authed.input(id.extend({ target })).mutation(({ ctx, input }) => {
    const p = hub.uninstall(ctx.me, input.id, input.target);
    removeHubConnectors(ctx.me.id, conn(input.target), `hub:${input.id}`);
    if (p.kind !== 'module') return p;
    uninstallHubModule(p.id);
    return { ...p, installed: { ...p.installed, team: false } };
  }),
  installed: authed.query(({ ctx }) => hub.installedList(ctx.me)),
  review: authed.query(({ ctx }) => hub.reviewQueue(ctx.me)),
});
