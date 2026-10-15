import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore, OAuthAuth } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { db } from './appdb.ts';
import { withStamp } from './context.ts';
import { decrypt, encrypt } from './crypto.ts';
import { type AuthResolver, build, connectedModels, listProviders } from './providers.ts';

// Per-user model connectors. A user's provider `anthropic` is registered in the agent as `u-<userId>-anthropic`.
// Shared by web and agent (no Flue imports).

export const nsId = (userId: string, provider: string) => `u-${userId}-${provider}`;
const NS = /^u-([A-Za-z0-9]+)-(.+)$/;
export const ownerOfProvider = (providerId: string) => NS.exec(providerId)?.[1];

/** Dispatch rule: company providers are open to everyone, `u-<id>-…` only to its owner and only while the credential exists. */
export function providerAllowed(userId: string, providerId: string) {
  const m = NS.exec(providerId);
  if (!m) return !!db.prepare('SELECT 1 FROM providers WHERE id = ?').get(providerId);
  return m[1] === userId && !!db.prepare('SELECT 1 FROM user_credentials WHERE user_id = ? AND provider = ?').get(userId, m[2]);
}
export const modelAllowed = (userId: string, model: string) => providerAllowed(userId, model.slice(0, Math.max(0, model.indexOf('/'))));

const custom = new Map<string, OAuthAuth>();
/** Register an additional OAuth login (tests; later custom identity providers). */
export const registerOAuth = (provider: string, impl: OAuthAuth) => void custom.set(provider, impl);
export const oauthOf = (provider: string): OAuthAuth | undefined => custom.get(provider) ?? builtinProviders().find((p) => p.id === provider)?.auth.oauth;

interface Row { user_id: string; provider: string; base_url: string | null; models: string | null; enc: string; created_at: string }
const rowOf = (userId: string, provider: string) => db.prepare('SELECT * FROM user_credentials WHERE user_id = ? AND provider = ?').get(userId, provider) as Row | undefined;
const put = (userId: string, provider: string, cred: Credential, extra?: { baseUrl?: string; models?: string[] }) => {
  const old = rowOf(userId, provider);
  db.prepare('INSERT OR REPLACE INTO user_credentials (user_id, provider, base_url, models, enc, created_at) VALUES (?,?,?,?,?,?)')
    .run(userId, provider, extra ? extra.baseUrl ?? null : old?.base_url ?? null, extra ? (extra.models ? JSON.stringify(extra.models) : null) : old?.models ?? null, encrypt(JSON.stringify(cred)), old?.created_at ?? new Date().toISOString());
};

/** pi-ai CredentialStore over app.db, scoped to one user (tokens are encrypted at rest). */
export class DbCredentialStore implements CredentialStore {
  private static chains = new Map<string, Promise<unknown>>();
  userId: string;
  constructor(userId: string) { this.userId = userId; }
  async read(provider: string) { const r = rowOf(this.userId, provider); return r ? (JSON.parse(decrypt(r.enc)) as Credential) : undefined; }
  async list(): Promise<readonly CredentialInfo[]> {
    return (db.prepare('SELECT provider, enc FROM user_credentials WHERE user_id = ?').all(this.userId) as any[]).map((r) => ({ providerId: r.provider, type: (JSON.parse(decrypt(r.enc)) as Credential).type }));
  }
  modify(provider: string, fn: (c: Credential | undefined) => Promise<Credential | undefined>, _o?: AuthOperationOptions) {
    const k = `${this.userId}/${provider}`;
    const run = (DbCredentialStore.chains.get(k) ?? Promise.resolve()).then(async () => {
      const next = await fn(await this.read(provider));
      if (next) put(this.userId, provider, next);
      return next ?? (await this.read(provider));
    });
    DbCredentialStore.chains.set(k, run.catch(() => {}));
    return run;
  }
  async delete(provider: string) { db.prepare('DELETE FROM user_credentials WHERE user_id = ? AND provider = ?').run(this.userId, provider); }
}

/** CredentialStore over the company `providers` table: an OAuth company provider keeps its Credential JSON (encrypted) in enc_key. */
export class CompanyCredentialStore implements CredentialStore {
  private static chains = new Map<string, Promise<unknown>>();
  async read(provider: string) {
    const r = db.prepare("SELECT enc_key FROM providers WHERE id = ? AND kind = 'oauth'").get(provider) as { enc_key: string } | undefined;
    return r ? (JSON.parse(decrypt(r.enc_key)) as Credential) : undefined;
  }
  async list(): Promise<readonly CredentialInfo[]> {
    return (db.prepare("SELECT id FROM providers WHERE kind = 'oauth'").all() as any[]).map((r) => ({ providerId: r.id, type: 'oauth' as const }));
  }
  modify(provider: string, fn: (c: Credential | undefined) => Promise<Credential | undefined>, _o?: AuthOperationOptions) {
    const run = (CompanyCredentialStore.chains.get(provider) ?? Promise.resolve()).then(async () => {
      const next = await fn(await this.read(provider));
      if (next) {
        const old = db.prepare('SELECT created_at, base_url, models FROM providers WHERE id = ?').get(provider) as { created_at: string; base_url: string | null; models: string | null } | undefined;
        db.prepare("INSERT OR REPLACE INTO providers (id, name, base_url, enc_key, models, created_at, kind) VALUES (?,?,?,?,?,?, 'oauth')")
          .run(provider, nameOf(provider), old?.base_url ?? null, encrypt(JSON.stringify(next)), old?.models ?? null, old?.created_at ?? new Date().toISOString());
      }
      return next ?? (await this.read(provider));
    });
    CompanyCredentialStore.chains.set(provider, run.catch(() => {}));
    return run;
  }
  async delete(provider: string) { db.prepare("DELETE FROM providers WHERE id = ? AND kind = 'oauth'").run(provider); }
}

