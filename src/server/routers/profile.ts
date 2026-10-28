import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { validThinking } from '../agent-prefs.ts';
import { db, syncSimpleFlow } from '../appdb.ts';
import { defaultAssistantId, loadProfile } from '../profile.ts';
import { connectedModels } from '../providers.ts';
import { perm, router } from '../trpc.ts';

// profile.*: the team's default profile (legacy model / thinking and the per-agent overrides). models.manage.
const manage = perm('models.manage');
const bad = (message: string): never => { throw new TRPCError({ code: 'BAD_REQUEST', message }); };
const levels = z.record(z.string(), z.string().nullable());

export const profileRouter = router({
  get: manage.query(() => loadProfile()),
  update: manage.input(z.object({ model: z.string(), agents: levels.optional(), thinking: z.string().nullable().optional(), agentThinking: levels.optional() })).mutation(({ input: { model, agents, thinking, agentThinking } }) => {
    const known = new Set(connectedModels().flatMap((p) => p.models.map((m) => m.id)));
    if (!known.has(model)) bad('Pick a model from a connected provider.');
    for (const m of Object.values(agents ?? {})) if (m && !known.has(m)) bad(`Unknown model ${m}`);
    for (const t of [thinking, ...Object.values(agentThinking ?? {})]) if (!validThinking(t)) bad(`Unknown thinking level ${t}`);
    const pid = defaultAssistantId();
    db.prepare('UPDATE profiles SET model = ? WHERE id = ?').run(model, pid);
    if (thinking !== undefined) db.prepare('UPDATE profiles SET thinking = ? WHERE id = ?').run(thinking || null, pid);
    for (const [name, m] of Object.entries(agents ?? {})) db.prepare('UPDATE profile_agents SET model = ? WHERE profile_id = ? AND name = ?').run(m || null, pid, name);
    for (const [name, t] of Object.entries(agentThinking ?? {})) db.prepare('UPDATE profile_agents SET thinking = ? WHERE profile_id = ? AND name = ?').run(t || null, pid, name);
    syncSimpleFlow(pid); // the default Assistant's flow follows its columns
    return { ok: true };
  }),
});
