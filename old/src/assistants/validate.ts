import { allRows, usableAgents } from '../cli-agents/installed.ts';
import { canonicalAgent, profileOf } from '../cli-agents/profiles.ts';
import { THINKING_LEVELS, validThinking } from '../server/agent-prefs.ts';
import { db } from '../server/appdb.ts';
import { type Assistant, getAssistant, mayUseBy } from '../server/assistants.ts';
import { connectorFor } from '../server/mcp.ts';
import { checkChoice } from '../server/agent-choices.ts';
import { connectedModels } from '../server/providers.ts';
import { shellEnabled } from '../server/runner.ts';
import { LIMITS, type FlowError, NODE_ID, OPS, checkGraph, label } from './flow.ts';

// validateFlow: what checkGraph (flow.ts) cannot know, the things that depend on who saves and what exists right now. Messages are plain words for the person editing.

const API_PROVIDER = { anthropic: 'anthropic', 'openai-responses': 'openai' } as const;
export type Api = 'hefyn' | 'anthropic' | 'openai-responses';
/** The models an agent API can use, bare ids (hefyn: full `provider/model` ids), from connected company providers. */
export function modelsFor(api: Api) {
  const all = connectedModels();
  if (api === 'hefyn') return all.flatMap((p) => p.models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, reasoning: m.reasoning, vision: m.vision }))); // hefyn's picker shows the hints
  const p = all.find((x) => x.provider === API_PROVIDER[api]);
  return (p?.models ?? []).map((m) => ({ id: m.id.slice(p!.provider.length + 1), name: m.name }));
}
export const skillPackages = () => db.prepare("SELECT id, name, description FROM packages WHERE kind = 'skill' AND visibility = 'team' AND approved_json IS NOT NULL ORDER BY name").all() as { id: string; name: string; description: string }[];

export interface Who { userId: string; roleId: string | undefined; /** the scope the Assistant will have: a team one may only use team things */ scope: 'private' | 'team'; selfId?: string }

