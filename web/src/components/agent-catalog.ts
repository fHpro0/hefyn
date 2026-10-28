export type AgentSource = { type: 'builtin' } | { type: 'hub'; name: string } | { type: 'upload' };
export interface CatalogAgent {
  id: string; name: string; description: string; icon: string;
  /** The agent's own version (Claude Code 2.1.310); `adapterVersion` is its ACP adapter's (0.96.0). */
  version: string; adapterVersion: string; license: string; licenseUrl: string;
  api: 'anthropic' | 'openai-responses'; actsWithoutAsking?: boolean; source: AgentSource;
  installed: null | { version: string; status: 'installing' | 'ready' | 'failed'; error?: string };
  enabled: boolean; roles: string[]; keyProvider: string | null; /** the provider and model chats on this agent without an Assistant run on; null = the agent's own choice */ defaultProvider?: string | null; defaultModel?: string | null; updateAvailable: string | null;
  autoUpdate: boolean; lastChecked: string | null; lastUpdateError: { message: string; at: string | null } | null;
  /** The version being installed next to the current one; the agent stays usable. */
  updating: string | null;
}

/** Said wherever an agent without a permission mechanism (manifest `asksBeforeActing: false`) is installed, enabled or picked. */
export const actsWithoutAskingText = (name: string) => `${name} edits files and runs commands in the user’s sandbox without asking first.`;

/** Where an agent comes from, in words. */
export const sourceLabel = (s: CatalogAgent['source']) => (s.type === 'builtin' ? 'Built in' : s.type === 'hub' ? `Agent module from the Hub: ${s.name}` : 'Agent module added by an admin');

// The key provider each agent API speaks to.
export const API_PROVIDER = { anthropic: 'anthropic', 'openai-responses': 'openai' } as const;

/** Legacy conversations store 'claude-code'; the agent is now 'claude-acp'. */
export const agentId = (id: string) => (id === 'claude-code' ? 'claude-acp' : id);

/** Agents that draw on a given key provider: pinned to it, or on automatic with a matching API. */
export const usedBy = (list: CatalogAgent[], provider: string) =>
  list.filter((a) => a.installed && (a.keyProvider ? a.keyProvider === provider : !!a.api && API_PROVIDER[a.api] === provider)).map((a) => a.name);
