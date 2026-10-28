import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { type FlowError, simpleAgent as simpleFlowAgent, simpleFlow } from '../../assistants/flow.ts';
import { type Api, modelsFor, skillPackages, validateFlow } from '../../assistants/validate.ts';
import { allRows, usableAgents } from '../../cli-agents/installed.ts';
import { supportsMcp } from '../../cli-agents/manifest-profile.ts';
import { canonicalAgent, profileOf } from '../../cli-agents/profiles.ts';
import { wireFor } from '../../cli-agents/providers.ts';
import { type Helper, roleSlug } from '../../cli-agents/session-config.ts';
import { assistantAvailability } from '../assistant-access.ts';
import { providerChoices } from '../agent-choices.ts';
import { assistantIdOfPackage, packageIdOf, share, ShareError } from '../assistant-share.ts';
import { writeAssistant } from '../assistant-store.ts';
import { THINKING_LEVELS } from '../agent-prefs.ts';
import { type Assistant, ICON_RE, allAssistants, editableBy, getAssistant, inputsOf, mayUseBy, visibleTo } from '../assistants.ts';
import { BundleError, CORE, type Files, collect, pack, readZip, summary } from '../../assistants/bundle.ts';
import { processOf } from '../../assistants/process.ts';
import { type Catalog, type Draft, emptyDraft, serializeDraft, simpleFromFlow } from '../../assistants/draft.ts';
import { DraftConflict, createHidden, discardDraft, fileOf, hiddenOf, lastTurns, listFiles, listOf, newDraftId, putFiles, readDraft, readFile, readFolder, removeDraftFile, renameDraftFile, restoreBundle, sandboxFs, seedDraft, sweepHidden, writeDraftFile } from '../assistant-draft.ts';
import { bundleOf } from '../assistant-bundle.ts';
import { purgeConversations } from '../chats.ts';
import { db } from '../appdb.ts';
import type { Me } from '../guard.ts';
import * as hub from '../hub.ts';
import { agentConnectors, infoOf, listConnectors } from '../mcp.ts';
import { shellEnabled } from '../runner.ts';
import { listSkills } from '../skills.ts';
import { authed, perm, router } from '../trpc.ts';

