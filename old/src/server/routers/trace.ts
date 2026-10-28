import { createFlueClient, type FlueConversationMessage, type FlueConversationSettlement } from '@flue/sdk';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { moduleInstructions } from '../../modules/active.ts';
import { db } from '../appdb.ts';
import { agentHeaders, ChatLinkError } from '../chat-links.ts';
import { loadProfile } from '../profile.ts';
import { AGENT_URL } from '../runtime.ts';
import { authed, router } from '../trpc.ts';
import { userOfConversation } from '../usage.ts';
import { LockedError, openForUser } from '../vault.ts';

// Developer trace of one chat: the Flue history plus, per model call, the recorded usage. Owner only; anyone else gets NOT_FOUND.

export const traceDeps = {
  /** Replaceable in tests. */
  async history(userId: string, id: string): Promise<{ messages: FlueConversationMessage[]; settlements: FlueConversationSettlement[] }> {
    const s = await createFlueClient({ url: `${AGENT_URL}/agents/configurable/${id}`, headers: agentHeaders(userId) }).history();
    return { messages: s.messages, settlements: s.settlements };
  },
};

const notFound = () => new TRPCError({ code: 'NOT_FOUND', message: 'not found' });

export const traceRouter = router({
  get: authed.input(z.object({ id: z.string() })).query(async ({ ctx: { me: { id: me }, c }, input: { id } }) => {
    c.header('Cache-Control', 'no-store'); // personal data
    if (userOfConversation(id) !== me) throw notFound();
    const conv = db.prepare('SELECT title, model, created_at FROM conversations WHERE id = ? AND user_id = ?').get(id, me) as { title: string; model: string | null; created_at: string } | undefined;
    if (!conv) throw notFound();
    // One model call per usage row (stamped when the call ends).
    const used = db.prepare('SELECT id, provider, model, input, output, cache_read AS cacheRead, cache_write AS cacheWrite, cost, ts FROM usage WHERE user_id = ? AND conversation_id = ? ORDER BY ts, id').all(me, id) as any[];
    const calls = used.map((u) => ({ id: u.id, provider: u.provider, model: u.model, ts: u.ts, usage: u }));
    let history: Awaited<ReturnType<typeof traceDeps.history>> = { messages: [], settlements: [] }, historyError: string | undefined;
    try { history = await traceDeps.history(me, id); } catch (e) {
      if (e instanceof LockedError) throw e;
      historyError = e instanceof ChatLinkError ? e.message : 'The conversation history could not be read.';
    }
    const p = loadProfile();
    const project = moduleInstructions({ conversationId: id }).find((s) => s.id === 'project')?.text; // the projects module's section
    return {
      id, title: openForUser(me, conv.title, `conv:${id}:title`), createdAt: conv.created_at, model: conv.model ?? null,
      instructions: [{ agent: 'orchestrator', description: null, model: p.model, thinking: p.thinking, instructions: p.instructions }, ...p.agents.map((a) => ({ agent: a.name, description: a.description || null, model: a.model, thinking: a.thinking, instructions: a.instructions }))],
      projectInstructions: project ?? null,
      messages: history.messages, settlements: history.settlements, historyError: historyError ?? null, calls,
    };
  }),
});