export function validateFlow(raw: unknown, who: Who): FlowError[] {
  const g = checkGraph(raw);
  if (!g.flow) return g.errors;
  const errors = [...g.errors];
  const err = (nodeId: string, message: string) => errors.push({ node: nodeId, message });
  const skills = new Set(skillPackages().map((s) => s.id));
  const ready = new Set(allRows().filter((r) => r.status === 'ready').map((r) => r.id));
  const usable = new Set(usableAgents(who.roleId).map((r) => r.id));
  for (const n of g.flow.nodes) {
    const c = n.config, L = `"${label(n)}"`, str = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
    switch (n.type) {
      case 'agent': {
        const agent = c.agent ? canonicalAgent(String(c.agent)) : null, profile = agent ? profileOf(agent) : undefined;
        if (!str(c.prompt)) err(n.id, `${L} needs a prompt: what should the agent do?`);
        if (c.instructions != null && (typeof c.instructions !== 'string' || c.instructions.length > 20_000)) err(n.id, `The instructions of ${L} can be at most 20 000 characters.`);
        if (agent) {
          if (!profile || !ready.has(agent)) err(n.id, `${L} uses an agent that is not installed.`);
          else if (who.scope === 'private' && !(shellEnabled(who.userId) && usable.has(agent))) err(n.id, `You cannot use ${profile.name} in your own Assistants: it needs the sandbox and access to that agent. Ask your administrator.`);
          if (Array.isArray(c.subAgents) && c.subAgents.length) err(n.id, `Helpers are only for hefyn; ${L} runs on ${profile?.name ?? 'another agent'}.`);
        }
        if (profile) { const m = checkChoice(profile, c.provider, c.model, L); if (m) err(n.id, m); } // Agent -> Provider -> Model (a step saved without a provider runs on the agent's own API's)
        else if (c.provider) err(n.id, `${L}: hefyn picks the provider from the model, so no provider is chosen separately.`);
        else if (c.model && !modelsFor('hefyn').some((m) => m.id === c.model)) err(n.id, `The model chosen in ${L} is not available. Pick a model from a connected provider.`);
        if (!validThinking(c.thinking)) err(n.id, `${L} has an unknown thinking level (use one of ${THINKING_LEVELS.join(', ')}).`);
        if (!Array.isArray(c.skills) || c.skills.some((s: unknown) => typeof s !== 'string' || !skills.has(s))) err(n.id, `${L} uses a skill that is not an approved team skill.`);
        if (c.output !== undefined && c.output !== 'text' && c.output !== 'json') err(n.id, `${L}: the answer format must be text or JSON.`);
        if (c.schema !== undefined && c.schema !== null && (typeof c.schema !== 'object' || Array.isArray(c.schema))) err(n.id, `The schema of ${L} must be a JSON object.`);
        for (const s of Array.isArray(c.subAgents) ? c.subAgents : []) {
          if (!s || !/^[A-Za-z0-9][\w.-]{0,63}$/.test(String(s.name)) || typeof s.description !== 'string' || typeof s.instructions !== 'string' || !Array.isArray(s.skills)) err(n.id, `A helper of ${L} is incomplete (name, description and instructions are needed).`);
          else if (s.model && !modelsFor('hefyn').some((m) => m.id === s.model)) err(n.id, `The helper "${s.name}" uses a model that is not available.`);
        }
        break;
      }
      case 'assistant': {
        const a = str(c.assistantId) ? getAssistant(String(c.assistantId)) : undefined;
        if (!str(c.prompt)) err(n.id, `${L} needs a prompt: what should it send to the other Assistant?`);
        if (!a || !mayUseBy(a, who.userId, who.roleId)) err(n.id, `${L} runs an Assistant that does not exist or that you cannot use.`);
        else if (a.id === who.selfId) err(n.id, `${L} runs this Assistant itself. An Assistant cannot call itself.`);
        else if (who.scope === 'team' && a.scope === 'private') err(n.id, `${L} runs a private Assistant; a team Assistant can only run team Assistants.`);
        else if (callsLoop(a, who.selfId)) err(n.id, `${L}: "${a.name}" runs this Assistant again, so they would call each other forever.`);
        break;
      }
      case 'router': {
        const branches = Array.isArray(c.branches) ? c.branches : [];
        if (c.mode !== 'ai' && c.mode !== 'rules') err(n.id, `${L}: choose how to route (by the model, or by rules).`);
        if (!branches.length || branches.length > LIMITS.branches) err(n.id, `${L} needs between 1 and ${LIMITS.branches} branches.`);
        const ids = new Set<string>();
        for (const b of branches) {
          if (!b || !NODE_ID.test(String(b.id)) || b.id === 'else') err(n.id, `A branch of ${L} has an invalid id (lower-case letters, digits and _; "else" is reserved).`);
          else if (ids.has(b.id)) err(n.id, `Two branches of ${L} share the id "${b.id}".`);
          else ids.add(b.id);
          if (!str(b?.label)) err(n.id, `Every branch of ${L} needs a name.`);
          if (c.mode === 'rules' && !(b?.rule && OPS.includes(b.rule.op))) err(n.id, `Branch "${b?.label ?? b?.id}" of ${L} needs a rule.`);
        }
        if (c.mode === 'ai' && !str(c.input)) err(n.id, `${L} needs the text the model should route on.`);
        if (c.model && !modelsFor('hefyn').some((m) => m.id === c.model)) err(n.id, `The model chosen in ${L} is not available.`);
        break;
      }
      case 'condition':
        if (!OPS.includes(c.op)) err(n.id, `${L} needs a comparison (${OPS.join(', ')}).`);
        break;
      case 'approval': if (!str(c.message)) err(n.id, `${L} needs a message to show the person.`); break;
      case 'ask': {
        if (!str(c.question)) err(n.id, `${L} needs a question.`);
        const names = new Set<string>();
        for (const f of Array.isArray(c.fields) ? c.fields : []) {
          if (!f || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(String(f.name)) || !str(f.label) || (f.type !== 'text' && f.type !== 'choice') || names.has(f.name) || (f.type === 'choice' && !(Array.isArray(f.options) && f.options.length))) err(n.id, `A field of ${L} is incomplete or repeated.`);
          else names.add(f.name);
        }
        break;
      }
      case 'template': if (typeof c.text !== 'string') err(n.id, `${L} needs some text.`); break;
      case 'code':
        if (c.language !== 'javascript' && c.language !== 'python') err(n.id, `${L} runs JavaScript or Python.`);
        if (!str(c.source) || c.source.length > LIMITS.source) err(n.id, `${L} needs code (at most ${LIMITS.source} characters).`);
        if (c.timeoutSec !== undefined && !(Number.isInteger(c.timeoutSec) && c.timeoutSec >= 1 && c.timeoutSec <= LIMITS.timeoutSec)) err(n.id, `The time limit of ${L} must be between 1 and ${LIMITS.timeoutSec} seconds.`);
        if (who.scope === 'private' && !shellEnabled(who.userId)) err(n.id, `${L} runs code in the sandbox, which you cannot use. Ask your administrator.`);
        break;
      case 'tool': {
        const k = str(c.connectorId) ? connectorFor(who.userId, String(c.connectorId)) : undefined;
        if (!k) err(n.id, `${L} uses a connector that does not exist or that you cannot use.`);
        else if (who.scope === 'team' && k.visibility !== 'team') err(n.id, `${L} uses your private connector "${k.name}"; a team Assistant can only use team connectors.`);
        if (!str(c.tool)) err(n.id, `${L} needs the name of the tool to call.`);
        if (c.args !== undefined && (typeof c.args !== 'object' || c.args === null || Array.isArray(c.args))) err(n.id, `The arguments of ${L} must be an object.`);
        break;
      }
      case 'output.reply': if (!str(c.text)) err(n.id, `${L} needs the text to show.`); break;
      case 'output.file': if (!str(c.path)) err(n.id, `${L} needs a file name.`); break;
    }
  }
  return errors;
}

/** Does the Assistant (through assistant steps, any depth) run `target`? */
function callsLoop(a: Assistant, target: string | undefined, seen = new Set<string>()): boolean {
  if (!target || seen.has(a.id)) return false;
  seen.add(a.id);
  return a.flow.nodes.some((n) => { if (n.type !== 'assistant') return false; const b = n.config?.assistantId ? getAssistant(String(n.config.assistantId)) : undefined; return !!b && (b.id === target || callsLoop(b, target, seen)); });
}
