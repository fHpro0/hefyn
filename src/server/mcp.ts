import { randomBytes, randomUUID } from 'node:crypto';
import { Client, SSEClientTransport, StreamableHTTPClientTransport, auth, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from '@modelcontextprotocol/client';
import { isIP } from 'node:net';
import { db } from './appdb.ts';
import { decrypt, encrypt } from './crypto.ts';

// MCP connectors (private or team). Shared secrets live encrypted in `enc` as { bearer?, client?, discovery? } (a team bearer is an explicit shared account);
// OAuth tokens are per user in `mcp_tokens`, so nobody acts as someone else on a team connector.
// OAuth follows the MCP auth spec (resource metadata discovery, dynamic client registration, PKCE) through the
// installed @modelcontextprotocol/client `auth()` helper. Shared by web (CRUD, OAuth start/callback) and agent (tokens).

interface Row { id: string; owner_id: string; name: string; visibility: 'private' | 'team'; url: string; transport: 'streamable-http' | 'sse'; auth: 'none' | 'bearer' | 'oauth'; enc: string | null; created_at: string }
interface Secrets { bearer?: string; discovery?: OAuthDiscoveryState; client?: StoredOAuthClientInformation; tokens?: StoredOAuthTokens & { expires_at?: number } }
type Tokens = StoredOAuthTokens & { expires_at?: number };
db.exec('CREATE TABLE IF NOT EXISTS mcp_tokens (connector_id TEXT NOT NULL, user_id TEXT NOT NULL, enc TEXT NOT NULL, PRIMARY KEY (connector_id, user_id))');
const getTokens = (id: string, userId: string) => { const r = db.prepare('SELECT enc FROM mcp_tokens WHERE connector_id = ? AND user_id = ?').get(id, userId) as { enc: string } | undefined; return r ? (JSON.parse(decrypt(r.enc)) as Tokens) : undefined; };
const putTokens = (id: string, userId: string, t: Tokens) => void db.prepare('INSERT OR REPLACE INTO mcp_tokens (connector_id, user_id, enc) VALUES (?,?,?)').run(id, userId, encrypt(JSON.stringify(t)));
const get = (id: string) => db.prepare('SELECT * FROM mcp_connectors WHERE id = ?').get(id) as unknown as Row | undefined;
const secrets = (r: Row): Secrets => (r.enc ? JSON.parse(decrypt(r.enc)) : {});
const save = (id: string, s: Secrets) => void db.prepare('UPDATE mcp_connectors SET enc = ? WHERE id = ?').run(encrypt(JSON.stringify(s)), id);

// Migration: a token that used to live on the connector becomes its creator's personal token.
for (const r of db.prepare("SELECT * FROM mcp_connectors WHERE auth = 'oauth' AND enc IS NOT NULL").all() as unknown as Row[]) {
  const old = JSON.parse(decrypt(r.enc!)) as Secrets & { tokens?: Tokens };
  if (old.tokens) { putTokens(r.id, r.owner_id, old.tokens); const { tokens: _t, ...rest } = old; save(r.id, rest); }
}

/** Servers are called from the agent host: refuse loopback/private/link-local addresses and bare service names. */
export function assertPublicUrl(raw: string) {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs are allowed');
  if (process.env.HEFYN_ALLOW_PRIVATE_URLS === '1') return u.toString();
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = isIP(h) === 4 && /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  const v6 = isIP(h) === 6 && /^(::1?$|f[cd]|fe80)/.test(h);
  // shortcut: hostname check only (no DNS resolution), so DNS rebinding is not covered
  if (v4 || v6 || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local') || (!h.includes('.') && !isIP(h))) throw new Error('private or internal addresses are not allowed');
  return u.toString();
}

export function createConnector(ownerId: string, b: { name: string; url: string; transport?: string; visibility?: string; auth?: string; bearer?: string }) {
  const name = String(b.name ?? '').trim().slice(0, 60);
  const kind = (b.auth ?? 'none') as Row['auth'];
  if (!name) throw new Error('name is required');
  if (!['none', 'bearer', 'oauth'].includes(kind)) throw new Error('auth must be none, bearer or oauth');
  if (kind === 'bearer' && !b.bearer) throw new Error('bearer token required');
  const id = randomUUID();
  db.prepare('INSERT INTO mcp_connectors (id, owner_id, name, visibility, url, transport, auth, enc, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, ownerId, name, b.visibility === 'team' ? 'team' : 'private', assertPublicUrl(b.url), b.transport === 'sse' ? 'sse' : 'streamable-http', kind, kind === 'bearer' ? encrypt(JSON.stringify({ bearer: b.bearer })) : null, new Date().toISOString());
  return id;
}

const visible = (userId: string) => (db.prepare("SELECT * FROM mcp_connectors WHERE owner_id = ? OR visibility = 'team' ORDER BY name").all(userId) as unknown as Row[]);
export const listConnectors = (userId: string) => visible(userId).map((r) => ({
  id: r.id, name: r.name, visibility: r.visibility, url: r.url, transport: r.transport, auth: r.auth, mine: r.owner_id === userId,
  sharedAccount: r.auth === 'bearer' && r.visibility === 'team',
  connected: r.auth === 'oauth' ? !!getTokens(r.id, userId) : r.auth === 'bearer' ? !!secrets(r).bearer : true })); // oauth: this user's own sign-in
// Hub installs: one connector per MCP entry, marked with source `hub:<packageId>`. Target 'team' creates a single
// team-visible connector owned by the installing user, who signs in once for everyone (credentials are never in the hub).
type HubConnector = { name: string; url: string; transport: string; auth: string; source: string };
export function upsertHubConnectors(ownerId: string, visibility: 'private' | 'team', list: HubConnector[]) {
  for (const c of list) {
    const old = db.prepare('SELECT id, auth FROM mcp_connectors WHERE source = ? AND name = ? AND visibility = ? AND (visibility = \'team\' OR owner_id = ?)').get(c.source, c.name, visibility, ownerId) as { id: string; auth: string } | undefined;
    if (old) {
      db.prepare('UPDATE mcp_connectors SET url = ?, transport = ?, auth = ?, enc = CASE WHEN auth = ? THEN enc ELSE NULL END WHERE id = ?').run(assertPublicUrl(c.url), c.transport, c.auth, c.auth, old.id);
    } else {
      db.prepare('INSERT INTO mcp_connectors (id, owner_id, name, visibility, url, transport, auth, enc, created_at, source) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), ownerId, c.name, visibility, assertPublicUrl(c.url), c.transport === 'sse' ? 'sse' : 'streamable-http', c.auth, null, new Date().toISOString(), c.source);
    }
  }
}
export const removeHubConnectors = (ownerId: string, visibility: 'private' | 'team', source: string) =>
  void db.prepare("DELETE FROM mcp_connectors WHERE source = ? AND visibility = ? AND (visibility = 'team' OR owner_id = ?)").run(source, visibility, ownerId);
/** Sign-in for a bearer connector that was created without its secret (hub installs). */
export function setBearer(id: string, bearer: string) {
  const r = get(id);
  if (!r || r.auth !== 'bearer') throw new Error('not a bearer connector');
  save(id, { ...secrets(r), bearer });
}

export const ownerOf = (id: string) => get(id)?.owner_id;
export const infoOf = (id: string) => { const r = get(id); return r && { owner: r.owner_id, visibility: r.visibility, auth: r.auth }; };
export const deleteConnector = (id: string) => void db.prepare('DELETE FROM mcp_connectors WHERE id = ?').run(id);

// ---- OAuth ----
class Oauth implements OAuthClientProvider {
  authUrl?: URL;
  row: Row;
  redirect: string;
  flow?: { state: string; verifier?: string };
  userId: string;
  constructor(row: Row, userId: string, redirect: string, flow?: { state: string; verifier?: string }) { this.userId = userId; this.row = row; this.redirect = redirect; this.flow = flow; }
  get redirectUrl() { return this.redirect; }
  get clientMetadata() { return { client_name: 'hefyn', redirect_uris: [this.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
  state() { return this.flow!.state; }
  clientInformation() { return secrets(get(this.row.id)!).client; }
  saveClientInformation(c: StoredOAuthClientInformation) { save(this.row.id, { ...secrets(get(this.row.id)!), client: c }); }
  tokens() { return getTokens(this.row.id, this.userId); }
  saveTokens(t: StoredOAuthTokens) { putTokens(this.row.id, this.userId, { ...t, expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined }); }
  redirectToAuthorization(u: URL) { this.authUrl = u; }
  saveDiscoveryState(d: OAuthDiscoveryState) { save(this.row.id, { ...secrets(get(this.row.id)!), discovery: d }); }
  discoveryState() { return secrets(get(this.row.id)!).discovery; }
  saveCodeVerifier(v: string) { this.flow!.verifier = v; }
  codeVerifier() { return this.flow!.verifier!; }
}

const pending = new Map<string, { id: string; userId: string; state: string; verifier?: string; at: number }>(); // state -> flow, single use, 10 min
const redirectUri = () => `${(process.env.HEFYN_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/api/connectors/mcp/oauth/callback`;

export async function startMcpOauth(userId: string, id: string) {
  const row = visible(userId).find((r) => r.id === id); // own or team: everyone signs in for themselves
  if (!row || row.auth !== 'oauth') throw Object.assign(new Error('unknown connector'), { status: 404 });
  for (const [s, f] of pending) if (Date.now() - f.at > 600_000) pending.delete(s);
  const flow = { id, userId, at: Date.now(), state: randomBytes(24).toString('base64url') } as { id: string; userId: string; at: number; state: string; verifier?: string };
  const p = new Oauth(row, userId, redirectUri(), flow);
  const res = await auth(p, { serverUrl: row.url });
  if (res === 'AUTHORIZED') return { connected: true };
  pending.set(flow.state, flow);
  return { authUrl: p.authUrl!.toString() };
}

export async function finishMcpOauth(userId: string, state: string, code: string, iss?: string) {
  const flow = pending.get(state);
  if (flow?.userId === userId) pending.delete(state); // single use (a foreign user's attempt must not burn it)
  const row = flow && get(flow.id);
  if (!flow || !row || flow.userId !== userId || Date.now() - flow.at > 600_000) throw Object.assign(new Error('unknown or expired sign-in'), { status: 400 });
  await auth(new Oauth(row, userId, redirectUri(), flow), { serverUrl: row.url, authorizationCode: code, ...(iss ? { iss } : {}) });
}

async function tokenOf(id: string, userId: string): Promise<string> {
  const cur = get(id);
  if (!cur) throw new Error('connector removed');
  if (cur.auth === 'bearer') return secrets(cur).bearer!;
  const t = getTokens(id, userId);
  if (t?.expires_at && t.expires_at < Date.now() + 60_000) await auth(new Oauth(cur, userId, redirectUri()), { serverUrl: cur.url }); // refreshes via refresh_token and saves
  const fresh = getTokens(id, userId);
  if (!fresh) throw new Error('sign-in needed');
  return fresh.access_token;
}

/** Mountable connectors of a user (own + team) for the agent: bearer or fresh OAuth token resolved per request. */
export const mountable = (userId: string) => visible(userId).map((r) => ({
  name: `${r.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'mcp'}_${r.id.slice(0, 4)}`,
  url: r.url, transport: r.transport,
  token: r.auth === 'none' ? undefined : () => tokenOf(r.id, userId),
}));

/** Connected MCP client for a visible connector (own or team) with the user's own credentials; the caller closes it. */
export async function openClient(userId: string, id: string): Promise<Client> {
  const r = visible(userId).find((x) => x.id === id);
  if (!r) throw new Error('unknown connector');
  const requestInit = r.auth === 'none' ? undefined : { headers: { authorization: `Bearer ${await tokenOf(id, userId)}` } };
  const url = new URL(r.url);
  const client = new Client({ name: 'hefyn', version: '1' });
  try { await client.connect(r.transport === 'sse' ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit })); } catch (e) { await client.close().catch(() => {}); throw e; }
  return client;
}
/** For storage add-ons: name and sharing of a connector the user can see. */
export const connectorFor = (userId: string, id: string) => { const r = visible(userId).find((x) => x.id === id); return r && { id: r.id, name: r.name, owner: r.owner_id, visibility: r.visibility }; };
export const connectorExists = (id: string) => !!get(id);

/** Connect, list tools, disconnect: for the "test connection" button. Never throws. */
export async function testConnector(userId: string, id: string): Promise<{ ok: boolean; tools?: string[]; error?: string }> {
  let client: Client | undefined;
  try {
    client = await openClient(userId, id);
    return { ok: true, tools: (await client.listTools()).tools.map((t) => t.name) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    await client?.close().catch(() => {});
  }
}
