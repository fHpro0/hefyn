import { randomBytes, randomUUID } from 'node:crypto';
import { Client, SSEClientTransport, StreamableHTTPClientTransport, auth, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from '@modelcontextprotocol/client';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { db } from './appdb.ts';
import { decrypt, encrypt } from './crypto.ts';
import { openTeamSecret, openUserSecret } from './seal.ts';
import { isSealed, sealForTeam, sealForUser } from './vault.ts';

// MCP connectors (private or team). Shared secrets live encrypted in `enc` as { bearer?, client?, discovery? } (a team bearer is an explicit shared account);
// OAuth tokens are per user in `mcp_tokens`, so nobody acts as someone else on a team connector.
// OAuth follows the MCP auth spec (resource metadata discovery, dynamic client registration, PKCE) through the
// installed @modelcontextprotocol/client `auth()` helper. Shared by web (CRUD, OAuth start/callback) and agent (tokens).

interface Row { source?: string | null; id: string; owner_id: string; name: string; visibility: 'private' | 'team'; url: string; transport: 'streamable-http' | 'sse'; auth: 'none' | 'bearer' | 'oauth'; enc: string | null; created_at: string; last_ok?: number | null; last_error?: string | null; last_at?: string | null }
// The last real test of a connector (testConnector): what the list shows as its status. Idempotent, like the other columns.
for (const c of ['last_ok INTEGER', 'last_error TEXT', 'last_at TEXT']) try { db.exec(`ALTER TABLE mcp_connectors ADD COLUMN ${c}`); } catch { /* column exists */ }
interface Secrets { bearer?: string; discovery?: OAuthDiscoveryState; client?: StoredOAuthClientInformation; tokens?: StoredOAuthTokens & { expires_at?: number } }
type Tokens = StoredOAuthTokens & { expires_at?: number };
db.exec('CREATE TABLE IF NOT EXISTS mcp_tokens (connector_id TEXT NOT NULL, user_id TEXT NOT NULL, enc TEXT NOT NULL, PRIMARY KEY (connector_id, user_id))');
// Encryption (docs/ENCRYPTION.md): OAuth tokens are the user's (`mcptok:<connector>:<user>`); connector secrets belong to the owner's key for a
// private connector and to the team key for a team connector (`mcp:<connector>`). Values from before that stay readable and are re-sealed on unlock.
const urlOf = (id: string) => (db.prepare('SELECT url FROM mcp_connectors WHERE id = ?').get(id) as { url: string } | undefined)?.url ?? '';
const getTokens = (id: string, userId: string) => { const r = db.prepare('SELECT enc FROM mcp_tokens WHERE connector_id = ? AND user_id = ?').get(id, userId) as { enc: string } | undefined; return r ? (JSON.parse(openUserSecret(userId, r.enc, `mcptok:${id}:${userId}:${urlOf(id)}`)) as Tokens) : undefined; };
const hasTokens = (id: string, userId: string) => !!db.prepare('SELECT 1 FROM mcp_tokens WHERE connector_id = ? AND user_id = ?').get(id, userId);
const putTokens = (id: string, userId: string, t: Tokens) => void db.prepare('INSERT OR REPLACE INTO mcp_tokens (connector_id, user_id, enc) VALUES (?,?,?)').run(id, userId, sealForUser(userId, JSON.stringify(t), `mcptok:${id}:${userId}:${urlOf(id)}`));
const get = (id: string) => db.prepare('SELECT * FROM mcp_connectors WHERE id = ?').get(id) as unknown as Row | undefined;
type Scope = Pick<Row, 'id' | 'owner_id' | 'visibility' | 'url'>;
const sealSecrets = (r: Scope, s: Secrets) => (r.visibility === 'team' ? sealForTeam(JSON.stringify(s), `mcp:${r.id}:${r.url}`) : sealForUser(r.owner_id, JSON.stringify(s), `mcp:${r.id}:${r.url}`));
/** Decrypted connector secrets as JSON text ('' when none); throws LockedError while the owner's / the team's key is missing. */
export const openConnectorEnc = (r: Scope & { enc: string | null }) => (!r.enc ? '' : r.visibility === 'team' ? openTeamSecret(r.enc, `mcp:${r.id}:${r.url}`) : openUserSecret(r.owner_id, r.enc, `mcp:${r.id}:${r.url}`));
const secrets = (r: Row): Secrets => (r.enc ? JSON.parse(openConnectorEnc(r)) : {});
const save = (id: string, s: Secrets) => void db.prepare('UPDATE mcp_connectors SET enc = ? WHERE id = ?').run(sealSecrets(get(id)!, s), id);

// Migration: a token that used to live on the connector becomes its creator's personal token (legacy values only; written with the server key, sealed on unlock).
for (const r of db.prepare("SELECT * FROM mcp_connectors WHERE auth = 'oauth' AND enc IS NOT NULL").all() as unknown as Row[]) {
  if (isSealed(r.enc!)) continue;
  const old = JSON.parse(decrypt(r.enc!)) as Secrets & { tokens?: Tokens };
  if (old.tokens) {
    db.prepare('INSERT OR REPLACE INTO mcp_tokens (connector_id, user_id, enc) VALUES (?,?,?)').run(r.id, r.owner_id, encrypt(JSON.stringify(old.tokens)));
    const { tokens: _t, ...rest } = old;
    db.prepare('UPDATE mcp_connectors SET enc = ? WHERE id = ?').run(encrypt(JSON.stringify(rest)), r.id);
  }
}

const blocked = new BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(a, p, 'ipv6');

/** The IPv4 address inside an IPv6 one (::a.b.c.d, ::ffff:a.b.c.d, 64:ff9b::/96, 6to4), if any. `h` is URL-normalized hex, no dotted quad. */
function embeddedV4(h: string): string | undefined {
  const [head, tail] = h.split('::');
  const a = head ? head.split(':') : [];
  const b = tail === undefined ? [] : tail ? tail.split(':') : [];
  const w = [...a, ...Array(8 - a.length - b.length).fill('0'), ...b].map((x) => parseInt(x, 16));
  const quad = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0 || w[5] === 0xffff)) return quad(w[6]!, w[7]!);
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return quad(w[6]!, w[7]!);
  if (w[0] === 0x2002) return quad(w[1]!, w[2]!);
}

