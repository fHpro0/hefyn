import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { db } from './appdb.ts';
import { decrypt } from './crypto.ts';
import { hostKey } from './netguard.ts';

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
  for (const r of db.prepare('SELECT provider, base_url, enc FROM user_credentials').all() as any[]) {
    provider(r.provider, r.base_url);
    try { if (JSON.parse(decrypt(r.enc)).type === 'oauth') (OAUTH_HOSTS[r.provider] ?? []).forEach((h) => out.add(`${h}:443`)); } catch { /* unreadable credential */ }
  }
  // Storage add-ons (WebDAV): the proxy cannot tell users apart, so a connected add-on host is reachable for every agent request.
  for (const r of db.prepare("SELECT url FROM storage_addons WHERE url IS NOT NULL").all() as any[]) out.add(hostKey(r.url));
  for (const r of db.prepare('SELECT url, enc FROM mcp_connectors').all() as any[]) {
    out.add(hostKey(r.url));
    // OAuth connectors also talk to their authorization server (discovery state holds its URLs).
    try { for (const u of (r.enc ? decrypt(r.enc) : '').match(/https?:\/\/[^"\\]+/g) ?? []) out.add(hostKey(u)); } catch { /* ignore */ }
  }
  return [...out].filter((k): k is string => !!k);
}
