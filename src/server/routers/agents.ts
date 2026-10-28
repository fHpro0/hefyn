import { z } from 'zod';
import { AgentError, checkUpdates, installAgent, mergeCatalog, reconcile, rowOf, uninstallAgent, allRows } from '../../cli-agents/installed.ts';
import { moduleProfile } from '../../cli-agents/agent-modules.ts';
import { wireFor } from '../../cli-agents/providers.ts';
import { checkChoice, providerChoices } from '../agent-choices.ts';
import { PROFILES, profileOf } from '../../cli-agents/profiles.ts';
import { registry } from '../../cli-agents/registry.ts';
import { ManifestError, parseManifest } from '../../modules/manifest.ts';
import { ModuleError, installModule, uninstallModule } from '../../modules/installed.ts';
import * as hub from '../hub.ts';
import { db } from '../appdb.ts';
import { perm, router, userFacing } from '../trpc.ts';

// agents.*: the admin's side of hosted CLI agents (src/cli-agents, docs/SANDBOX.md): the ACP Registry catalog, install / uninstall, which roles may use an agent.
const manage = perm('models.manage');
export const agentsRouter = router({
  /** The providers (and their models) each installed agent can run on: what the "Default model" pickers offer. */
  models: manage.query(() => Object.fromEntries(allRows().filter((r) => profileOf(r.id)).map((r) => [r.id, providerChoices(profileOf(r.id)!)]))),
  catalog: manage.query(async () => {
    await reconcile();
    return mergeCatalog((await registry()).agents, allRows());
  }),
  /** Add an agent module from a pasted or uploaded manifest (`kind: "agent"`). It goes through the Hub like any package: an approver's module is live at once, anyone else's waits for review. */
  addModule: manage.input(z.record(z.string(), z.unknown())).mutation(({ ctx, input }) => userFacing(async () => {
    if (input.kind !== 'agent') throw new AgentError(400, 'This is not an agent manifest: it needs "kind": "agent".');
    let m;
    try { m = parseManifest(input); } catch (e) { if (e instanceof ManifestError) throw new AgentError(400, e.message); throw e; }
    if (Object.hasOwn(PROFILES, m.id)) throw new AgentError(400, `id: "${m.id}" is a built-in agent`);
    if (moduleProfile(m.id)) throw new AgentError(409, `The agent "${m.id}" is already added. Remove it first to add a new version.`);
    try {
      const p = await hub.createPackage(ctx.me, { kind: 'module', manifest: input });
      const pub = await hub.publish(ctx.me, p.id);
      if (pub.status !== 'approved') return { status: 'pending' as const, id: m.id };
      installModule(ctx.me, hub.moduleSource(p.id), p.id);
      return { status: 'added' as const, id: m.id };
    } catch (e) { if (e instanceof hub.HubError || e instanceof ModuleError) throw new AgentError(e.status, e.message); throw e; }
  })),
  /** Remove an added agent: uninstalls it first (its files in the volume), then the module. Built-in agents cannot be removed. */
  removeModule: manage.input(z.object({ id: z.string().min(1).max(64) })).mutation(({ input }) => userFacing(async () => {
    if (Object.hasOwn(PROFILES, input.id)) throw new AgentError(400, 'This agent is built into hefyn and cannot be removed.');
    if (!moduleProfile(input.id)) throw new AgentError(404, 'This agent module is not added.');
    if (rowOf(input.id)) await uninstallAgent(input.id);
    try { uninstallModule(input.id); } catch (e) { if (e instanceof ModuleError) throw new AgentError(e.status, e.message); throw e; }
    return { ok: true };
  })),
  install: manage.input(z.object({ id: z.string().min(1).max(64) })).mutation(({ input }) => userFacing(async () => { await installAgent(input.id); return { ok: true }; })),
  uninstall: manage.input(z.object({ id: z.string().min(1).max(64) })).mutation(({ input }) => userFacing(async () => { await uninstallAgent(input.id); return { ok: true }; })),
  /** Look at the registry now (ignoring its cache) and start the updates of the agents that update themselves. */
  checkUpdates: manage.mutation(() => userFacing(async () => { await checkUpdates(true); return { ok: true }; })),
  update: manage.input(z.object({ id: z.string().min(1).max(64), enabled: z.boolean().optional(), autoUpdate: z.boolean().optional(),roles: z.array(z.string().min(1).max(128)).max(100).optional(), keyProvider: z.string().min(1).max(64).nullable().optional(),
    defaultProvider: z.string().min(1).max(64).nullable().optional(), defaultModel: z.string().min(1).max(200).nullable().optional() }))
    .mutation(({ input }) => userFacing(() => {
      const row = rowOf(input.id), profile = profileOf(input.id);
      if (!row || !profile) throw new AgentError(404, 'This agent is not installed.');
      if (input.enabled && row.status !== 'ready') throw new AgentError(409, 'This agent is not installed yet.');
      if (input.roles) {
        const known = new Set((db.prepare('SELECT id FROM roles').all() as { id: string }[]).map((r) => r.id));
        const bad = input.roles.find((r) => !known.has(r));
        if (bad) throw new AgentError(400, `Unknown role: ${bad}`);
      }
      if (input.keyProvider && !wireFor(profile.spec, input.keyProvider)) throw new AgentError(400, `This agent cannot use ${input.keyProvider} keys. Use one of ${providerChoices(profile).map((p) => p.id).join(', ')}, or leave it on automatic.`);
      // the default model of chats on this agent that run no Assistant: provider and model are both set or both cleared
      const defP = input.defaultProvider === undefined ? row.default_provider ?? null : input.defaultProvider, defM = input.defaultModel === undefined ? row.default_model ?? null : input.defaultModel;
      if (input.defaultProvider !== undefined || input.defaultModel !== undefined) {
        if (!defM !== !defP) throw new AgentError(400, 'Choose a provider and a model together, or leave both on the agent\'s own choice.');
        const bad = defM && checkChoice(profile, defP, defM, 'the default model');
        if (bad) throw new AgentError(400, bad);
      }
      db.prepare('UPDATE cli_agents SET enabled = ?, roles = ?, key_provider = ?, auto_update = ?, default_provider = ?, default_model = ? WHERE id = ?').run(
        input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
        input.roles ? JSON.stringify([...new Set(input.roles)]) : row.roles,
        input.keyProvider === undefined ? row.key_provider : input.keyProvider,
        input.autoUpdate === undefined ? row.auto_update ?? null : input.autoUpdate ? 1 : 0, defP, defM, input.id);
      return { ok: true };
    })),
});
