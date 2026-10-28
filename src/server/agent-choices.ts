import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { defaultProvider, wireFor } from '../cli-agents/providers.ts';
import type { AgentProfile } from '../cli-agents/profiles.ts';
import { db } from './appdb.ts';
import { build, modelMeta } from './providers.ts';

// What an agent can run on: the connected (company, API-key) providers its API list covers, each with its models. Shared by assistants.options (the agent step) and
// agents.models (the admin's default per agent). Model ids are the provider's own (bare), never `provider/model`.

export interface ModelChoice { id: string; name: string; contextWindow?: number; reasoning: boolean; vision: boolean }
export interface ProviderChoice { id: string; name: string; connected: boolean; /** why it cannot be picked */ reason?: string; models: ModelChoice[] }

const NAMES: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

/** The providers `profile` can use. The agent's own API's provider (Anthropic / OpenAI) is always listed first, with a reason when no key is connected. */
export function providerChoices(profile: AgentProfile): ProviderChoice[] {
  const rows = db.prepare("SELECT id, name, base_url, models FROM providers WHERE kind != 'oauth'").all() as { id: string; name: string; base_url: string | null; models: string | null }[];
  const out: ProviderChoice[] = [];
  for (const r of rows) {
    if (!wireFor(profile.spec, r.id)) continue;
    let models: ModelChoice[] = [];
    try { models = build({ id: r.id, baseUrl: r.base_url ?? undefined, models: r.models ? JSON.parse(r.models) : undefined }, 'x').getModels().map((m: any) => ({ id: m.id as string, name: m.name as string, ...modelMeta(m) })); } catch { /* a custom provider without models */ }
    out.push({ id: r.id, name: NAMES[r.id] ?? r.name, connected: true, models });
  }
  const first = defaultProvider(profile.api);
  if (!out.some((p) => p.id === first)) out.push({ id: first, name: NAMES[first]!, connected: false, reason: `No ${NAMES[first]} API key is connected yet. Connect one under Settings, Agents & keys.`, models: [] });
  return out.sort((a, b) => Number(b.id === first) - Number(a.id === first) || a.name.localeCompare(b.name));
}

/** `provider` / `model` of an agent step (or an admin default) checked against what is connected; a plain message when not. Unset provider = the agent's own API's. */
export function checkChoice(profile: AgentProfile, provider: unknown, model: unknown, who: string): string | undefined {
  if (provider != null && typeof provider !== 'string') return `${who}: the provider is not valid.`;
  if (model != null && typeof model !== 'string') return `${who}: the model is not valid.`;
  const id = provider || defaultProvider(profile.api);
  if (provider && !wireFor(profile.spec, id)) return `${profile.name} cannot run on that provider.`;
  const pc = providerChoices(profile).find((p) => p.id === id);
  if (provider && !pc?.connected) return `${who}: no API key is connected for ${pc?.name ?? NAMES[id] ?? builtinProviders().find((p) => p.id === id)?.name ?? id}. Connect one under Settings, Agents & keys.`;
  if (model && !pc?.models.some((m) => m.id === model)) return `${profile.name} cannot use the model chosen in ${who}${provider ? ` on ${pc?.name ?? id}` : ''}.`;
}
