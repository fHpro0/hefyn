import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { allRows } from '../cli-agents/installed.ts';
import { profileOf } from '../cli-agents/profiles.ts';
import { db } from './appdb.ts';
import { openConnectorEnc } from './mcp.ts';
import { openUserSecret } from './seal.ts';

export const hostKey = (u: string) => {
  try { const x = new URL(u); return `${x.hostname.toLowerCase()}:${x.port || (x.protocol === 'https:' ? 443 : 80)}`; } catch { return undefined; }
};

// What the agent may reach through the egress proxy, as host:port keys: connected model providers (company + per-user, custom
// endpoints included), token endpoints of providers with an OAuth sign-in, and MCP connector hosts. Built-in provider hosts are
// only listed when that provider is connected. Served to the proxy by web.ts (internal token).

const OAUTH_HOSTS: Record<string, string[]> = {
  anthropic: ['platform.claude.com'], openai: ['auth.openai.com'], 'openai-codex': ['auth.openai.com'], 'github-copilot': ['github.com', 'api.github.com', 'api.individual.githubcopilot.com'],
  'kimi-coding': ['auth.kimi.com', 'api.kimi.com'], meta: ['auth.meta.com', 'api.meta.ai'], xai: ['auth.x.ai'], openrouter: ['openrouter.ai'],
};

const builtinHostsOf = (id: string) => {
  const p = builtinProviders().find((x) => x.id === id);
  return p ? (p.getAllModels?.() ?? p.getModels()).map((m: any) => hostKey(m.baseUrl)) : [];
};

export function egressAllowlist(): string[] {
  const out = new Set<string | undefined>();
  const provider = (id: string, baseUrl: string | null) => (baseUrl ? out.add(hostKey(baseUrl)) : builtinHostsOf(id).forEach((k) => out.add(k)));
  for (const r of db.prepare('SELECT id, base_url, kind FROM providers').all() as any[]) {
    provider(r.id, r.base_url);
    if (r.kind === 'oauth') (OAUTH_HOSTS[r.id] ?? []).forEach((h) => out.add(`${h}:443`));
  }
  for (const r of db.prepare('SELECT user_id, provider, base_url, enc FROM user_credentials').all() as any[]) {
    provider(r.provider, r.base_url);
    // Locked credentials (their owner is not signed in) are unusable anyway, so their OAuth hosts stay off the list until unlock.
    try { if (JSON.parse(openUserSecret(r.user_id, r.enc, `cred:${r.user_id}:${r.provider}:${r.base_url ?? ''}`)).type === 'oauth') (OAUTH_HOSTS[r.provider] ?? []).forEach((h) => out.add(`${h}:443`)); } catch { /* unreadable credential */ }
  }
  // The proxy cannot tell users apart, so every host listed here is reachable for every agent request. Hence only what a connector needs
  // to work: its own URL and, for OAuth, the endpoints of its authorization server (https only), never any URL found in its stored state.
  for (const r of db.prepare('SELECT id, owner_id, visibility, url, enc FROM mcp_connectors').all() as any[]) {
    out.add(hostKey(r.url));
    try { for (const u of discoveryUrls(openConnectorEnc(r))) out.add(hostKey(u)); } catch { /* locked or unreadable: the connector cannot run either */ }
  }
  // An installed agent's sign-in and own-account model traffic (manifest login.hosts) leave through the agent's auth proxy, which chains through egress (own-account.ts).
  for (const r of allRows()) if (r.status === 'ready' && r.enabled) for (const h of profileOf(r.id)?.spec.login?.hosts ?? []) out.add(h);
  return [...out].filter((k): k is string => !!k);
}

const AS_FIELDS = ['issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint'];
/** The https URLs of an OAuth connector's discovery state that the OAuth flow itself calls. Input: the connector's decrypted secrets (JSON text). */
export function discoveryUrls(secrets: string): string[] {
  const d = secrets ? JSON.parse(secrets).discovery : undefined;
  if (!d || typeof d !== 'object') return [];
  const urls: unknown[] = [d.authorizationServerUrl, d.resourceMetadataUrl, ...AS_FIELDS.map((f) => d.authorizationServerMetadata?.[f]), ...(Array.isArray(d.resourceMetadata?.authorization_servers) ? d.resourceMetadata.authorization_servers : [])];
  return urls.filter((u): u is string => typeof u === 'string' && u.startsWith('https://'));
}