/** Servers are called from the agent host: refuse loopback/private/link-local addresses and bare service names. */
export function assertPublicUrl(raw: string) {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs are allowed');
  if (process.env.HEFYN_ALLOW_PRIVATE_URLS === '1') return u.toString();
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, ''); // `agent.` is the same host as `agent`
  const ip = isIP(h);
  const v4 = ip === 4 ? h : ip === 6 ? embeddedV4(h) : undefined;
  // shortcut: hostname check only (no DNS resolution), so DNS rebinding is not covered
  if ((ip === 4 && blocked.check(h, 'ipv4')) || (ip === 6 && blocked.check(h, 'ipv6')) || (v4 && blocked.check(v4, 'ipv4'))
    || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local') || (!h.includes('.') && !ip)) throw new Error('private or internal addresses are not allowed');
  return u.toString();
}

let resolveAll = async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map((a) => a.address);
/** Tests supply a resolver instead of real DNS. */
export const setResolver = (f: typeof resolveAll) => { resolveAll = f; };
/** `assertPublicUrl`, plus the addresses the host name resolves to (v4, v6, v4-mapped v6): none may be private, loopback, link-local, CGNAT or ULA. Call it before every connection and redirect hop.
 *  shortcut: the check and the connection resolve separately (Bun's fetch cannot pin an address without breaking TLS), so DNS rebinding in between is not covered; upgrade by connecting to the checked IP with the host as SNI. */
export async function assertPublicHost(raw: string) {
  const u = new URL(assertPublicUrl(raw));
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (process.env.HEFYN_ALLOW_PRIVATE_URLS === '1' || isIP(h)) return;
  let addrs: string[];
  try { addrs = await resolveAll(h); } catch { throw new Error('that address could not be resolved'); }
  if (!addrs.length) throw new Error('that address could not be resolved');
  for (const a of addrs) assertPublicUrl(isIP(a) === 6 ? `https://[${a}]/` : `https://${a}/`); // one private answer refuses the host
}