// assistants.*: what a person picks when they start a chat. Since 2026-10-27 an Assistant is a simple preset of a CLI agent: name, agent, instructions, skills (and who may use it).
// Everyone with `assistants.create` makes private Assistants; `assistants.share` sends one to the Hub review queue; `assistants.manage` edits the team's.
const manageModels = perm('models.manage');
const bad = (message: string): never => { throw new TRPCError({ code: 'BAD_REQUEST', message }); };
const gone = (): never => { throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown assistant' }); };
const can = (me: Me, p: string) => me.permissions.includes(p);
const need = (me: Me, p: string, message = 'You are not allowed to do this.') => { if (!can(me, p)) throw new TRPCError({ code: 'FORBIDDEN', message }); };

const inputs = z.object({
  images: z.enum(['off', 'on']), maxImageEdge: z.number().int().min(64).max(8192), imageQuality: z.number().min(0.1).max(1), documents: z.boolean(), maxUploadMb: z.number().min(1).max(1024),
});
const saveInput = z.object({
  id: z.string().max(64).optional(), draftId: z.string().max(40).optional(), name: z.string().trim().min(1, 'a name is required').max(80), description: z.string().max(300), icon: z.string().max(40).refine((v) => ICON_RE.test(v), 'Pick an icon or an emoji.'), // a lucide component name, or `emoji:<char>`
  inputs, roles: z.array(z.string().max(64)).max(100).default([]), scope: z.enum(['private', 'team']).optional(),
  agent: z.string().max(64).nullable().optional(), provider: z.string().max(64).nullable().optional(), model: z.string().max(200).nullable().optional(), thinking: z.string().nullable().optional(),
  instructions: z.string().max(20_000, 'instructions can be at most 20 000 characters').optional(), skills: z.array(z.string().max(64)).max(50).optional(),
  mcp: z.array(z.string().max(64)).max(50).optional(),
  helpers: z.array(z.object({ role: z.string().trim().min(1, 'a helper needs a role, such as review').max(40), agent: z.string().max(64), provider: z.string().max(64).nullable().optional(), model: z.string().max(200).nullable().optional(), edit: z.boolean().optional() })).max(10).optional(),
});
const roleIds = () => new Set((db.prepare('SELECT id FROM roles').all() as { id: string }[]).map((r) => r.id));
const errorsToTrpc = (errors: FlowError[]): never => { throw new TRPCError({ code: 'BAD_REQUEST', message: errors[0]!.message, cause: Object.assign(new Error(errors[0]!.message), { details: errors }) }); };

const listView = (a: Assistant) => ({ id: a.id, name: a.name, description: a.description, icon: a.icon, agent: a.agent, isDefault: a.isDefault, owner: (a.scope === 'private' ? 'me' : 'team') as 'me' | 'team', inputs: a.inputs });
const editableView = (a: Assistant) => ({ id: a.id, name: a.name, description: a.description, icon: a.icon, agent: a.agent, owner: (a.scope === 'private' ? 'me' : 'team') as 'me' | 'team', scope: a.scope, shareStatus: a.shareStatus, isDefault: a.isDefault, archived: a.archived, updatedAt: a.updatedAt, simple: a.simple });
/** Provider, model and effort are for people who manage models (principle 3): everyone else gets nulls, and their save leaves the stored ones alone. */
const fullView = (a: Assistant, models: boolean) => ({ ...editableView(a), inputs: a.inputs, roles: a.roles, version: a.version, agent: a.agent, provider: models ? a.provider ?? null : null, model: models ? a.model : null, thinking: models ? a.thinking : null, instructions: a.instructions, skills: a.skills, mcp: a.mcp,
  helpers: a.helpers.map((h) => (models ? h : { ...h, provider: null, model: null })) });
/** @deprecated the first console's shape (assistants.admin.list); `assistants.editable` + `assistants.get` replace it. */
const adminView = (a: Assistant) => ({ id: a.id, name: a.name, description: a.description, icon: a.icon, agent: a.agent, model: a.model, thinking: a.thinking, instructions: a.instructions, skills: a.skills, inputs: a.inputs, roles: a.roles, isDefault: a.isDefault, archived: a.archived, updatedAt: a.updatedAt, scope: a.scope, simple: a.simple });

/** The MCP servers an Assistant may name: the saver's own and the team's; a team Assistant only the team's (nobody else can use a private one). */
export function checkMcp(me: Me, scope: 'private' | 'team', ids: string[]): string[] {
  const ok = new Set(agentConnectors(me.id).filter((c) => scope === 'private' || infoOf(c.id)?.visibility === 'team').map((c) => c.id));
  for (const id of ids) if (!ok.has(id)) bad(scope === 'team' ? 'A team Assistant can only use the team\'s MCP servers.' : 'An MCP server is not yours or the team\'s, or agents cannot reach it.');
  return [...new Set(ids)];
}
/** Helpers: a role each, the agent must be able to run headless; its provider and model are for people who manage models (others keep the stored ones for that role). */
export function checkHelpers(models: boolean, list: Helper[], prev: Helper[]): Helper[] {
  const seen = new Set<string>();
  return list.map((h) => {
    const slug = roleSlug(h.role), id = canonicalAgent(h.agent), p = profileOf(id), old = prev.find((x) => roleSlug(x.role) === slug);
    if (!slug) bad('A helper\'s role needs letters or digits, such as review.');
    if (seen.has(slug)) bad(`There are two helpers for "${h.role}". One agent does each job.`);
    seen.add(slug);
    if (!p?.spec.headless) bad(`${p?.name ?? h.agent} cannot be used as a helper.`);
    const provider = models ? h.provider ?? null : old?.provider ?? null, model = models ? h.model ?? null : old?.model ?? null;
    if (provider && !wireFor(p!.spec, provider)) bad(`${p!.name} cannot run on the provider "${provider}".`);
    return { role: h.role.trim(), agent: id, provider, model, edit: h.edit === true };
  });
}

function editable(me: Me, id: string): Assistant {
  const a = getAssistant(id);
  if (!a) return gone();
  if (a.scope === 'private' ? a.owner !== me.id : !can(me, 'assistants.manage')) return gone(); // not theirs: as if it did not exist
  return a;
}

/** What a person can pick for an Assistant (the editor's form and the creator's catalog). */
function optionsOf(me: Me) {
  if (!can(me, 'assistants.create') && !can(me, 'assistants.manage')) need(me, 'assistants.create');
  const manage = can(me, 'assistants.manage');
  const rows = allRows().filter((r) => r.status === 'ready' && r.enabled && profileOf(r.id) && (manage || (shellEnabled(me.id) && usableAgents(me.roleId).some((u) => u.id === r.id))));
  // providers: what the agent can run on (connected API-key providers its API list covers), each with its models
  const models = can(me, 'models.manage');
  // mcp: does the agent take MCP servers; helper: can another agent run it headless
  const agents = rows.map((r) => ({ id: r.id, name: profileOf(r.id)!.name, api: profileOf(r.id)!.api as Api, actsWithoutAsking: !!profileOf(r.id)!.actsWithoutAsking, providers: providerChoices(profileOf(r.id)!),
    mcp: supportsMcp(profileOf(r.id)!.spec), helper: !!profileOf(r.id)!.spec.headless }));
  return {
    agents,
    models: { anthropic: modelsFor('anthropic'), 'openai-responses': modelsFor('openai-responses') },
    canChooseModels: models, // the console shows provider, model and effort only to these people
    thinking: [...THINKING_LEVELS] as string[],
    skills: listSkills(me).map((s) => ({ id: s.id, name: s.name, description: s.description, shared: s.shared })),
    mcp: listConnectors(me.id).filter((c) => c.agents).map((c) => ({ id: c.id, name: c.name, shared: c.visibility === 'team' })),
    roles: manage ? db.prepare('SELECT id, name FROM roles ORDER BY builtin DESC, name').all() as { id: string; name: string }[] : [],
  };
}
// The creator never sees model ids: the catalog has agents (with what they can do), skills and MCP servers only.
const catalogOf = (o: ReturnType<typeof optionsOf>): Catalog => ({ agents: o.agents.map((a) => ({ id: a.id, name: a.name, helper: a.helper, mcp: a.mcp })), skills: o.skills.map(({ id, name, description }) => ({ id, name, description })), mcp: o.mcp.map(({ id, name }) => ({ id, name })) });
const needEditor = (me: Me) => { if (!can(me, 'assistants.create') && !can(me, 'assistants.manage')) need(me, 'assistants.create'); };
const hiddenChat = (me: Me, o: Parameters<typeof createHidden>[1]) => { try { return createHidden(me, o); } catch (e) { return bad((e as Error).message); } };
const reach = async <T,>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { if (e instanceof BundleError) return bad(e.message); if (e instanceof DraftConflict) throw new TRPCError({ code: 'CONFLICT', message: e.message }); throw new TRPCError({ code: 'BAD_GATEWAY', message: `The workspace is not reachable right now: ${(e as Error).message}` }); } };
const packed = (files: Files) => { try { return pack(files); } catch (e) { if (e instanceof BundleError) bad(e.message); throw e; } };
/** The caller's own hidden editor chat of that kind, or "not found". */
function hiddenChatOf(me: Me, id: string, kind: 'creator' | 'test') {
  const r = db.prepare('SELECT draft_id FROM conversations WHERE id = ? AND user_id = ? AND hidden = ?').get(id, me.id, kind) as { draft_id: string } | undefined;
  if (!r?.draft_id) return gone();
  return r;
}
/** The file viewer's target: an open draft (`draftId`) or a saved Assistant (`id`, for people who only look at it): exactly one. */
const viewer = z.object({ draftId: z.string().max(40).optional(), id: z.string().max(64).optional() }).refine((v) => !!v.draftId !== !!v.id, 'Give either draftId or id.');
/** A saved Assistant's stored files, for whoever may use or edit it; one without a bundle (saved before bundles) shows the core files its columns make. */
function storedFiles(me: Me, id: string): Files {
  const a = getAssistant(id);
  if (!a || !(mayUseBy(a, me.id, me.roleId) || (a.scope === 'private' ? a.owner === me.id : can(me, 'assistants.manage')))) return gone();
  return bundleOf(id) ?? serializeDraft({ name: a.name, description: a.description, icon: a.icon, agent: a.agent, instructions: a.instructions, skills: a.skills, newSkills: [], mcp: a.mcp, helpers: a.helpers });
}
/** The process.json of a bundle for the editor: the parsed process (or null) and what is wrong in it. */
const bundleProcess = (files: Files) => { const { process, errors } = processOf(files); return { process, errors }; };
const draftInput = z.object({
  name: z.string().max(80), description: z.string().max(300), icon: z.string().max(40).refine((v) => ICON_RE.test(v), 'Pick an icon or an emoji.'), agent: z.string().max(64).nullable(), instructions: z.string().max(20_000),
  skills: z.array(z.string().max(64)).max(50), newSkills: z.array(z.object({ name: z.string().max(64), description: z.string().max(300), body: z.string().max(100_000) })).max(20).default([]), mcp: z.array(z.string().max(64)).max(50),
  helpers: z.array(z.object({ role: z.string().max(40), agent: z.string().max(64), provider: z.string().max(64).nullable().optional(), model: z.string().max(200).nullable().optional(), edit: z.boolean().optional() })).max(10),
  provider: z.string().max(64).nullable().optional(), model: z.string().max(200).nullable().optional(), thinking: z.string().max(20).nullable().optional(),
});
const toDraft = (d: z.infer<typeof draftInput>): Draft => ({ name: d.name, description: d.description, icon: d.icon, agent: d.agent, instructions: d.instructions, skills: d.skills, newSkills: d.newSkills, mcp: d.mcp, helpers: d.helpers });

