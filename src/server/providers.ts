import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { Provider } from '@earendil-works/pi-ai';
import { db } from './appdb.ts';
import { withStamp } from './context.ts';
import { decrypt, encrypt } from './crypto.ts';
import { requestRestart } from './runtime.ts';

export const CUSTOM = 'custom';
// Ambient-credential or OAuth-only providers: no plain API key to paste.
const SKIP = new Set(['amazon-bedrock', 'google-vertex', 'azure', 'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'radius', 'github-copilot', 'openai-codex', 'faux']);

export const listProviders = () => [
  ...builtinProviders().filter((p) => !SKIP.has(p.id) && p.auth.apiKey).map((p) => ({ id: p.id, name: p.name })),
  { id: CUSTOM, name: 'Custom OpenAI-compatible' },
];

interface Conn { id: string; baseUrl?: string; models?: string[] }

// `key` is a plain API key or a resolver (per-user OAuth refreshes tokens there); `asId` namespaces per-user providers.
export type AuthResolver = () => Promise<{ auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string } }>;
export function build(c: Conn, key: string | AuthResolver, asId = c.id): Provider {
  const resolve = typeof key === 'string' ? async () => ({ auth: { apiKey: key } }) : key;
  const auth = { apiKey: { name: 'hefyn', resolve } } as any;
  if (c.id === CUSTOM) {
    if (!c.baseUrl || !c.models?.length) throw new Error('Custom providers need a base URL and at least one model id.');
    return createProvider({
      id: asId, name: 'Custom', baseUrl: c.baseUrl, auth, api: openAICompletionsApi(),
      models: c.models.map((id) => ({ id, name: id, api: 'openai-completions', provider: asId, baseUrl: c.baseUrl!, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 })),
    } as any);
  }
  const base = builtinProviders().find((p) => p.id === c.id);
  if (!base) throw new Error(`Unknown provider: ${c.id}`);
  const remap = (ms: readonly any[]) => (c.baseUrl || asId !== c.id ? ms.map((m) => ({ ...m, provider: asId, ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}) })) : ms);
  return { ...base, id: asId, auth, getModels: () => remap(base.getModels()), getAllModels: () => remap(base.getAllModels?.() ?? base.getModels()) } as Provider;
}

// Cheap key check: only a definite 401/403 rejects; network trouble or unknown shapes are accepted.
export async function validate(c: Conn, apiKey: string) {
  const p = build(c, apiKey);
  const m = p.getModels()[0] as any;
  const root = (c.baseUrl ?? m?.baseUrl ?? '').replace(/\/$/, '');
  const url = m?.api === 'anthropic-messages' ? `${root}/v1/models` : m?.api?.startsWith('openai') ? `${root}/models` : undefined;
  if (!url) return;
  const headers: Record<string, string> = m.api === 'anthropic-messages' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${apiKey}` };
  const res = await withStamp('auth', () => fetch(url, { headers, signal: AbortSignal.timeout(8000) })).catch(() => undefined); // key check only: no user content
  if (res && (res.status === 401 || res.status === 403)) throw new Error('The provider rejected this API key.');
}

export function connect(c: Conn, apiKey: string) {
  db.prepare('INSERT OR REPLACE INTO providers (id, name, base_url, enc_key, models, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(c.id, listProviders().find((p) => p.id === c.id)?.name ?? c.id, c.baseUrl ?? null, encrypt(apiKey), c.models ? JSON.stringify(c.models) : null, new Date().toISOString());
}

// There is no public unregister in Flue: the agent process only forgets a removed provider by restarting.
export function disconnect(id: string) {
  db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  requestRestart('system: provider removed');
}

export const connectedIds = () => (db.prepare('SELECT id FROM providers').all() as { id: string }[]).map((r) => r.id);

export function connectedModels() {
  return (db.prepare('SELECT id, name, base_url, enc_key, models FROM providers').all() as any[]).map((r) => {
    const p = build({ id: r.id, baseUrl: r.base_url ?? undefined, models: r.models ? JSON.parse(r.models) : undefined }, 'x');
    return { provider: r.id, name: r.name, models: p.getModels().map((m) => ({ id: `${r.id}/${m.id}`, name: m.name })) };
  });
}