/** MCP traffic never follows redirects: a public server must not be able to bounce the request to an internal address. */
export const noRedirectFetch: typeof fetch = (u, init) => fetch(u, { ...init, redirect: 'error' });

export function createConnector(ownerId: string, b: { name: string; url: string; transport?: string; visibility?: string; auth?: string; bearer?: string }) {
  const name = String(b.name ?? '').trim().slice(0, 60);
  const kind = (b.auth ?? 'none') as Row['auth'];
  if (!name) throw new Error('name is required');
  if (!['none', 'bearer', 'oauth'].includes(kind)) throw new Error('auth must be none, bearer or oauth');
  if (kind === 'bearer' && !b.bearer) throw new Error('bearer token required');
  const id = randomUUID();
  const visibility = b.visibility === 'team' ? 'team' : 'private';
  const url = assertPublicUrl(b.url);
  db.prepare('INSERT INTO mcp_connectors (id, owner_id, name, visibility, url, transport, auth, enc, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, ownerId, name, visibility, url, b.transport === 'sse' ? 'sse' : 'streamable-http', kind, kind === 'bearer' ? sealSecrets({ id, owner_id: ownerId, visibility, url }, { bearer: b.bearer }) : null, new Date().toISOString());
  return id;
}

const visible = (userId: string) => (db.prepare("SELECT * FROM mcp_connectors WHERE owner_id = ? OR visibility = 'team' ORDER BY name").all(userId) as unknown as Row[]);
const isModuleOwned = (r: Row) => !!r.source?.startsWith('module:');
/** Module connectors are only listed for module managers. */
export const listConnectors = (userId: string, showModules = false) => visible(userId).filter((r) => showModules || !isModuleOwned(r)).map((r) => ({
  id: r.id, name: r.name, visibility: r.visibility, url: r.url, transport: r.transport, auth: r.auth, mine: r.owner_id === userId,
  sharedAccount: r.auth === 'bearer' && r.visibility === 'team',
  // `connected`: credentials are in place (oauth: this user's own sign-in; listing never decrypts). `status`: the last real test, which is the only thing that says the server answers.
  connected: r.auth === 'oauth' ? hasTokens(r.id, userId) : r.auth === 'bearer' ? !!r.enc : true,
  status: (r.last_ok == null ? 'untested' : r.last_ok ? 'ok' : 'failed') as 'untested' | 'ok' | 'failed', error: r.last_ok === 0 ? r.last_error ?? undefined : undefined, testedAt: r.last_at ?? undefined,
  /** agents reach streamable-HTTP servers only (the bridge forwards one request per call) */ agents: r.transport === 'streamable-http' }));
// Hub installs: one connector per MCP entry, marked with source `hub:<packageId>`. Target 'team' creates a single
// team-visible connector owned by the installing user, who signs in once for everyone (credentials are never in the hub).
type HubConnector = { name: string; url: string; transport: string; auth: string; source: string };
export function upsertHubConnectors(ownerId: string, visibility: 'private' | 'team', list: HubConnector[]) {
  for (const c of list) {
    const old = db.prepare('SELECT id, auth, url FROM mcp_connectors WHERE source = ? AND name = ? AND visibility = ? AND (visibility = \'team\' OR owner_id = ?)').get(c.source, c.name, visibility, ownerId) as { id: string; auth: string; url: string } | undefined;
    if (old) {
      const url = assertPublicUrl(c.url);
      if (url !== old.url) db.prepare('DELETE FROM mcp_tokens WHERE connector_id = ?').run(old.id);
      // the secrets are bound to the url: a changed url drops them (sign in again)
      db.prepare('UPDATE mcp_connectors SET url = ?, transport = ?, auth = ?, enc = CASE WHEN auth = ? AND url = ? THEN enc ELSE NULL END WHERE id = ?').run(url, c.transport, c.auth, c.auth, url, old.id);
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

/** Change a connector the caller already may change. The secrets are bound to scope and address, so they are opened first and sealed again under the new ones; a new address drops everyone's sign-ins. */
export function updateConnector(id: string, p: { name?: string; url?: string; visibility?: 'private' | 'team'; transport?: string }) {
  const r = get(id);
  if (!r) throw new Error('unknown connector');
  const s = r.enc ? secrets(r) : undefined;
  const name = p.name === undefined ? r.name : p.name.trim().slice(0, 60), url = p.url === undefined ? r.url : assertPublicUrl(p.url);
  if (!name) throw new Error('name is required');
  const moved = url !== r.url; // a token or secret must never follow the connector to another server: sign in again
  if (moved) db.prepare('DELETE FROM mcp_tokens WHERE connector_id = ?').run(id);
  db.prepare('UPDATE mcp_connectors SET name = ?, url = ?, visibility = ?, transport = ?, enc = ?, last_ok = NULL, last_error = NULL, last_at = NULL WHERE id = ?')
    .run(name, url, p.visibility ?? r.visibility, p.transport === undefined ? r.transport : p.transport === 'sse' ? 'sse' : 'streamable-http', moved ? null : r.enc, id);
  if (s && !moved) save(id, s);
}

export const ownerOf = (id: string) => get(id)?.owner_id;
export const infoOf = (id: string) => { const r = get(id); return r && { owner: r.owner_id, visibility: r.visibility, auth: r.auth }; };
/** The module that manages a connector (source `module:<id>`), if any. */
export const moduleOf = (id: string) => get(id)?.source?.match(/^module:(.+)$/)?.[1]; // hub installs have a source too
/** The team connector a module owns (source `module:<id>`). */
export const moduleConnectorId = (moduleId: string) => (db.prepare("SELECT id FROM mcp_connectors WHERE source = ? AND visibility = 'team'").get(`module:${moduleId}`) as { id: string } | undefined)?.id;
export const deleteConnector =(id: string) => void db.prepare('DELETE FROM mcp_connectors WHERE id = ?').run(id);

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
  const res = await auth(p, { serverUrl: row.url, fetchFn: noRedirectFetch });
  if (res === 'AUTHORIZED') return { connected: true };
  pending.set(flow.state, flow);
  return { authUrl: p.authUrl!.toString() };
}

export async function finishMcpOauth(userId: string, state: string, code: string, iss?: string) {
  const flow = pending.get(state);
  if (flow?.userId === userId) pending.delete(state); // single use (a foreign user's attempt must not burn it)
  const row = flow && get(flow.id);
  if (!flow || !row || flow.userId !== userId || Date.now() - flow.at > 600_000) throw Object.assign(new Error('unknown or expired sign-in'), { status: 400 });
  await auth(new Oauth(row, userId, redirectUri(), flow), { serverUrl: row.url, fetchFn: noRedirectFetch, authorizationCode: code, ...(iss ? { iss } : {}) });
}

async function tokenOf(id: string, userId: string): Promise<string> {
  const cur = get(id);
  if (!cur) throw new Error('connector removed');
  if (cur.auth === 'bearer') { const b = secrets(cur).bearer; if (!b) throw new Error('sign-in needed'); return b; }
  const t = getTokens(id, userId);
  if (t?.expires_at && t.expires_at < Date.now() + 60_000) await auth(new Oauth(cur, userId, redirectUri()), { serverUrl: cur.url, fetchFn: noRedirectFetch }); // refreshes via refresh_token and saves
  const fresh = getTokens(id, userId);
  if (!fresh) throw new Error('sign-in needed');
  return fresh.access_token;
}

/** Mountable connectors of a user (own + team) for the agent: bearer or fresh OAuth token resolved per request.
 *  Module connectors are left out: a module offers tools to the agent only through its `agent` section (src/modules/mount.ts). */
export const mountable = (userId: string) => visible(userId).filter((r) => !r.source?.startsWith('module:')).map((r) => ({
  id: r.id as string,
  name: `${r.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'mcp'}_${r.id.slice(0, 4)}`,
  url: r.url, transport: r.transport,
  token: r.auth === 'none' ? undefined : () => tokenOf(r.id, userId),
}));

/** Connected MCP client for a visible connector (own or team) with the user's own credentials; the caller closes it. */
export async function openClient(userId: string, id: string, extraHeaders?: Record<string, string>): Promise<Client> {
  const r = visible(userId).find((x) => x.id === id);
  if (!r) throw new Error('unknown connector');
  const headers = { ...extraHeaders, ...(r.auth === 'none' ? {} : { authorization: `Bearer ${await tokenOf(id, userId)}` }) };
  const requestInit = Object.keys(headers).length ? { headers } : undefined;
  const url = new URL(r.url);
  const client = new Client({ name: 'hefyn', version: '1' });
  const opts = { requestInit, fetch: noRedirectFetch }; // `fetch`, not only requestInit: the GET stream ignores requestInit
  try { await client.connect(r.transport === 'sse' ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts)); } catch (e) { await client.close().catch(() => {}); throw e; }
  return client;
}
/** For storage add-ons: name and sharing of a connector the user can see. */
export const connectorFor = (userId: string, id: string) => { const r = visible(userId).find((x) => x.id === id && !isModuleOwned(x)); return r && { id: r.id, name: r.name, owner: r.owner_id, visibility: r.visibility }; };
export const connectorExists = (id: string) => !!get(id);

/** A short sentence for a failed connection: never an HTML page or a stack, whatever the server sent back. */
export function readableError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e), code = (e as { code?: unknown })?.code;
  const status = typeof code === 'number' ? code : Number(/\b(?:HTTP|status|code)\D{0,12}([1-5]\d\d)\b/i.exec(raw)?.[1]);
  if (/<\s*(!doctype|html|head|body|h1|title)\b/i.test(raw)) return `The server answered with a web page${status ? ` (HTTP ${status})` : ''}, not an MCP endpoint. Check the URL.`;
  if (status === 401 || status === 403) return `The server refused the credentials (HTTP ${status}). Sign in again or replace the token.`;
  if (status === 404) return 'Nothing answers at this address (HTTP 404). Check the URL.';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return 'The server name was not found. Check the URL.';
  if (/ECONNREFUSED|ECONNRESET|fetch failed|Unable to connect|timed out|TimeoutError|aborted/i.test(raw)) return 'Could not reach the server.';
  if (/redirect/i.test(raw)) return 'The server redirects somewhere else. Use its final address.';
  return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Connection failed.';
}