export const assistantsRouter = router({
  list: authed.query(async ({ ctx: { me } }) => {
    return Promise.all(visibleTo(me.id, me.roleId).filter((a) => a.simple).map( // a retired flow Assistant is not for chatting
async (a) => {
      const av = await assistantAvailability(me.id, a);
      return { ...listView(a), available: av.available, ...(av.available ? {} : { reason: av.reason }) };
    }));
  }),

  editable: authed.query(({ ctx: { me } }) => editableBy(me.id, can(me, 'assistants.manage')).map(editableView)),

  /** `files` and `bundledSkills`: what the stored bundle holds besides the form fields (sorted paths; names under skills/), for the diagram. */
  get: authed.input(z.object({ id: z.string() })).query(({ ctx: { me }, input }) => ({ ...fullView(editable(me, input.id), can(me, 'models.manage')), ...summary(bundleOf(input.id) ?? {}), ...bundleProcess(bundleOf(input.id) ?? {}) })),

  /** @deprecated use assistants.editable / assistants.get */
  admin: router({ list: manageModels.query(() => allAssistants().filter((a) => a.scope === 'team').map(adminView)) }),

  options: authed.query(({ ctx: { me } }) => optionsOf(me)),

  /** A retired flow Assistant becomes a simple one in place (same id, name and icon): the instructions, skills and agent of its main agent step come along when it has one, otherwise only the name. */
  convertRetired: authed.input(z.object({ id: z.string() })).mutation(({ ctx: { me }, input }) => {
    const a = editable(me, input.id);
    if (a.simple) bad('This Assistant is already a simple one.');
    const s = simpleFromFlow(a.flow), agent = s.agent && profileOf(canonicalAgent(s.agent)) ? canonicalAgent(s.agent) : null;
    const known = new Set(listSkills(me).map((k) => k.id));
    return writeAssistant({ id: a.id, name: a.name, description: a.description, icon: a.icon, inputs: a.inputs, roles: a.roles, flow: simpleFlow({ agent, instructions: s.instructions, skills: s.skills.filter((k) => known.has(k)) }), scope: a.scope, owner: a.owner });
  }),

  /** The Assistant editor's creator chat: a hidden CLI agent chat whose folder holds the draft as files (src/assistants/draft.ts). */
  draft: router({
    /** `assistantId`: the saved Assistant being edited; its stored files (extra files and skills/) are put back into the new folder, so a save keeps them. */
    start: authed.input(z.object({ draftId: z.string().max(40), agent: z.string().max(64), draft: draftInput, assistantId: z.string().max(64).optional() })).mutation(async ({ ctx: { me }, input }) => {
      needEditor(me);
      sweepHidden();
      const stored = input.assistantId ? bundleOf(editable(me, input.assistantId).id) : undefined;
      const found = hiddenOf(me.id, input.draftId, 'creator').find((c) => c.agent === input.agent);
      if (found) return { id: found.id, agent: found.agent };
      const id = hiddenChat(me, { agent: input.agent, hidden: 'creator', draftId: input.draftId });
      try {
        const fs = sandboxFs(me.id, id);
        await seedDraft(fs, input.draftId, toDraft(input.draft), catalogOf(optionsOf(me)));
        await restoreBundle(fs, input.draftId, stored);
      } catch (e) { await discardDraft(me.id, input.draftId); throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `The workspace could not be prepared: ${(e as Error).message}` }); }
      return { id, agent: input.agent };
    }),
    /** What the files are now, next to `draft` (for the parts they leave alone): the draft, what is wrong in them, the extra files and the bundled skills. */
    read: authed.input(z.object({ conversationId: z.string(), draft: draftInput })).mutation(async ({ ctx: { me }, input }) => {
      const c = hiddenChatOf(me, input.conversationId, 'creator');
      const { bundle, errors, ...read } = await reach(() => readDraft(sandboxFs(me.id, input.conversationId), c.draft_id, catalogOf(optionsOf(me)), toDraft(input.draft)));
      const { process, errors: bad } = processOf(bundle);
      return { ...read, errors: [...errors, ...bad], process, ...summary(bundle) };
    }),
    /** The editor's read-only file viewer: every file of the draft folder that would go into the bundle. */
    files: authed.input(viewer).query(async ({ ctx: { me }, input }) => {
      if (input.id) return { files: listOf(storedFiles(me, input.id)) };
      const c = hiddenOf(me.id, input.draftId!, 'creator')[0] ?? gone();
      return { files: await reach(() => listFiles(sandboxFs(me.id, c.id), input.draftId!)) };
    }),
    file: authed.input(viewer.and(z.object({ path: z.string().max(255) }))).query(async ({ ctx: { me }, input }) => {
      if (input.id) { const files = storedFiles(me, input.id); return reach(async () => fileOf(files, input.path)); }
      const c = hiddenOf(me.id, input.draftId!, 'creator')[0] ?? gone();
      return reach(() => readFile(sandboxFs(me.id, c.id), input.draftId!, input.path));
    }),
    /** Editing a draft file; only the caller's own creator folder. `expect`: the text they loaded (null: a new file), else CONFLICT. */
    write: authed.input(z.object({ draftId: z.string().max(40), path: z.string().max(255), text: z.string().max(1024 * 1024), expect: z.string().nullable().optional() })).mutation(async ({ ctx: { me }, input }) => {
      const c = hiddenOf(me.id, input.draftId, 'creator')[0] ?? gone();
      await reach(() => writeDraftFile(sandboxFs(me.id, c.id), input.draftId, input.path, input.text, input.expect));
      return { ok: true };
    }),
    remove: authed.input(z.object({ draftId: z.string().max(40), path: z.string().max(255) })).mutation(async ({ ctx: { me }, input }) => {
      const c = hiddenOf(me.id, input.draftId, 'creator')[0] ?? gone();
      await reach(() => removeDraftFile(sandboxFs(me.id, c.id), input.draftId, input.path));
      return { ok: true };
    }),
    rename: authed.input(z.object({ draftId: z.string().max(40), from: z.string().max(255), to: z.string().max(255) })).mutation(async ({ ctx: { me }, input }) => {
      const c = hiddenOf(me.id, input.draftId, 'creator')[0] ?? gone();
      await reach(() => renameDraftFile(sandboxFs(me.id, c.id), input.draftId, input.from, input.to));
      return { ok: true };
    }),
    /** Leaving the editor: the test chats always go; the creator, its folder and the rest go unless the draft is unsaved (`keepCreator`). */
    discard: authed.input(z.object({ draftId: z.string().max(40), keepCreator: z.boolean().optional() })).mutation(async ({ ctx: { me }, input }) => { await discardDraft(me.id, input.draftId, { keepCreator: input.keepCreator }); return { ok: true }; }),
  }),

  /** Fills a draft from a GitHub or GitLab repository (`url`, `path` = a subfolder) or a zip (`zip`, base64, at most 10 MB): a new draft, or `draftId`'s files are replaced. Open the result with draft.read. `ignored`: paths left out (the creator's brief, .git, binaries). */
  import: authed.input(z.object({ draftId: z.string().max(40).optional(), agent: z.string().max(64).optional(), url: z.string().max(500).optional(), path: z.string().max(255).optional(), zip: z.string().max(14_000_000).optional() })
    .refine((i) => !!i.url !== !!i.zip, 'Give either a repository URL or a zip.')).mutation(async ({ ctx: { me }, input }) => {
    needEditor(me);
    sweepHidden();
    let got: ReturnType<typeof collect>;
    try {
      if (input.url) { const t = await hub.fetchTree(input.url); got = collect(t.entries, { path: input.path || t.path }); } else got = collect(readZip(Buffer.from(input.zip!, 'base64')), { strip: true, path: input.path });
    } catch (e) { if (e instanceof BundleError || e instanceof hub.HubError) return bad(e.message); throw e; }
    const o = optionsOf(me), draftId = input.draftId ?? newDraftId(), found = hiddenOf(me.id, draftId, 'creator')[0];
    let id: string | undefined = found?.id, agent: string | undefined = found?.agent;
    if (!id) {
      let wanted = input.agent; // else the agent the files name, else Claude Code, else the first one there is
      if (!wanted) { try { wanted = JSON.parse(got.files['assistant.json'] ?? '{}').agent; } catch { /* not valid: the draft shows it */ } }
      agent = [wanted, 'claude-acp', o.agents[0]?.id].find((a) => a && o.agents.some((x) => x.id === a));
      if (!agent) return bad('No agent is available to you.');
      id = hiddenChat(me, { agent, hidden: 'creator', draftId });
    }
    const fs = sandboxFs(me.id, id);
    try {
      if (!found) await seedDraft(fs, draftId, emptyDraft(), catalogOf(o));
      await putFiles(fs, draftId, got.files, !!found);
    } catch (e) { if (!found) await discardDraft(me.id, draftId); throw new TRPCError({ code: 'BAD_GATEWAY', message: `The workspace could not be prepared: ${(e as Error).message}` }); }
    return { id, agent: agent!, draftId, ignored: got.ignored };
  }),

  /** The editor's Test: a throwaway chat on the draft as it is now (not the saved Assistant). One per draft: starting again replaces it. */
  test: router({
    start: authed.input(z.object({ draftId: z.string().max(40), draft: draftInput, assistantId: z.string().max(64).optional(), scope: z.enum(['private', 'team']).default('private') })).mutation(async ({ ctx: { me }, input }) => {
      needEditor(me);
      sweepHidden();
      const d = input.draft, o = optionsOf(me), models = can(me, 'models.manage'), prev = input.assistantId ? editable(me, input.assistantId) : undefined;
      if (!d.agent || !o.agents.some((a) => a.id === d.agent)) bad('Pick an agent to run on first.');
      const known = new Set(o.skills.map((s) => s.id));
      for (const s of d.skills) if (!known.has(s)) bad('A skill is not yours or the team\'s.');
      const snapshot: Assistant = {
        id: `draft:${input.draftId}`, name: d.name || 'Draft', description: d.description, icon: d.icon, agent: d.agent, model: models ? d.model ?? null : prev?.model ?? null, provider: models ? d.provider ?? null : prev?.provider ?? null,
        thinking: models ? d.thinking ?? null : prev?.thinking ?? null, instructions: d.instructions, skills: d.skills, mcp: checkMcp(me, input.scope, d.mcp), helpers: checkHelpers(models, d.helpers, prev?.helpers ?? []),
        inputs: inputsOf({}), roles: [], isDefault: false, archived: false, updatedAt: new Date().toISOString(), owner: me.id, scope: 'private', shareStatus: null, version: 0, flow: simpleFlow({}), simple: true,
      };
      const creator = hiddenOf(me.id, input.draftId, 'creator')[0]; // the draft's files: the test chat gets the same copy a saved Assistant's chat would
      const bundle = creator ? packed((await reach(() => readFolder(sandboxFs(me.id, creator.id), input.draftId))).files) : undefined;
      for (const c of hiddenOf(me.id, input.draftId, 'test')) purgeConversations(me.id, [c.id]);
      return { id: hiddenChat(me, { agent: snapshot.agent!, hidden: 'test', draftId: input.draftId, snapshot, bundle }), agent: snapshot.agent! };
    }),
    /** The last turns of the test chat (what was asked, what the agent answered), for "Improve from this test". */
    turns: authed.input(z.object({ id: z.string() })).query(({ ctx: { me }, input }) => { hiddenChatOf(me, input.id, 'test'); return lastTurns(me.id, input.id); }),
    end: authed.input(z.object({ id: z.string() })).mutation(({ ctx: { me }, input }) => { hiddenChatOf(me, input.id, 'test'); purgeConversations(me.id, [input.id]); return { ok: true }; }),
  }),

  /** Saves the Assistant. With `draftId` (the editor's draft) its folder is stored as the Assistant's bundle; without, the stored bundle stays. */
  save: authed.input(saveInput).mutation(async ({ ctx: { me }, input: i }) => {
    const prev = i.id ? editable(me, i.id) : undefined;
    if (!prev) need(me, 'assistants.create', 'You are not allowed to create assistants.');
    const manage = can(me, 'assistants.manage');
    if (i.scope === 'team' && !manage) need(me, 'assistants.manage');
    const scope: 'private' | 'team' = prev ? prev.scope : i.scope === 'team' || (manage && i.scope === undefined) ? 'team' : 'private'; // no scope given: a manager's Assistant is the team's (the console always sends one)
    // provider, model and effort belong to people who manage models: anyone else keeps what is stored (nothing, for a new Assistant)
    const pick = can(me, 'models.manage') ? { provider: i.provider ?? null, model: i.model ?? null, thinking: i.thinking ?? null } : { provider: prev?.provider ?? null, model: prev?.model ?? null, thinking: prev?.thinking ?? null };
    const flow = simpleFlow({ agent: i.agent ?? null, model: pick.model, thinking: pick.thinking, instructions: i.instructions ?? '', skills: i.skills ?? [] });
    if (pick.provider) simpleFlowAgent(flow).config.provider = pick.provider;
    const roles = scope === 'team' ? i.roles : [];
    const known = roleIds();
    for (const r of roles) if (!known.has(r)) bad('Unknown role');
    const errors = validateFlow(flow, { userId: me.id, roleId: me.roleId, scope, selfId: prev?.id });
    if (errors.length) errorsToTrpc(errors);
    const mcp = i.mcp && checkMcp(me, scope, i.mcp);
    const helpers = i.helpers && checkHelpers(can(me, 'models.manage'), i.helpers, prev?.helpers ?? []);
    let bundle: Buffer | undefined;
    if (i.draftId) {
      const creator = hiddenOf(me.id, i.draftId, 'creator')[0];
      if (!creator) bad('The editor session has ended. Open the Assistant again.');
      const { files } = await reach(() => readFolder(sandboxFs(me.id, creator!.id), i.draftId!));
      // the form fields are what was just validated and saved; the folder adds the new skills and the extra files
      const fields = serializeDraft({ name: i.name, description: i.description, icon: i.icon, agent: i.agent ?? null, instructions: i.instructions ?? '', skills: i.skills ?? [], newSkills: [], mcp: mcp ?? prev?.mcp ?? [], helpers: helpers ?? prev?.helpers ?? [] });
      bundle = packed({ ...Object.fromEntries(Object.entries(files).filter(([p]) => !CORE.includes(p))), ...fields });
    }
    const w = writeAssistant({ id: prev?.id, name: i.name, description: i.description, icon: i.icon, inputs: i.inputs, roles, flow, scope, owner: scope === 'private' ? me.id : null, mcp, helpers, bundle });
    return { ...w, errors: [] as FlowError[] };
  }),

  /** Roles, provider, model and effort of an Assistant on their own (the settings dialog), without the draft. Model fields need `models.manage`; roles are for team Assistants. */
  settings: authed.input(z.object({ id: z.string(), roles: z.array(z.string().max(64)).max(100).optional(),
    provider: z.string().max(64).nullable().optional(), model: z.string().max(200).nullable().optional(), thinking: z.string().max(20).nullable().optional() })).mutation(({ ctx: { me }, input: i }) => {
    const a = editable(me, i.id);
    if (!a.simple) bad('Convert this Assistant first.');
    if (i.provider !== undefined || i.model !== undefined || i.thinking !== undefined) need(me, 'models.manage');
    if (i.roles?.length && a.scope !== 'team') bad('Only a team assistant can be limited to roles.');
    const known = roleIds();
    for (const r of i.roles ?? []) if (!known.has(r)) bad('Unknown role');
    const pick = { provider: i.provider === undefined ? a.provider ?? null : i.provider, model: i.model === undefined ? a.model : i.model, thinking: i.thinking === undefined ? a.thinking : i.thinking };
    const flow = simpleFlow({ agent: a.agent, model: pick.model, thinking: pick.thinking, instructions: a.instructions, skills: a.skills });
    if (pick.provider) simpleFlowAgent(flow).config.provider = pick.provider;
    const errors = validateFlow(flow, { userId: me.id, roleId: me.roleId, scope: a.scope, selfId: a.id });
    if (errors.length) errorsToTrpc(errors);
    return writeAssistant({ id: a.id, name: a.name, description: a.description, icon: a.icon, inputs: a.inputs, roles: a.scope === 'team' ? i.roles ?? a.roles : [], flow, scope: a.scope, owner: a.owner });
  }),

  archive: authed.input(z.object({ id: z.string(), archived: z.boolean() })).mutation(({ ctx: { me }, input }) => {
    const a = editable(me, input.id);
    if (input.archived && a.isDefault) bad('The default assistant cannot be archived. Make another one the default first.');
    db.prepare('UPDATE profiles SET archived = ?, updated_at = ? WHERE id = ?').run(input.archived ? 1 : 0, new Date().toISOString(), a.id);
    return { ok: true };
  }),

  setDefault: authed.input(z.object({ id: z.string() })).mutation(({ ctx: { me }, input }) => {
    need(me, 'assistants.manage');
    const a = getAssistant(input.id);
    if (!a) gone();
    if (a!.scope !== 'team') bad('Only a team assistant can be the default.');
    if (a!.archived) bad('An archived assistant cannot be the default.');
    db.prepare('UPDATE profiles SET is_default = (id = ?)').run(a!.id); // one statement: never two defaults, never none
    return { ok: true };
  }),

  remove: authed.input(z.object({ id: z.string() })).mutation(({ ctx: { me }, input }) => {
    const a = editable(me, input.id);
    if (a.isDefault) bad('The default assistant cannot be removed. Make another one the default first.');
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM profile_agents WHERE profile_id = ?').run(a.id);
      db.prepare('DELETE FROM profiles WHERE id = ?').run(a.id);
      db.prepare('UPDATE conversations SET assistant_id = NULL WHERE assistant_id = ?').run(a.id); // chats fall back to the default
      db.prepare('DELETE FROM package_files WHERE package_id = ?').run(packageIdOf(a.id));
      db.prepare("DELETE FROM packages WHERE id = ? AND kind = 'assistant'").run(packageIdOf(a.id));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { ok: true };
  }),

  share: authed.input(z.object({ id: z.string() })).mutation(({ ctx: { me }, input }) => {
    need(me, 'assistants.share', 'You are not allowed to share assistants.');
    try { return share(me, input.id); } catch (e) {
      if (e instanceof ShareError) throw new TRPCError({ code: e.status === 404 ? 'NOT_FOUND' : e.status === 409 ? 'CONFLICT' : 'BAD_REQUEST', message: e.message, cause: Object.assign(e, { details: e.errors }) });
      throw e;
    }
  }),

  /** The Hub review queue shows the shared Assistant as a package of kind `assistant`; `id` is the Assistant's or that package's id. Needs hub.approve. */
  review: authed.input(z.object({ id: z.string(), decision: z.enum(['approve', 'decline']), note: z.string().max(2000).optional() })).mutation(({ ctx: { me }, input }) => {
    const pid = packageIdOf(assistantIdOfPackage(input.id));
    if (input.decision === 'approve') hub.approve(me, pid); else hub.reject(me, pid, input.note);
    return { ok: true };
  }),
});
