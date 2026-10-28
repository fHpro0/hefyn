import { rowOf } from '../cli-agents/installed.ts';
import { canonicalAgent, profileOf } from '../cli-agents/profiles.ts';
import { type ResolvedHelper, roleSlug } from '../cli-agents/session-config.ts';
import { db } from './appdb.ts';
import { chatBundle } from './assistant-bundle.ts';
import { type Assistant, conversationAssistant } from './assistants.ts';
import { agentConnectors } from './mcp.ts';
import { offIds, sessionSkills } from './skills.ts';

// What a conversation's agent gets besides the model: skills, MCP servers and helpers.
// An Assistant chat gets exactly what the Assistant names; a chat on a plain agent gets the person's own and the team's skills and servers that are switched on (default on).

/** The conversation's Assistant, if it runs on the conversation's agent (a chat on another agent is a plain chat). */
export function assistantFor(conversationId: string): Assistant | undefined {
  const c = db.prepare('SELECT agent FROM conversations WHERE id = ?').get(conversationId) as { agent: string | null } | undefined;
  const a = conversationAssistant(conversationId);
  if (a?.agent && c?.agent && canonicalAgent(a.agent) === canonicalAgent(c.agent)) return a;
}

/** The MCP servers this conversation's agent may reach through the bridge: the proxy refuses every other id, whatever the sandbox's config says. */
export function mcpFor(userId: string, conversationId: string): { id: string; name: string }[] {
  const a = assistantFor(conversationId), usable = agentConnectors(userId);
  if (a) { const want = new Set(a.mcp); return usable.filter((c) => want.has(c.id)); }
  const off = offIds(userId, 'mcp');
  return usable.filter((c) => !off.has(c.id));
}

/** The Assistant's helpers whose agent is installed, ready and on; one per role. */
export function resolveHelpers(a: Pick<Assistant, 'helpers'>): ResolvedHelper[] {
  const out: ResolvedHelper[] = [];
  for (const h of a.helpers) {
    const id = canonicalAgent(h.agent), profile = profileOf(id), row = rowOf(id), slug = roleSlug(h.role);
    if (profile && row?.status === 'ready' && row.enabled && slug && !out.some((x) => x.slug === slug)) out.push({ role: h.role, slug, profile, version: row.version, provider: h.provider ?? null, model: h.model ?? null, edit: !!h.edit });
  }
  return out;
}

export function sessionItems(userId: string, conversationId: string) {
  const a = assistantFor(conversationId), bundle = a ? chatBundle(conversationId) : undefined;
  return {
    assistant: a,
    bundle,
    instructions: a?.instructions,
    skills: [...sessionSkills(userId, a?.skills), ...(bundle?.skills ?? [])], // the Assistant's own skills come from its bundle; team skills are only ids
    mcp: mcpFor(userId, conversationId).map((c) => ({ name: c.name, path: `/mcp/${c.id}` })),
    helpers: a ? resolveHelpers(a) : [],
  };
}