/** Connect, list tools, disconnect: for the "test connection" button. Never throws. The result is kept on the connector: it is what the list shows as its status. */
export async function testConnector(userId: string, id: string, showModules = false, open: typeof openClient = openClient): Promise<{ ok: boolean; tools?: string[]; error?: string }> {
  let client: Client | undefined;
  let out: { ok: boolean; tools?: string[]; error?: string };
  try {
    if (!showModules && get(id) && isModuleOwned(get(id)!)) throw new Error('unknown connector');
    const c = (client = await Promise.race([open(userId, id), new Promise<never>((_, no) => AbortSignal.timeout(20_000).addEventListener('abort', () => no(new Error('timed out'))))]));
    out = { ok: true, tools: (await c.listTools()).tools.map((t) => t.name) };
  } catch (e) {
    out = { ok: false, error: readableError(e) };
  } finally {
    await client?.close().catch(() => {});
  }
  db.prepare('UPDATE mcp_connectors SET last_ok = ?, last_error = ?, last_at = ? WHERE id = ?').run(out.ok ? 1 : 0, out.error ?? null, new Date().toISOString(), id);
  return out;
}

/** What the bridge forwards to for a user: the real address and the credentials, resolved per request (a bearer, or a fresh OAuth token of that user). undefined: not a connector the
 *  user may use (another user's private one, a module's, unknown). The credentials leave this function only as request headers. */
export async function proxyTarget(userId: string, id: string): Promise<{ url: string; headers: Record<string, string> } | undefined> {
  const r = visible(userId).find((x) => x.id === id && !isModuleOwned(x));
  if (!r || r.transport !== 'streamable-http') return;
  assertPublicUrl(r.url); // the stored address is checked again before every forward
  return { url: r.url, headers: r.auth === 'none' ? {} : { authorization: `Bearer ${await tokenOf(id, userId)}` } };
}
/** The connectors a user's agents may be given: their own and the team's (module-owned ones excepted), streamable HTTP only. `name` is how the agent knows the server. */
export const agentConnectors = (userId: string) => visible(userId).filter((r) => !isModuleOwned(r) && r.transport === 'streamable-http')
  .map((r) => ({ id: r.id, name: `${r.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'mcp'}_${r.id.slice(0, 4)}` }));
