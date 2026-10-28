import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { callTool as runTool, getSettings, installModule, listInstalled, MAX_ARGS_BYTES, putSettings, screenFor, setEnabled, uninstallModule } from '../../modules/installed.ts';
import { forUser } from '../../modules/registry.ts';
import { authed, perm, router } from '../trpc.ts';

// modules.*: management (`modules.manage`) and what the console's module screens use (any signed-in user, filtered by the screen's permission). ModuleError carries its status.
const manage = perm('modules.manage');
const id = z.object({ id: z.string() });
const within = <T>(v: T, max: number): T => {
  if (Buffer.byteLength(JSON.stringify(v ?? null)) > max) throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'body too large' });
  return v;
};

export const modulesRouter = router({
  list: authed.query(({ ctx }) => forUser(ctx.me.permissions)), // the nav, settings, palette and permissions the console builds itself from
  installed: manage.query(() => listInstalled()),
  install: manage.input(z.record(z.string(), z.unknown())).mutation(({ ctx, input }) => installModule(ctx.me, within(input, 300 * 1024))), // a manifest is at most 256 KB
  setEnabled: manage.input(id.extend({ enabled: z.boolean() })).mutation(({ ctx, input }) => (setEnabled(ctx.me, input.id, input.enabled), { ok: true })),
  delete: manage.input(id).mutation(({ input }) => (uninstallModule(input.id), { ok: true })),
  settings: manage.input(id).query(({ input }) => getSettings(input.id)),
  saveSettings: manage.input(id.extend({ values: z.unknown() })).mutation(({ input }) => (putSettings(input.id, { values: input.values }), { ok: true })),
  screen: authed.input(id.extend({ screen: z.string() })).query(({ ctx, input }) => screenFor(input.id, input.screen, ctx.me.permissions)),
  callTool: authed.input(id.extend({ tool: z.string(), args: z.unknown() })).mutation(({ ctx, input }) => runTool(ctx.me, input.id, input.tool, within(input.args ?? {}, MAX_ARGS_BYTES))),
});