/** Request auth for a provider: API key as stored, OAuth refreshed under the store lock when near expiry. */
export const resolver = (userId: string, provider: string): AuthResolver => makeResolver(new DbCredentialStore(userId), provider);
export const companyResolver = (provider: string): AuthResolver => makeResolver(new CompanyCredentialStore(), provider);
const makeResolver = (store: CredentialStore, provider: string): AuthResolver => async () => {
  const oauth = oauthOf(provider);
  const cred = await store.modify(provider, async (cur) => (cur?.type === 'oauth' && oauth && cur.expires < Date.now() + 60_000 ? withStamp('auth', () => oauth.refresh(cur, AbortSignal.timeout(30_000))) : undefined));
  if (!cred) throw new Error(`the credential for ${provider} was removed`);
  return { auth: cred.type === 'oauth' ? await oauth!.toAuth(cred) : { apiKey: cred.key } };
};

/** Company providers with their sign-in kind and health (`expired` = the OAuth refresh failed: sign in again). */
export async function companyConnections() {
  const rows = db.prepare('SELECT id, name, kind, enc_key FROM providers ORDER BY id').all() as { id: string; name: string; kind: string; enc_key: string }[];
  return Promise.all(rows.map(async (r) => {
    let status: 'ok' | 'expired' | 'error' = 'ok';
    if (r.kind === 'oauth') {
      try {
        const cred = JSON.parse(decrypt(r.enc_key)) as Credential;
        if (cred.type === 'oauth' && cred.expires < Date.now() + 60_000) await companyResolver(r.id)().catch(() => { status = 'expired'; });
      } catch { status = 'error'; }
    }
    return { id: r.id, name: r.name, kind: r.kind as 'oauth' | 'api_key', status };
  }));
}

const conn = (r: Row) => ({ id: r.provider, baseUrl: r.base_url ?? undefined, models: r.models ? JSON.parse(r.models) : undefined });
/** Provider objects of every user credential, ready for the agent to register (id namespaced). */
export const userProviders = () =>
  (db.prepare('SELECT * FROM user_credentials').all() as unknown as Row[]).map((r) => ({ row: r, id: nsId(r.user_id, r.provider), make: () => build(conn(r), resolver(r.user_id, r.provider), nsId(r.user_id, r.provider)) }));

export function connectApiKey(userId: string, c: { id: string; baseUrl?: string; models?: string[] }, apiKey: string) {
  build(c, apiKey); // validates the provider id / custom endpoint shape
  put(userId, c.id, { type: 'api_key', key: apiKey }, { baseUrl: c.baseUrl, models: c.models });
}
export const saveOAuth = (userId: string, provider: string, cred: Credential) => put(userId, provider, cred);
export const disconnectUser = (userId: string, provider: string) => void db.prepare('DELETE FROM user_credentials WHERE user_id = ? AND provider = ?').run(userId, provider);

const nameOf = (id: string) => listProviders().find((p) => p.id === id)?.name ?? builtinProviders().find((p) => p.id === id)?.name ?? id;
/** The user's own connections (no secrets). `status`: expired = OAuth refresh failed (sign in again), error = unreadable credential. */
export async function ownConnections(userId: string) {
  const rows = db.prepare('SELECT * FROM user_credentials WHERE user_id = ? ORDER BY provider').all(userId) as unknown as Row[];
  return Promise.all(rows.map(async (r) => {
    let kind: string = 'api_key', status: 'ok' | 'expired' | 'error' = 'ok';
    try {
      const cred = JSON.parse(decrypt(r.enc)) as Credential;
      kind = cred.type;
      if (cred.type === 'oauth' && cred.expires < Date.now() + 60_000) await resolver(userId, r.provider)().catch(() => { status = 'expired'; });
    } catch { status = 'error'; }
    return { provider: r.provider, name: nameOf(r.provider), kind, status, baseUrl: r.base_url, createdAt: r.created_at };
  }));
}

/** Everything this user may pick: company models plus their own. */
export function availableModels(userId: string) {
  const company = connectedModels().flatMap((p) => p.models.map((m) => ({ id: m.id, name: m.name, provider: p.provider, scope: 'company' as const, label: `${m.name} (${p.name}, company)` })));
  const own = (db.prepare('SELECT * FROM user_credentials WHERE user_id = ?').all(userId) as unknown as Row[]).flatMap((r) => {
    const ns = nsId(userId, r.provider);
    return build(conn(r), 'x', ns).getModels().map((m) => ({ id: `${ns}/${m.id}`, name: m.name, provider: ns, scope: 'own' as const, label: `${m.name} (${nameOf(r.provider)}, yours)` }));
  });
  return [...company, ...own];
}

export const conversationModel = (id: string) => (db.prepare('SELECT model FROM conversations WHERE id = ?').get(id) as { model: string | null } | undefined)?.model ?? undefined;
