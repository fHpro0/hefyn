import { allRows, usableAgents } from '../cli-agents/installed.ts';
import { canonicalAgent, profileOf } from '../cli-agents/profiles.ts';
import { THINKING_LEVELS, validThinking } from '../server/agent-prefs.ts';
import { db } from '../server/appdb.ts';
import { skillIdsOf } from '../server/hub.ts';
import { checkChoice } from '../server/agent-choices.ts';
import { connectedModels } from '../server/providers.ts';
import { shellEnabled } from '../server/runner.ts';
import { type FlowError, checkGraph, isSimple, label } from './flow.ts';

// validateFlow: what a simple preset (trigger -> one CLI agent -> reply, flow.ts simpleFlow) needs checked, the things that depend on who saves and what exists right now.
// The flow builder's other step types moved to old/ (old/src/assistants/validate.ts). Messages are plain words for the person editing.

export type Api = 'anthropic' | 'openai-responses';
const API_PROVIDER = { anthropic: 'anthropic', 'openai-responses': 'openai' } as const;
/** The models an agent API can use, bare ids, from connected company providers. */
export function modelsFor(api: Api) {
  const p = connectedModels().find((x) => x.provider === API_PROVIDER[api]);
  return (p?.models ?? []).map((m) => ({ id: m.id.slice(p!.provider.length + 1), name: m.name }));
}
export const skillPackages = () => db.prepare("SELECT id, name, description FROM packages WHERE kind = 'skill' AND visibility = 'team' AND approved_json IS NOT NULL ORDER BY name").all() as { id: string; name: string; description: string }[];

export interface Who { userId: string; roleId: string | undefined; /** the scope the Assistant will have: a team one may only use team things */ scope: 'private' | 'team'; selfId?: string }

export function validateFlow(raw: unknown, who: Who): FlowError[] {
  const g = checkGraph(raw);
  if (!g.flow) return g.errors;
  if (g.errors.length) return g.errors;
  if (!isSimple(g.flow)) return [{ message: 'Assistants are simple presets of a CLI agent now: a name, an agent, instructions and skills.' }];
  const errors: FlowError[] = [];
  const n = g.flow.nodes.find((x) => x.type === 'agent')!, c = n.config, L = `"${label(n)}"`;
  const err = (message: string) => errors.push({ node: n.id, message });
  const agent = c.agent ? canonicalAgent(String(c.agent)) : null, profile = agent ? profileOf(agent) : undefined;
  if (!agent) err('Pick an agent: Assistants run on a CLI agent such as Claude Code.');
  else if (!profile || !allRows().some((r) => r.status === 'ready' && r.id === agent)) err(`${L} uses an agent that is not installed.`);
  else if (who.scope === 'private' && !(shellEnabled(who.userId) && usableAgents(who.roleId).some((r) => r.id === agent))) err(`You cannot use ${profile.name} in your own Assistants: it needs the sandbox and access to that agent. Ask your administrator.`);
  if (c.instructions != null && (typeof c.instructions !== 'string' || c.instructions.length > 20_000)) err(`The instructions can be at most 20 000 characters.`);
  if (Array.isArray(c.subAgents) && c.subAgents.length) err('Helpers are not available any more; a CLI agent has its own sub-agents.');
  if (profile) { const m = checkChoice(profile, c.provider, c.model, L); if (m) err(m); } // Agent -> Provider -> Model (no provider: the agent's own API's)
  if (!validThinking(c.thinking)) err(`The thinking level is unknown (use one of ${THINKING_LEVELS.join(', ')}).`);
  // a team Assistant may only use team skills; a private one also the owner's own
  const skills = new Set(who.scope === 'team' ? skillPackages().map((s) => s.id) : skillIdsOf(who.userId));
  if (!Array.isArray(c.skills) || c.skills.some((s: unknown) => typeof s !== 'string' || !skills.has(s))) err(who.scope === 'team' ? 'A skill is not an approved team skill.' : 'A skill is neither yours nor the team\'s.');
  return errors;
}
