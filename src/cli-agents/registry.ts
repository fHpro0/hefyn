import snapshot from './registry-snapshot.json' with { type: 'json' };

// The ACP Registry (https://github.com/agentclientprotocol/registry): which agents exist and how they are distributed. Fetched by the web process (it has
// internet; no allowlist is involved: the egress proxy only fronts the agent process), cached for an hour, with a bundled snapshot of the supported agents
// so a server without internet still lists them. What the registry says is only ever used to pick a pinned package or a checksummed download.

export interface RegistryAgent {
  id: string; name: string; version: string; description: string; repository?: string; authors?: string[]; license?: string; license_url?: string; icon?: string;
  distribution: { npx?: { package: string; args?: string[]; env?: Record<string, string> }; binary?: Record<string, { archive: string; cmd: string; args?: string[]; sha256?: string }>; [other: string]: unknown };
}
export interface Catalog { agents: RegistryAgent[]; source: 'live' | 'cache' | 'snapshot' }

const URL_ = () => process.env.HEFYN_ACP_REGISTRY_URL || 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const TTL = 60 * 60_000;
let cached: { at: number; agents: RegistryAgent[] } | undefined;

/** Keep only entries with the shape the install code relies on; a malformed one is dropped, not trusted. */
export function parseRegistry(j: unknown): RegistryAgent[] {
  const list = (j as { agents?: unknown })?.agents;
  if (!Array.isArray(list)) throw new Error('not an ACP registry');
  const s = (v: unknown) => typeof v === 'string' && v.length > 0;
  return list.filter((a): a is RegistryAgent => !!a && typeof a === 'object' && s(a.id) && s(a.name) && s(a.version) && !!a.distribution && typeof a.distribution === 'object');
}

export const bundledRegistry = () => parseRegistry(snapshot);

// Claude Code is not an ACP adapter any more: hefyn installs the official `@anthropic-ai/claude-code` package. The ACP Registry's `claude-acp` (the adapter) is
// replaced by it, at npm's `latest` while npm answers, else the bundled pinned version. Installs and updates still pin an exact version (the runner insists).
const CLAUDE_PKG = '@anthropic-ai/claude-code';
async function withClaudeCode(agents: RegistryAgent[]): Promise<RegistryAgent[]> {
  const own = bundledRegistry().find((a) => a.id === 'claude-acp')!;
  let version = own.version;
  // HEFYN_NPM_REGISTRY_URL names another npm registry (a mirror); a deployment that points the ACP Registry elsewhere (tests, air-gapped) gets the bundled version unless it names one too
  const npm = process.env.HEFYN_NPM_REGISTRY_URL ?? (process.env.HEFYN_ACP_REGISTRY_URL ? undefined : 'https://registry.npmjs.org');
  try {
    if (!npm) throw new Error('bundled');
    const r = await fetch(`${npm.replace(/\/$/, '')}/${CLAUDE_PKG.replace('/', '%2f')}/latest`, { signal: AbortSignal.timeout(6000) });
    const v = r.ok ? ((await r.json()) as { version?: unknown }).version : undefined;
    if (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)) version = v;
  } catch { /* npm unreachable: the bundled version */ }
  return [...agents.filter((a) => a.id !== 'claude-acp'), { ...own, version, distribution: { npx: { package: `${CLAUDE_PKG}@${version}` } } }];
}

// shortcut: pinned to 1.x, upgrade when 2.x is supported. OpenCode 2.x is a rewrite (new CLI, a background service by default, `--standalone` for a private server; the
// `debug agent` command and the 1.x tool names the permission tests rely on are gone), not checked against hefyn's config or ACP use. A 2.x registry entry is replaced by the bundled 1.x one.
const withOpenCode1 = (agents: RegistryAgent[]): RegistryAgent[] => agents.map((a) => (a.id === 'opencode' && !/^1\./.test(a.version) ? bundledRegistry().find((b) => b.id === 'opencode') ?? a : a));

export async function registry(now = Date.now()): Promise<Catalog> {
  if (cached && now - cached.at < TTL) return { agents: cached.agents, source: 'cache' };
  try {
    const res = await fetch(URL_(), { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cached = { at: now, agents: await withClaudeCode(withOpenCode1(parseRegistry(await res.json()))) };
    return { agents: cached.agents, source: 'live' };
  } catch {
    if (cached) { cached.at = now - TTL + 5 * 60_000; return { agents: cached.agents, source: 'cache' }; } // stale beats nothing; retry in 5 minutes
    cached = { at: now - TTL + 5 * 60_000, agents: bundledRegistry() };
    return { agents: cached.agents, source: 'snapshot' };
  }
}
export const resetRegistryCache = () => { cached = undefined; };
