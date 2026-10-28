import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { WIRE_APIS, type AgentSpec } from '../modules/agent-manifest.ts';

// Which model providers a hosted agent can run on. A provider (a row of `providers`: openai, openrouter, mistral, a custom endpoint ...) is served to an agent over
// one of the gateway's wire APIs; an agent lists the APIs it speaks (manifest `providers`, else its `api`). Pure: no database here.

export type WireApi = (typeof WIRE_APIS)[number];
export const CUSTOM = 'custom'; // the id a custom OpenAI-compatible endpoint is connected under (server/providers.ts)

// The OpenAI-compatible (chat completions) base of providers whose catalog entry names another one. Others: the catalog's, when it is an openai-completions one.
const CHAT_BASE: Record<string, string> = { openai: 'https://api.openai.com/v1', openrouter: 'https://openrouter.ai/api/v1', mistral: 'https://api.mistral.ai/v1', xai: 'https://api.x.ai/v1' };
/** The base URL for `POST <base>/chat/completions` of a built-in provider (a custom one has the admin's), undefined = not OpenAI-compatible. */
export function chatBase(id: string): string | undefined {
  if (CHAT_BASE[id]) return CHAT_BASE[id];
  const m = builtinProviders().find((p) => p.id === id)?.getModels()[0] as { api?: string; baseUrl?: string } | undefined;
  return m?.api === 'openai-completions' ? m.baseUrl : undefined;
}
/** The wire APIs a provider can be served over. Anthropic only speaks Messages; OpenAI both of its APIs; everything else the chat completions one. */
export const providerApis = (id: string): WireApi[] => (id === 'anthropic' ? ['anthropic'] : id === 'openai' ? ['openai-responses', 'openai-chat'] : id === CUSTOM || chatBase(id) ? ['openai-chat'] : []);
/** The provider an agent uses when none was chosen (every agent's first API). */
export const defaultProvider = (api: WireApi) => (api === 'anthropic' ? 'anthropic' : 'openai');
export const agentApis = (spec: Pick<AgentSpec, 'api' | 'providers'>): WireApi[] => spec.providers?.map((p) => p.api) ?? [spec.api];
/** The API the agent talks to `provider` over, undefined = it cannot use that provider. */
export const wireFor = (spec: Pick<AgentSpec, 'api' | 'providers'>, provider: string): WireApi | undefined => agentApis(spec).find((a) => providerApis(provider).includes(a));
export const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/; // what may reach a seeded config file
