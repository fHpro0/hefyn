import { randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { usableAgents } from '../../cli-agents/installed.ts';
import { assistantAvailability } from '../assistant-access.ts';
import { getAssistant, mayUseBy } from '../assistants.ts';
import { defaultAssistantId } from '../profile.ts';
import { canonicalAgent, profileOf } from '../../cli-agents/profiles.ts';
import { active } from '../../modules/active.ts';
import { availableModels } from '../connectors.ts';
import { validThinking } from '../agent-prefs.ts';
import { db } from '../appdb.ts';
import { activityOf } from '../activity.ts';
import { ACTIVITY_SQL, chatMeta, purgeConversations } from '../chats.ts';
import { shellEnabled } from '../runner.ts';
import { authed, perm, router } from '../trpc.ts';
import { userOfConversation } from '../usage.ts';
import { openForUser, sealForUser } from '../vault.ts';

// conversations.*: the chat list and its housekeeping. Modules add fields, filters and actions through `conversation` hooks, so these inputs stay loose
// (the module validates its own keys). Folders and projects live in their modules; their bulk actions are `conversation.bulk`.
const fail = (message: string, code: TRPCError['code']): never => { throw new TRPCError({ code, message }); };
const bad = (message: string): never => fail(message, 'BAD_REQUEST');
const ulid = () => Date.now().toString(36).padStart(9, '0') + randomBytes(8).toString('hex');
const use = perm('models.use');
const id = z.string();
const owned = (me: { id: string }, conv: string) => { if (userOfConversation(conv) !== me.id) fail('forbidden', 'FORBIDDEN'); };

const BULK = ['delete', 'archive', 'unarchive'];
const DEFAULT_AGENT = 'claude-acp';

export const conversationsRouter = router({
  // Titles are sealed with the owner's key (`conv:<id>:title`): no endpoint returns another user's. `archived`: the archived chats instead of the live ones.
  // Modules add fields and filters (projects: projectId, folderId, position, `project: <id>`; schedules: scheduled).
  list: authed.input(z.looseObject({ archived: z.boolean().optional() }).optional()).query(({ ctx: { me }, input }) => {
    const lists = active().flatMap((m) => (m.conversation?.list ? [m.conversation.list] : []));
    const filters = lists.flatMap((l) => l.filter?.((k) => (typeof input?.[k] === 'string' ? (input[k] as string) : undefined)) ?? []);
    return (db.prepare(`SELECT c.id, c.title, c.model, c.thinking, c.accept_messages AS acceptMessages, c.pinned, c.agent, c.view, c.assistant_id AS assistantId, c.flow, ${lists.flatMap((l) => l.select ?? []).map((s) => `${s}, `).join('')}c.archived_at AS archivedAt, c.created_at AS createdAt, ${ACTIVITY_SQL} AS updatedAt
      FROM conversations c WHERE c.user_id = ? AND c.parent_id IS NULL AND c.hidden IS NULL AND c.archived_at IS ${input?.archived ? 'NOT' : ''} NULL ${filters.map((f) => f.sql).join(' ')} ORDER BY c.created_at DESC`).all(me.id, ...filters.flatMap((f) => f.args) as any[]) as any[])
      .map((r) => Object.assign({ ...r, flow: !!r.flow, pinned: !!r.pinned, acceptMessages: !!r.acceptMessages, title: openForUser(me.id, r.title, `conv:${r.id}:title`) }, ...lists.map((l) => l.fields?.(r) ?? {})));
  }),

  // What the caller's chats are doing now (idle ones are absent): { [id]: { state: 'running' | 'waiting', since?, label?, agents? } }. Own chats only, no message content.
  activity: authed.query(({ ctx: { me } }) => activityOf(me.id)),

  // assistantId: the Assistant to chat with (see assistants.*); without one (and without a raw `agent`) it is the default Assistant. An Assistant that runs on a CLI agent
  // decides the conversation's agent (a client `agent` is ignored) and grants its sandbox to the roles it lists; a raw `agent` needs sandbox.shell and the agent's own roles.
  create: use.input(z.looseObject({ title: z.string().optional(), agent: z.string().max(64).optional(), view: z.enum(['chat', 'terminal']).optional(), assistantId: z.string().max(64).optional() }).optional()).mutation(async ({ ctx: { me }, input }) => {
    const b = input ?? {}, { title } = b;
    // Modules may refuse, add columns to the row and fields to the answer.
    const columns: Record<string, unknown> = {}, extra: Record<string, unknown> = {};
    const aid = b.assistantId ?? (b.agent ? undefined : defaultAssistantId());
    let asst = aid ? getAssistant(aid) : undefined;
    if (b.assistantId && !asst) bad('unknown assistant');
    if (asst) {
      if (!mayUseBy(asst, me.id, me.roleId)) fail('This assistant is not available to you.', 'FORBIDDEN');
      if (b.assistantId) { // the implicit default may be created before an agent is set up (sending then says so)
        const av = await assistantAvailability(me.id, asst);
        if (!av.available) fail(av.reason, 'FORBIDDEN');
      }
      if (!asst.simple || !asst.agent) { if (b.assistantId) bad('This assistant has no agent.'); asst = undefined; } // a retired flow Assistant or an unset default: a plain Claude Code chat
    }
    if (asst) { Object.assign(columns, { assistant_id: asst.id }); Object.assign(extra, { assistantId: asst.id }); }
    // Every chat is a hosted CLI agent (default Claude Code, `claude-acp`); an Assistant decides the agent, a raw `agent` needs the sandbox.
    const agent = canonicalAgent(asst?.agent ?? b.agent ?? DEFAULT_AGENT); // the legacy id `claude-code` is Claude Code from the registry
    if (!profileOf(agent)) bad('unknown agent');
    if (!asst && b.agent) {
      if (!shellEnabled(me.id)) fail('This agent needs the sandbox, which is not available to you.', 'FORBIDDEN');
      if (!usableAgents(me.roleId).some((r) => r.id === agent)) fail('This agent is not available to you. Ask your administrator.', 'FORBIDDEN');
    }
    Object.assign(columns, { agent, view: b.view ?? 'chat' });
    Object.assign(extra, { agent, view: b.view ?? 'chat' });
    for (const m of active()) {
      const r = m.conversation?.create?.({ me, body: b });
      if (!r) continue;
      if (r.error) fail(r.error[0], r.error[1] === 403 ? 'FORBIDDEN' : 'BAD_REQUEST');
      Object.assign(columns, r.columns);
      Object.assign(extra, r.response);
    }
    const cid = `u_${me.id}_${ulid()}`, now = new Date().toISOString(), cols = Object.keys(columns); // column names come from module code, never from the request
    db.prepare(`INSERT INTO conversations (id, user_id, title, created_at, updated_at${cols.map((k) => `, ${k}`).join('')}) VALUES (?, ?, ?, ?, ?${cols.map(() => ', ?').join('')})`)
      .run(cid, me.id, sealForUser(me.id, String(title || 'New chat').slice(0, 80), `conv:${cid}:title`), now, now, ...cols.map((k) => columns[k] as any));
    return { id: cid, ...extra };
  }),

  // Conversation model: company models or the user's own connections only.
  update: use.input(z.looseObject({
    id, model: z.string().nullable().optional(), thinking: z.string().nullable().optional(), acceptMessages: z.boolean().optional(), title: z.string().optional(), pinned: z.boolean().optional(), archived: z.boolean().optional(), view: z.enum(['chat', 'terminal']).optional(),
  })).mutation(({ ctx: { me }, input }) => {
    const { id: cid, model, thinking, acceptMessages, title, pinned, archived, view } = input;
    owned(me, cid);
    // models are the admin's choice (they ride on the Assistant): only models.manage may pick a model or an effort for a chat
    if ((model !== undefined || thinking !== undefined) && !me.permissions.includes('models.manage')) fail('Only an administrator can change the model of a chat.', 'FORBIDDEN');
    const moduleKeys = active().flatMap((m) => m.conversation?.patch?.keys ?? []); // the fields modules own (projects: projectId, folderId, position)
    if ([model, thinking, acceptMessages, title, pinned, archived, view, ...moduleKeys.map((k) => input[k])].every((x) => x === undefined)) bad('model, thinking, acceptMessages, title, pinned, archived, view or projectId is required');
    if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(cid)) fail('not found', 'NOT_FOUND');
    const metaError = chatMeta(me.id, cid, { title, pinned, archived, ...Object.fromEntries(moduleKeys.map((k) => [k, input[k]])) });
    if (metaError) bad(metaError);
    if (model && !availableModels(me.id).some((m) => m.id === model)) fail('This model is not available to you.', 'FORBIDDEN');
    if (!validThinking(thinking)) bad('thinking must be one of off, minimal, low, medium, high, xhigh, max');
    if (view !== undefined && !db.prepare('SELECT 1 FROM conversations WHERE id = ? AND agent IS NOT NULL').get(cid)) bad('view only applies to a chat with an agent');
    if (view !== undefined) db.prepare('UPDATE conversations SET view = ? WHERE id = ?').run(view, cid);
    if (model !== undefined) db.prepare('UPDATE conversations SET model = ? WHERE id = ?').run(model, cid);
    if (thinking !== undefined) db.prepare('UPDATE conversations SET thinking = ? WHERE id = ?').run(thinking || null, cid);
    if (acceptMessages !== undefined) db.prepare('UPDATE conversations SET accept_messages = ? WHERE id = ?').run(acceptMessages ? 1 : 0, cid);
    return { ok: true, model, thinking, acceptMessages, view };
  }),

  delete: use.input(z.object({ id })).mutation(({ ctx: { me }, input }) => {
    owned(me, input.id);
    if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(input.id)) fail('not found', 'NOT_FOUND');
    purgeConversations(me.id, [input.id]);
    return { ok: true };
  }),

  // { ids, action: 'delete' | 'archive' | 'unarchive' | a module's action (folders: 'move' with folderId; projects: 'moveToProject' with projectId) }. All ids must be the caller's, or nothing happens.
  bulk: use.input(z.looseObject({ ids: z.array(z.string()).min(1, 'ids must be a list of 1-500 conversation ids').max(500, 'ids must be a list of 1-500 conversation ids'), action: z.string() })).mutation(({ ctx: { me }, input: b }) => {
    const extra = Object.assign({}, ...active().map((m) => m.conversation?.bulk ?? {})) as NonNullable<NonNullable<ReturnType<typeof active>[number]['conversation']>['bulk']>;
    const actions = [...BULK, ...Object.keys(extra)];
    if (!actions.includes(b.action)) bad(`action must be ${actions.join(', ').replace(/, ([^,]*)$/, ' or $1')}`);
    const mod = Object.hasOwn(extra, b.action) ? extra[b.action] : undefined;
    const error = mod?.validate({ userId: me.id }, b);
    if (error) bad(error);
    const uniq = [...new Set(b.ids)];
    if (!uniq.every((x) => userOfConversation(x) === me.id)) fail('forbidden', 'FORBIDDEN');
    const found = uniq.filter((x) => db.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?').get(x, me.id));
    if (b.action === 'delete') purgeConversations(me.id, found);
    else for (const x of found) chatMeta(me.id, x, mod ? mod.meta(b) : { archived: b.action === 'archive' });
    return { ok: true, count: found.length };
  }),
});
