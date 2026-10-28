import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { type TarEntry, readTar } from '../assistants/tar.ts';
import { db } from './appdb.ts';
import type { Me } from './guard.ts';
import { ManifestError, parseManifest } from '../modules/manifest.ts';
import { THINKING_LEVELS, validThinking } from './agent-prefs.ts';
import { gitlabArchive, parseGitlabUrl, resolveSource, type GitlabTarget } from './hub-sources.ts';
import { assertPublicHost, assertPublicUrl } from './mcp.ts';
import type { Permission } from './permissions.ts';
import { guard as heuristicGuard } from './hub-guard.ts';

// Skill hub core (docs/HUB-API.md, docs/HUB.md). Everything here parses text; nothing from a package is ever executed.

export class HubError extends Error {
  status: 400 | 403 | 404 | 409 | 502;
  constructor(status: 400 | 403 | 404 | 409 | 502, message: string) { super(message); this.status = status; }
}
const fail = (status: HubError['status'], msg: string): never => { throw new HubError(status, msg); };

export type Kind = 'skill' | 'agent' | 'mcp' | 'bundle' | 'module' | 'assistant'; // module: carries hefyn.module.json, installed by src/modules/installed.ts; assistant: a user's Assistant shared with the team (assistant-share.ts), reviewed here, never installed
/** Called after a package of that kind was approved or rejected in the review queue (assistant-share.ts registers). */
export const reviewHooks: { assistant?: (id: string, decision: 'approved' | 'rejected', note?: string) => void } = {};
type Files = Record<string, string>;
type Auth = 'none' | 'bearer' | 'oauth';
export interface SkillItem { name: string; description: string; instructions: string; files: Files; dir?: string }
export interface AgentItem { name: string; description: string; instructions: string; model?: string; thinking?: string; skills: string[]; file?: string }
export interface McpItem { name: string; url: string; transport: 'streamable-http' | 'sse'; auth: Auth; storage?: true }
interface Items { skills: SkillItem[]; agents: AgentItem[]; mcp: McpItem[] }
interface Manifest { items: Items; ignored: string[]; needsRunner: string[]; plugin?: Record<string, unknown> }
export interface Source { type: 'ui' | 'git' | 'marketplace' | 'mcp-registry'; url?: string; ref?: string }
interface Draft { kind: Kind; name: string; description: string; version?: string; files: Files; manifest: Manifest }
interface Guarded { flagged: boolean; reasons: string[] }
interface Row {
  id: string; kind: Kind; name: string; description: string; version: string; hash: string; source_json: string; visibility: 'private' | 'team';
  status: 'draft' | 'pending' | 'approved' | 'rejected'; reject_reason: string | null; owner_id: string; manifest_json: string; guard_json: string;
  approved_json: string | null; created_at: string; updated_at: string;
}
interface Snapshot { version: string; hash: string; manifest: Manifest; files: Files }

export const LIMITS = { files: 200, bytes: 5 * 1024 * 1024, depth: 8, download: 50 * 1024 * 1024, unpacked: 100 * 1024 * 1024, plugins: 20, timeoutMs: 30_000 };

export function ensureHubTables() {
  db.exec(`
CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL,
  source_json TEXT NOT NULL, visibility TEXT NOT NULL, status TEXT NOT NULL, reject_reason TEXT, owner_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL, guard_json TEXT NOT NULL, approved_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS packages_owner_name ON packages (owner_id, kind, name);
CREATE TABLE IF NOT EXISTS package_files (package_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (package_id, path));
CREATE TABLE IF NOT EXISTS installs (package_id TEXT NOT NULL, target TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS installs_uniq ON installs (package_id, target, COALESCE(user_id, ''));`);
}
ensureHubTables();

// Guard is injectable so tests can force a verdict.
let guardFn: (text: string) => Promise<{ flagged: boolean; reason?: string }> = heuristicGuard;
export const setGuard = (f: typeof guardFn) => void (guardFn = f);

const has = (me: Pick<Me, 'permissions'>, p: Permission) => me.permissions.includes(p);
export const need = (me: Pick<Me, 'permissions'>, p: Permission) => { if (!has(me, p)) fail(403, 'forbidden'); };

// ---------- parsing ----------

export function frontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):[ \t]*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let v = kv[2]!.trim();
    const cont: string[] = [];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) cont.push(lines[++i]!.trim());
    if (/^[>|][+-]?$/.test(v)) v = cont.join(v[0] === '>' ? ' ' : '\n');
    else {
      if (cont.length) v = [v, ...cont].join(' ');
      if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } } else if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    }
    data[kv[1]!] = v;
  }
  return { data, body: m[2]! };
}

const slug = (s: string) => s.trim().replace(/[^\w.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
const NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;
const list = (v?: string) => (v ? v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : []);
const json = (text: string | undefined): any => { try { return text ? JSON.parse(text) : undefined; } catch { return undefined; } };
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

const emptyManifest = (): Manifest => ({ items: { skills: [], agents: [], mcp: [] }, ignored: [], needsRunner: [] });

/** Reads skills (SKILL.md dirs), agents (agents/*.md) and remote MCP servers (.mcp.json) out of a file tree. */
export function collect(files: Files, fallbackName = 'unnamed'): Manifest {
  const m = emptyManifest();
  const skillDirs = Object.keys(files).filter((p) => p === 'SKILL.md' || p.endsWith('/SKILL.md')).map(dirOf).sort((a, b) => a.length - b.length);
  const roots: string[] = [];
  for (const d of skillDirs) if (!roots.some((r) => r === '' || d === r || d.startsWith(r + '/'))) roots.push(d);
  for (const d of roots) {
    const prefix = d ? d + '/' : '';
    const { data, body } = frontmatter(files[prefix + 'SKILL.md']!);
    const name = slug(data.name || d.split('/').pop() || fallbackName);
    const sub: Files = {};
    for (const [p, c] of Object.entries(files)) if (p.startsWith(prefix) && p !== prefix + 'SKILL.md') sub[p.slice(prefix.length)] = c;
    m.items.skills.push({ name, description: data.description ?? '', instructions: body.trim(), files: sub, dir: d });
  }
  for (const p of Object.keys(files).sort()) {
    if (!/^agents\/[^/]+\.md$/.test(p)) continue;
    const { data, body } = frontmatter(files[p]!); // `tools` is deliberately dropped
    m.items.agents.push({ name: slug(data.name || p.slice(7, -3)), description: data.description ?? '', instructions: body.trim(), ...(data.model ? { model: data.model } : {}), ...(validThinking(data.thinking) && data.thinking ? { thinking: data.thinking } : {}), skills: list(data.skills), file: p });
  }
  const servers = { ...(json(files['.mcp.json'])?.mcpServers ?? json(files['.mcp.json']) ?? {}), ...(json(files['.claude-plugin/plugin.json'])?.mcpServers ?? {}) };
  for (const [raw, e] of Object.entries<any>(servers)) {
    if (!e || typeof e !== 'object') continue;
    const name = slug(raw);
    const type = String(e.type ?? 'http');
    if (typeof e.url === 'string' && /^(http|sse|streamable-http)$/.test(type)) {
      try {
        const url = assertPublicUrl(e.url);
        const auth: Auth = ['none', 'bearer', 'oauth'].includes(e.auth) ? e.auth : e.headers && Object.keys(e.headers).some((h) => h.toLowerCase() === 'authorization') ? 'bearer' : 'none';
        m.items.mcp.push({ name, url, transport: type === 'sse' ? 'sse' : 'streamable-http', auth, ...(e.storage === true ? { storage: true as const } : {}) });
      } catch (err) { m.ignored.push(`mcp ${name}: ${(err as Error).message}`); }
    } else if (e.command) m.needsRunner.push(`${name}: stdio server, needs managed runner (phase 4)`);
  }
  for (const dir of ['hooks', 'commands']) if (Object.keys(files).some((p) => p.startsWith(dir + '/'))) m.ignored.push(`${dir}/`);
  return m;
}

/** One draft per skill / agent / remote server, or a single embedded bundle for a Claude Code plugin. */
export function draftsFromTree(files: Files, o: { fallbackName: string; plugin?: boolean; name?: string; description?: string }): Draft[] {
  const manifest = collect(files, o.fallbackName);
  const pj = json(files['.claude-plugin/plugin.json']);
  const { skills, agents, mcp } = manifest.items;
  if (o.plugin || pj) {
    manifest.plugin = pj ?? {};
    return [{ kind: 'bundle', name: slug(pj?.name || o.name || o.fallbackName), description: String(pj?.description || o.description || ''), version: pj?.version ? String(pj.version) : undefined, files, manifest }];
  }
  const out: Draft[] = [];
  for (const s of skills) {
    const pre = s.dir ? s.dir + '/' : '';
    const f = Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith(pre)).map(([p, c]) => [p.slice(pre.length), c]));
    out.push({ kind: 'skill', name: s.name, description: s.description, files: f, manifest: { ...emptyManifest(), items: { skills: [(({ dir: _d, ...rest }) => rest)(s)], agents: [], mcp: [] } } });
  }
  for (const a of agents) out.push({ kind: 'agent', name: a.name, description: a.description, files: { [a.file!]: files[a.file!]! }, manifest: { ...emptyManifest(), items: { skills: [], agents: [a], mcp: [] } } });
  for (const s of mcp) out.push({ kind: 'mcp', name: s.name, description: s.url, files: {}, manifest: { ...emptyManifest(), items: { skills: [], agents: [], mcp: [s] } } });
  if (!mcp.length && manifest.needsRunner.length) out.push({ kind: 'mcp', name: slug(o.fallbackName), description: 'stdio MCP server(s)', files: { '.mcp.json': files['.mcp.json'] ?? '' }, manifest: { ...emptyManifest(), needsRunner: manifest.needsRunner } });
  if (!out.length) fail(400, 'nothing importable found (expected SKILL.md, agents/*.md, .claude-plugin/plugin.json, .mcp.json or marketplace.json)');
  return out;
}

// ---------- UI-authored packages ----------

const MODULE_FILE = 'hefyn.module.json';

const fm = (o: Record<string, string | undefined>) => '---\n' + Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n---\n';
const str = (v: unknown, what: string, max = 200_000) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail(400, `${what} is required`);
  return (v as string).trim();
};

export function draftFromBody(b: any): Draft {
  const kind = b?.kind as Kind;
  if (kind === 'module') {
    let m;
    try { m = parseManifest(b.manifest); } catch (e) { if (e instanceof ManifestError) fail(400, e.message); throw e; }
    if (b.name !== undefined && b.name !== m.id) fail(400, 'name must be the module id');
    return { kind, name: m.id, description: m.description ?? m.name, version: m.version, files: { [MODULE_FILE]: JSON.stringify(m, null, 2) }, manifest: emptyManifest() };
  }
  const name = str(b?.name, 'name', 64);
  if (!NAME.test(name)) fail(400, 'name may contain letters, digits, dot, dash and underscore (max 64)');
  const description = str(b?.description ?? (kind === 'mcp' ? b?.url : undefined), 'description', 2000);
  if (kind === 'skill') {
    const files: Files = { 'SKILL.md': fm({ name, description }) + '\n' + str(b.instructions, 'instructions') + '\n' };
    for (const f of Array.isArray(b.files) ? b.files : []) {
      const p = safePath(f?.path);
      if (p === 'SKILL.md' || typeof f.content !== 'string') fail(400, `invalid file ${f?.path}`);
      files[p] = f.content;
    }
    checkSize(files);
    return { kind, name, description, files, manifest: collect(files, name) };
  }
  if (kind === 'agent') {
    if (!validThinking(b.thinking)) fail(400, 'thinking must be one of ' + THINKING_LEVELS.join(', '));
    const files = { [`agents/${name}.md`]: fm({ name, description, model: b.model || undefined, thinking: b.thinking || undefined, skills: Array.isArray(b.skills) ? b.skills.join(', ') : undefined }) + '\n' + str(b.instructions, 'instructions') + '\n' };
    return { kind, name, description, files, manifest: collect(files, name) };
  }
  if (kind === 'mcp') {
    if (!['http', 'sse', 'streamable-http'].includes(b.transport)) fail(400, 'transport must be http or sse');
    if (!['none', 'bearer', 'oauth'].includes(b.auth)) fail(400, 'auth must be none, bearer or oauth');
    const files = { '.mcp.json': JSON.stringify({ mcpServers: { [name]: { type: b.transport, url: b.url, auth: b.auth, ...(b.storage === true ? { storage: true } : {}) } } }, null, 2) };
    const manifest = collect(files, name);
    if (!manifest.items.mcp.length) fail(400, manifest.ignored[0] ?? 'invalid MCP server');
    return { kind, name, description, files, manifest };
  }
  return fail(400, 'kind must be skill, agent, mcp or module');
}

function safePath(p: unknown): string {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.split('/').some((s) => s === '..' || s === '' || s === '.') || p.split('/').length > LIMITS.depth) fail(400, `invalid path ${String(p)}`);
  return p as string;
}
function checkSize(files: Files) {
  const n = Object.keys(files).length;
  if (n > LIMITS.files) fail(400, `too many files (max ${LIMITS.files})`);
  if (Object.values(files).reduce((s, c) => s + Buffer.byteLength(c), 0) > LIMITS.bytes) fail(400, 'package too large (max 5 MB)');
}

// ---------- GitHub import (tarball from codeload; no git, no new dependencies) ----------

const GH_HOSTS = new Set(['github.com', 'codeload.github.com']);
async function ghFetch(url: string, hops = 0): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !GH_HOSTS.has(u.hostname)) fail(400, 'only https://github.com is supported');
  await assertPublicHost(url).catch(() => fail(400, 'that address is not allowed'));
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(LIMITS.timeoutMs), headers: { 'user-agent': 'hefyn-hub' } }).catch((e) => fail(502, `GitHub is unreachable (${(e as Error).message})`));
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc || hops >= 3) fail(502, 'too many redirects');
    return ghFetch(new URL(loc!, url).toString(), hops + 1);
  }
  if (res.status === 404) fail(404, 'repository or ref not found (private repositories are not supported)');
  if (!res.ok) fail(502, `GitHub answered HTTP ${res.status}`);
  return res;
}

interface Target { owner: string; repo: string; ref: string; path: string; gl?: GitlabTarget }
export function parseGithubUrl(raw: string, refOverride?: string): Target {
  let u: URL;
  try { u = new URL(raw); } catch { return fail(400, 'invalid URL'); }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password) fail(400, 'only https://github.com URLs are supported');
  const [owner, repoRaw, kind, urlRef, ...rest] = u.pathname.split('/').filter(Boolean);
  const repo = repoRaw?.replace(/\.git$/, '');
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) fail(400, 'expected https://github.com/owner/repo');
  if (kind && kind !== 'tree') fail(400, 'expected https://github.com/owner/repo[/tree/ref/path]');
  const ref = refOverride || urlRef || 'HEAD';
  if (!/^[\w./-]+$/.test(ref) || ref.includes('..')) fail(400, 'invalid ref');
  const path = rest.join('/');
  if (rest.includes('..')) fail(400, 'invalid path');
  return { owner: owner!, repo: repo!, ref, path };
}

async function fetchRepo(t: Target): Promise<TarEntry[]> {
  const res = t.gl ? await gitlabArchive(t.gl, t.ref) : await ghFetch(`https://codeload.github.com/${t.owner}/${t.repo}/tar.gz/${t.ref}`);
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    n += c.length;
    if (n > LIMITS.download) fail(400, 'repository archive too large');
    chunks.push(Buffer.from(c));
  }
  let tar: Buffer;
  try { tar = gunzipSync(Buffer.concat(chunks), { maxOutputLength: LIMITS.unpacked }); } catch { return fail(400, 'archive is corrupt or larger than 100 MB'); }
  // GitHub wraps everything in one <repo>-<sha>/ directory.
  let entries: TarEntry[];
  try { entries = readTar(tar); } catch { return fail(400, 'corrupt archive'); }
  return entries.map((e) => ({ ...e, path: e.path.replace(/^[^/]*\//, '') })).filter((e) => e.path && !e.path.startsWith('.git/') && !e.path.includes('node_modules/'));
}

/** A GitHub or GitLab repo URL as tar entries (its single top folder already removed) and the subfolder the URL points at. Assistant bundles import through this. */
export async function fetchTree(url: string): Promise<{ entries: TarEntry[]; path: string }> {
  const t = /^https:\/\/github\.com(\/|$)/i.test(url) ? parseGithubUrl(url) : parseGitlabUrl(url);
  return { entries: await fetchRepo(t), path: t.path };
}

/** Text files under `prefix`, with the import limits applied. Symlinks and hardlinks reject the import; binaries are skipped. */
export function selectFiles(entries: TarEntry[], prefix: string): Files {
  const pre = prefix ? prefix.replace(/\/$/, '') + '/' : '';
  const files: Files = {};
  let bytes = 0;
  const dec = new TextDecoder('utf-8', { fatal: true });
  for (const e of entries) {
    if (!e.path.startsWith(pre)) continue;
    if (e.type === '2' || e.type === '1') fail(400, `symlinks are not allowed (${e.path})`);
    if (e.type !== '0' && e.type !== '\0') continue;
    const rel = e.path.slice(pre.length);
    if (!rel || rel.split('/').length > LIMITS.depth) continue;
    if (e.data.subarray(0, 8000).includes(0)) continue;
    let text: string;
    try { text = dec.decode(e.data); } catch { continue; }
    if (Object.keys(files).length >= LIMITS.files) fail(400, `too many files (max ${LIMITS.files}); import a subfolder (…/tree/ref/path)`);
    bytes += e.data.length;
    if (bytes > LIMITS.bytes) fail(400, 'too large (max 5 MB of text); import a subfolder (…/tree/ref/path)');
    files[rel] = text;
  }
  return files;
}

interface Imported { draft: Draft; source: Source }

export async function fetchDrafts(url: string, refOverride?: string): Promise<Imported[]> {
  const t = /^https:\/\/github\.com(\/|$)/i.test(url) ? parseGithubUrl(url, refOverride) : parseGitlabUrl(url, refOverride);
  const entries = await fetchRepo(t);
  const pre = t.path ? t.path + '/' : '';
  const mkt = entries.find((e) => e.path === pre + '.claude-plugin/marketplace.json');
  const git: Source = { type: 'git', url, ref: t.ref };
  if (!mkt) return draftsFromTree(selectFiles(entries, t.path), { fallbackName: slug(t.path.split('/').pop() || t.repo) }).map((draft) => ({ draft, source: git }));
  const plugins: any[] = json(mkt.data.toString('utf8'))?.plugins;
  if (!Array.isArray(plugins) || !plugins.length) fail(400, 'marketplace.json lists no plugins');
  if (plugins.length > LIMITS.plugins) fail(400, `marketplace lists more than ${LIMITS.plugins} plugins`);
  const source: Source = { type: 'marketplace', url, ref: t.ref };
  const out: Imported[] = [];
  for (const p of plugins) {
    const s = p?.source;
    let files: Files;
    if (typeof s === 'string' && s.startsWith('./')) {
      const rel = s.slice(2).replace(/\/$/, '');
      if (rel.split('/').includes('..')) fail(400, `invalid plugin source ${s}`);
      files = selectFiles(entries, [t.path, rel].filter(Boolean).join('/'));
    } else {
      const repo = typeof s === 'string' ? s : s?.source === 'github' ? s.repo : s?.source === 'url' ? s.url : undefined;
      if (typeof repo !== 'string') { fail(400, `unsupported plugin source for ${p?.name}`); continue; }
      const sub = parseGithubUrl(/^https:/.test(repo) ? repo : `https://github.com/${repo}`, s?.ref);
      files = selectFiles(await fetchRepo(sub), sub.path);
    }
    for (const draft of draftsFromTree(files, { fallbackName: slug(String(p.name ?? 'plugin')), plugin: true, name: p.name, description: p.description })) out.push({ draft, source });
  }
  return out;
}

// ---------- MCP Registry (official; v0 shape verified against the live API) ----------

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
export interface RegistryHit { name: string; description: string; url: string; transport: 'streamable-http' | 'sse'; auth: Auth; repository?: string }

export async function registrySearch(q: string): Promise<RegistryHit[]> {
  const res = await fetch(`${REGISTRY}?${new URLSearchParams({ search: q, limit: '50' })}`, { redirect: 'error', signal: AbortSignal.timeout(LIMITS.timeoutMs) }).catch((e) => fail(502, `MCP Registry is unreachable (${(e as Error).message})`));
  if (!res.ok) fail(502, `MCP Registry answered HTTP ${res.status}`);
  const body: any = await res.json().catch(() => ({}));
  const hits: RegistryHit[] = [];
  for (const e of body.servers ?? []) {
    const s = e.server;
    if (!s || e._meta?.['io.modelcontextprotocol.registry/official']?.isLatest === false) continue;
    const r = (s.remotes ?? []).find((x: any) => (x.type === 'streamable-http' || x.type === 'sse') && typeof x.url === 'string' && !x.url.includes('{'));
    if (!r) continue; // only remote servers are importable
    const auth: Auth = (r.headers ?? []).some((h: any) => String(h.name).toLowerCase() === 'authorization') ? 'bearer' : 'none';
    hits.push({ name: s.name, description: s.description ?? '', url: r.url, transport: r.type, auth, ...(s.repository?.url ? { repository: s.repository.url } : {}) });
  }
  return hits;
}

// ---------- screening ----------

async function screen(d: Draft): Promise<Guarded> {
  const texts: [string, string][] = [['name/description', `${d.name}\n${d.description}`], ...Object.entries(d.files)];
  const reasons: string[] = [];
  for (let i = 0; i < texts.length; i += 8) {
    await Promise.all(texts.slice(i, i + 8).map(async ([p, t]) => {
      if (!t.trim()) return;
      const r = await guardFn(t).catch((e) => fail(502, `content screening unavailable, nothing was saved (${(e as Error).message})`));
      if (r.flagged) reasons.push(`${p}: ${r.reason || 'flagged'}`);
    }));
  }
  return { flagged: reasons.length > 0, reasons: reasons.sort() };
}

// ---------- storage ----------

const now = () => new Date().toISOString();
const row = (id: string) => db.prepare('SELECT * FROM packages WHERE id = ?').get(id) as unknown as Row | undefined;
const filesOf = (id: string): Files => Object.fromEntries((db.prepare('SELECT path, content FROM package_files WHERE package_id = ?').all(id) as any[]).map((f) => [f.path, f.content]));
const hashOf = (d: Draft) => createHash('sha256').update(JSON.stringify([Object.entries(d.files).sort(([a], [b]) => (a < b ? -1 : 1)), d.manifest.items, d.manifest.ignored, d.manifest.needsRunner])).digest('hex');

function tx<T>(f: () => T): T {
  if (db.isTransaction) return f(); // joins the caller's transaction (module install)
  db.exec('BEGIN');
  try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Create or (same owner, kind, name) update. A changed hash on a published package sends it back to `pending`; the approved snapshot stays. */
function save(ownerId: string, d: Draft, source: Source, g: Guarded, existing?: Row): Row {
  const hash = hashOf(d);
  const version = d.version || hash.slice(0, 8);
  existing ??= db.prepare('SELECT * FROM packages WHERE owner_id = ? AND kind = ? AND name = ?').get(ownerId, d.kind, d.name) as unknown as Row | undefined;
  return tx(() => {
    const id = existing?.id ?? randomUUID();
    if (!existing) {
      db.prepare(`INSERT INTO packages (id, kind, name, description, version, hash, source_json, visibility, status, owner_id, manifest_json, guard_json, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?, 'private', 'draft', ?,?,?,?,?)`).run(id, d.kind, d.name, d.description, version, hash, JSON.stringify(source), ownerId, JSON.stringify(d.manifest), JSON.stringify(g), now(), now());
    } else {
      const status = existing.hash === hash ? existing.status : existing.visibility === 'team' ? 'pending' : 'draft';
      db.prepare(`UPDATE packages SET description=?, version=?, hash=?, source_json=?, status=?, reject_reason=?, manifest_json=?, guard_json=?, updated_at=? WHERE id=?`)
        .run(d.description, version, hash, JSON.stringify(source), status, existing.hash === hash ? existing.reject_reason : null, JSON.stringify(d.manifest), JSON.stringify(g), now(), id);
      db.prepare('DELETE FROM package_files WHERE package_id = ?').run(id);
    }
    const ins = db.prepare('INSERT INTO package_files (package_id, path, content, size) VALUES (?,?,?,?)');
    for (const [p, c] of Object.entries(d.files)) ins.run(id, p, c, Buffer.byteLength(c));
    return row(id)!;
  });
}

// ---------- views & permissions ----------

type Viewer = Pick<Me, 'id' | 'permissions'>;
interface View { r: Row; live: boolean; status: Row['status']; version: string; hash: string; manifest: Manifest; snap?: Snapshot }

/** Owner and reviewers see live content; everybody else sees the approved snapshot of team packages only. */
function view(r: Row | undefined, me: Viewer): View | undefined {
  if (!r) return;
  if (r.kind === 'assistant' && r.owner_id !== me.id && !has(me, 'hub.approve')) return; // a shared Assistant is for its owner and the reviewers; the team gets the copy, not the package
  const snap = r.approved_json ? (JSON.parse(r.approved_json) as Snapshot) : undefined;
  if (r.owner_id === me.id || (r.visibility === 'team' && has(me, 'hub.approve'))) return { r, live: true, status: r.status, version: r.version, hash: r.hash, manifest: JSON.parse(r.manifest_json), snap };
  if (r.visibility === 'team' && snap) return { r, live: false, status: 'approved', version: snap.version, hash: snap.hash, manifest: snap.manifest, snap };
}
const seen = (id: string, me: Viewer) => view(row(id), me) ?? fail(404, 'package not found');
const publicManifest = (m: Manifest) => {
  const { skills, agents, mcp } = m.items;
  const one = skills.length + agents.length + mcp.length === 1;
  return {
    // single-item packages expose their editable fields at top level (HUB-API v1.1); bundles list their contents
    ...(one && skills[0] ? { instructions: skills[0].instructions } : {}),
    ...(one && mcp[0] ? { url: mcp[0].url, transport: mcp[0].transport, auth: mcp[0].auth, ...(mcp[0].storage ? { storage: true } : {}) } : {}),
    skills: skills.map((s) => ({ name: s.name, description: s.description, files: Object.keys(s.files) })),
    agents: agents.map((a) => ({ name: a.name, description: a.description, model: a.model, thinking: a.thinking, skills: a.skills })),
    mcp, ignored: m.ignored, needsRunner: m.needsRunner, plugin: m.plugin,
    // after the lists: an agent's top-level `skills` is its skill names (editable), not the bundle listing
    ...(one && agents[0] ? { instructions: agents[0].instructions, ...(agents[0].model ? { model: agents[0].model } : {}), ...(agents[0].thinking ? { thinking: agents[0].thinking } : {}), skills: agents[0].skills } : {}),
  };
};
const ownerName = (id: string) => { try { return (db.prepare('SELECT name FROM user WHERE id = ?').get(id) as any)?.name ?? id; } catch { return id; } };

function pkg(v: View, me: Viewer) {
  const { r } = v;
  const inst = (t: string) => r.kind === 'module' ? t === 'team' && !!db.prepare('SELECT 1 FROM modules WHERE hub_package = ?').get(r.id) : !!db.prepare("SELECT 1 FROM installs WHERE package_id = ? AND target = ? AND COALESCE(user_id, '') = ?").get(r.id, t, t === 'me' ? me.id : '');
  const g: Guarded = JSON.parse(r.guard_json);
  return {
    id: r.id, kind: r.kind, name: r.name, description: r.description, version: v.version, hash: v.hash, source: JSON.parse(r.source_json) as Source,
    visibility: r.visibility, status: v.status, ...(v.live && r.reject_reason ? { rejectReason: r.reject_reason } : {}),
    owner: { id: r.owner_id, name: ownerName(r.owner_id) }, installed: { me: inst('me'), team: inst('team') }, guard: g,
    ...(v.manifest.items.mcp.some((m) => m.storage) ? { storage: true } : {}), // the server offers filesystem-style tools: "use as storage"
    ...(r.kind === 'bundle' ? { contains: { skills: v.manifest.items.skills.map((s) => s.name), agents: v.manifest.items.agents.map((a) => a.name), mcp: v.manifest.items.mcp.map((m) => m.name) } } : {}),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export type Pkg = ReturnType<typeof pkg>;

export function listPackages(me: Viewer, f: { q?: string; kind?: string; status?: string; mine?: boolean } = {}): Pkg[] {
  const q = f.q?.toLowerCase();
  return (db.prepare('SELECT * FROM packages ORDER BY updated_at DESC').all() as unknown as Row[])
    .filter((r) => !f.mine || r.owner_id === me.id)
    .map((r) => view(r, me)).filter((v): v is View => !!v)
    .filter((v) => (!f.kind || v.r.kind === f.kind) && (!f.status || v.status === f.status) && (!q || `${v.r.name} ${v.r.description}`.toLowerCase().includes(q)))
    // approved team packages + own; reviewers additionally see everything team-published (pending first)
    .filter((v) => v.r.owner_id === me.id || v.status === 'approved' || has(me, 'hub.approve'))
    .map((v) => pkg(v, me));
}

export function getPackage(me: Viewer, id: string) {
  const v = seen(id, me);
  const files = v.live ? filesOf(id) : v.snap!.files;
  const readme = files['README.md'] ?? files['SKILL.md'] ?? Object.entries(files).find(([p]) => p.startsWith('agents/'))?.[1];
  return { ...pkg(v, me), manifest: publicManifest(v.manifest), files: Object.entries(files).map(([path, c]) => ({ path, size: Buffer.byteLength(c) })), ...(readme ? { readme } : {}) };
}

export function getFile(me: Viewer, id: string, path: string): string {
  const v = seen(id, me);
  return (v.live ? filesOf(id) : v.snap!.files)[path] ?? fail(404, 'file not found');
}

export async function createPackage(me: Viewer, body: unknown) {
  need(me, 'hub.install');
  const d = draftFromBody(body);
  if (db.prepare('SELECT 1 FROM packages WHERE owner_id = ? AND kind = ? AND name = ?').get(me.id, d.kind, d.name)) fail(409, `you already have a ${d.kind} named ${d.name}`);
  return pkg(view(save(me.id, d, { type: 'ui' }, await screen(d)), me)!, me);
}

const owned = (me: Viewer, id: string) => { const v = seen(id, me); if (v.r.owner_id !== me.id) fail(403, 'only the owner can do this'); return v.r; };

export async function updatePackage(me: Viewer, id: string, body: any) {
  const r = owned(me, id);
  if (JSON.parse(r.source_json).type !== 'ui') fail(400, 'imported packages are updated by importing again');
  // Missing fields keep their current value.
  const cur = JSON.parse(r.manifest_json).items as Items;
  const old: any = r.kind === 'skill' ? { ...cur.skills[0], files: Object.entries(cur.skills[0]!.files).map(([path, content]) => ({ path, content })) } : r.kind === 'agent' ? cur.agents[0] : { ...cur.mcp[0] };
  const d = draftFromBody({ ...old, description: r.description, ...body, kind: r.kind, name: r.name });
  return pkg(view(save(me.id, d, { type: 'ui' }, await screen(d), r), me)!, me);
}

export function deletePackage(me: Viewer, id: string) {
  const r = seen(id, me).r;
  if (r.owner_id !== me.id && !has(me, 'hub.approve')) fail(403, 'forbidden');
  tx(() => { for (const t of ['package_files', 'installs']) db.prepare(`DELETE FROM ${t} WHERE package_id = ?`).run(id); db.prepare('DELETE FROM packages WHERE id = ?').run(id); });
}

export async function importFromUrl(me: Viewer, url: string, ref?: string) {
  need(me, 'hub.install');
  const found = await fetchDrafts(await resolveSource(str(url, 'url', 500)), ref);
  const guarded: Guarded[] = [];
  for (const i of found) guarded.push(await screen(i.draft)); // all screened before anything is written
  return found.map((i, n) => pkg(view(save(me.id, i.draft, i.source, guarded[n]!), me)!, me));
}

export async function registryImport(me: Viewer, name: string) {
  need(me, 'hub.install');
  const hit = (await registrySearch(str(name, 'name', 300))).find((h) => h.name === name) ?? fail(404, 'no importable remote server with that name in the MCP Registry');
  const d = draftFromBody({ kind: 'mcp', name: slug(hit.name), description: hit.description || hit.url, url: hit.url, transport: hit.transport, auth: hit.auth });
  return pkg(view(save(me.id, d, { type: 'mcp-registry', url: hit.repository }, await screen(d)), me)!, me);
}

// ---------- review process ----------

export async function publish(me: Viewer, id: string) {
  need(me, 'hub.publish');
  const r = owned(me, id);
  const g: Guarded = JSON.parse(r.guard_json);
  const direct = has(me, 'hub.approve') && !g.flagged; // flagged content is never auto-approved
  db.prepare("UPDATE packages SET visibility = 'team', status = 'pending', reject_reason = NULL, updated_at = ? WHERE id = ?").run(now(), id);
  if (direct) approveRow(id);
  return pkg(view(row(id), me)!, me);
}

function approveRow(id: string) {
  const r = row(id)!;
  const snap: Snapshot = { version: r.version, hash: r.hash, manifest: JSON.parse(r.manifest_json), files: filesOf(id) };
  db.prepare("UPDATE packages SET status = 'approved', reject_reason = NULL, approved_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(snap), now(), id);
}

export function approve(me: Viewer, id: string) {
  need(me, 'hub.approve');
  const r = seen(id, me).r;
  if (r.visibility !== 'team' || r.status !== 'pending') fail(409, 'only pending packages can be approved');
  approveRow(id);
  if (r.kind === 'assistant') reviewHooks.assistant?.(id, 'approved');
  return pkg(view(row(id), me)!, me);
}

export function reject(me: Viewer, id: string, reason: unknown) {
  need(me, 'hub.approve');
  const r = seen(id, me).r;
  if (r.visibility !== 'team' || r.status !== 'pending') fail(409, 'only pending packages can be rejected');
  db.prepare("UPDATE packages SET status = 'rejected', reject_reason = ?, updated_at = ? WHERE id = ?").run(str(reason, 'reason', 2000), now(), id);
  if (r.kind === 'assistant') reviewHooks.assistant?.(id, 'rejected', typeof reason === 'string' ? reason : undefined);
  return pkg(view(row(id), me)!, me);
}

export function reviewQueue(me: Viewer): Pkg[] {
  need(me, 'hub.approve');
  return (db.prepare("SELECT * FROM packages WHERE visibility = 'team' AND status = 'pending' ORDER BY updated_at").all() as unknown as Row[]).map((r) => pkg(view(r, me)!, me));
}

// ---------- install ----------

const targetOf = (me: Viewer, t: unknown) => {
  if (t !== 'me' && t !== 'team') fail(400, "target must be 'me' or 'team'");
  need(me, 'hub.install');
  if (t === 'team') need(me, 'profiles.edit_team');
  return t as 'me' | 'team';
};
const count = (m: Manifest) => m.items.skills.length + m.items.agents.length + m.items.mcp.length;

// A module package is installed for the whole instance by `modules.manage`; the caller then runs the module installer (no installs row).
const isModule = (id: string) => row(id)?.kind === 'module';
const moduleTarget = (me: Viewer) => { need(me, 'modules.manage'); return 'team' as const; };

/** The manifest a module package carries: approved snapshot first. */
export function moduleSource(id: string): unknown {
  const r = row(id);
  const files = r?.approved_json ? (JSON.parse(r.approved_json) as Snapshot).files : r ? filesOf(id) : {};
  return json(files[MODULE_FILE]);
}

export function install(me: Viewer, id: string, target: unknown) {
  const mod = isModule(id);
  const t = mod ? moduleTarget(me) : targetOf(me, target);
  const v = seen(id, me);
  const approved = v.r.visibility === 'team' && !!v.snap;
  if (!approved && !(t === 'me' && v.r.owner_id === me.id)) fail(409, 'only approved packages can be installed (your own private packages: for yourself only)');
  if (mod) return pkg(v, me);
  if (!count(v.snap?.manifest ?? v.manifest)) fail(409, `nothing installable in this package${v.manifest.needsRunner.length ? ' (' + v.manifest.needsRunner.join('; ') + ')' : ''}`);
  db.prepare('INSERT OR IGNORE INTO installs (package_id, target, user_id, created_at) VALUES (?,?,?,?)').run(id, t, t === 'me' ? me.id : null, now());
  return pkg(v, me);
}

export function uninstall(me: Viewer, id: string, target: unknown) {
  const t = isModule(id) ? moduleTarget(me) : targetOf(me, target);
  const v = seen(id, me);
  db.prepare("DELETE FROM installs WHERE package_id = ? AND target = ? AND COALESCE(user_id, '') = ?").run(id, t, t === 'me' ? me.id : '');
  return pkg(v, me);
}

export function installedList(me: Viewer) {
  const of = (sql: string, ...a: string[]) => (db.prepare(sql).all(...a) as unknown as Row[]).map((r) => view(r, me)).filter((v): v is View => !!v).map((v) => pkg(v, me));
  return {
    me: of("SELECT p.* FROM installs i JOIN packages p ON p.id = i.package_id WHERE i.target = 'me' AND i.user_id = ?", me.id),
    team: of("SELECT p.* FROM installs i JOIN packages p ON p.id = i.package_id WHERE i.target = 'team'"),
  };
}

export interface Installed { skills: SkillItem[]; agents: AgentItem[]; mcp: McpItem[]; warnings: string[] }

/**
 * What an agent run gets: team installs, then the user's own. Approved snapshots only; the exception is the owner's own
 * never-approved package installed for themselves (live content). Name collisions: the first wins (team before own), the
 * rest is skipped and reported in `warnings`.
 */
export function installedFor(userId: string): Installed {
  const out: Installed = { skills: [], agents: [], mcp: [], warnings: [] };
  const rows = db.prepare(`SELECT p.*, i.target FROM installs i JOIN packages p ON p.id = i.package_id
    WHERE i.target = 'team' OR (i.target = 'me' AND i.user_id = ?) ORDER BY (i.target = 'team') DESC, i.created_at`).all(userId) as unknown as (Row & { target: string })[];
  const done = new Set<string>();
  const owner: Record<string, string> = {};
  for (const r of rows) {
    if (done.has(r.id)) continue;
    done.add(r.id);
    const m: Manifest | undefined = r.approved_json ? (JSON.parse(r.approved_json) as Snapshot).manifest : r.target === 'me' && r.owner_id === userId ? JSON.parse(r.manifest_json) : undefined;
    if (!m) continue;
    for (const kind of ['skills', 'agents', 'mcp'] as const) {
      for (const it of m.items[kind] as { name: string }[]) {
        const key = `${kind}:${it.name}`;
        if (owner[key]) { out.warnings.push(`skipped ${kind.replace(/s$/, '')} "${it.name}" from "${r.name}": name already provided by "${owner[key]}"`); continue; }
        owner[key] = r.name;
        (out[kind] as unknown[]).push(it);
      }
    }
  }
  return out;
}

export interface ConnectorData { name: string; url: string; transport: 'streamable-http' | 'sse'; auth: Auth; source: string }

/**
 * Connector entries a user needs after installing a package (target 'me'; for 'team' every user gets them when
 * Connectors resolves team installs). No credentials are stored here: bearer/OAuth sign-in happens in Connectors.
 * The Connectors code owns the table; see docs/HUB.md.
 */
export function onMcpInstall(_userId: string, id: string): ConnectorData[] {
  const r = row(id);
  if (!r) return [];
  const m: Manifest = r.approved_json ? (JSON.parse(r.approved_json) as Snapshot).manifest : JSON.parse(r.manifest_json);
  return m.items.mcp.map((s) => ({ ...s, source: `hub:${id}` }));
}

// ---------- module items ----------

/**
 * A module's skills and agents become approved team packages owned by the installer and installed for the team; `source.url` =
 * `module:<id>` finds them again. Nothing is screened here: the Admin installing a module vouches for it (the Hub path screens it).
 * Runs inside the caller's transaction. A name the installer already uses is a 409, never an overwrite.
 */
export function installModuleItems(ownerId: string, moduleId: string, items: { skills?: { name: string; description: string; instructions: string }[]; agents?: { name: string; description: string; instructions: string; model?: string; skills?: string[] }[] }) {
  const all = [...(items.skills ?? []).map((s) => ({ ...s, kind: 'skill' })), ...(items.agents ?? []).map((a) => ({ ...a, kind: 'agent' }))];
  for (const it of all) {
    const d = draftFromBody(it);
    if (db.prepare('SELECT 1 FROM packages WHERE owner_id = ? AND kind = ? AND name = ?').get(ownerId, d.kind, d.name)) fail(409, `you already have a ${d.kind} named ${d.name}`);
    const r = save(ownerId, d, { type: 'ui', url: `module:${moduleId}` }, { flagged: false, reasons: [] });
    db.prepare("UPDATE packages SET visibility = 'team', status = 'pending' WHERE id = ?").run(r.id);
    approveRow(r.id);
    db.prepare("INSERT INTO installs (package_id, target, user_id, created_at) VALUES (?, 'team', NULL, ?)").run(r.id, now());
  }
}

export function removeModuleItems(moduleId: string) {
  for (const p of db.prepare("SELECT id FROM packages WHERE json_extract(source_json, '$.url') = ?").all(`module:${moduleId}`) as { id: string }[]) {
    for (const t of ['package_files', 'installs']) db.prepare(`DELETE FROM ${t} WHERE package_id = ?`).run(p.id);
    db.prepare('DELETE FROM packages WHERE id = ?').run(p.id);
  }
}

// ---------- skills page (Skills in the console): own skills, and the team's ----------

/** Share a skill with the team: whoever holds `skills.share` makes it team-visible at once. Only content the screening flagged waits for a reviewer (`hub.approve`). */
export function shareSkill(me: Viewer, id: string) {
  need(me, 'skills.share');
  const r = owned(me, id);
  if (r.kind !== 'skill') fail(400, 'only a skill can be shared this way');
  db.prepare("UPDATE packages SET visibility = 'team', status = 'pending', reject_reason = NULL, updated_at = ? WHERE id = ?").run(now(), id);
  if (!(JSON.parse(r.guard_json) as Guarded).flagged) approveRow(id);
  return pkg(view(row(id), me)!, me);
}
/** Back to private: the team no longer gets it (what the team installed of it goes too). */
export function unshareSkill(me: Viewer, id: string) {
  const r = owned(me, id);
  if (r.kind !== 'skill') fail(400, 'only a skill can be shared this way');
  db.prepare("UPDATE packages SET visibility = 'private', status = 'draft', approved_json = NULL, updated_at = ? WHERE id = ?").run(now(), id);
  db.prepare("DELETE FROM installs WHERE package_id = ? AND target = 'team'").run(id);
  return pkg(view(row(id), me)!, me);
}
/** A skill as an agent gets it: the user's own (what they wrote now), or a team skill's approved snapshot. undefined: not a skill, or not theirs to use. */
export function skillContent(userId: string, id: string): { name: string; description: string; files: Files } | undefined {
  const r = row(id);
  if (r?.kind !== 'skill') return;
  if (r.owner_id === userId) return { name: r.name, description: r.description, files: filesOf(id) };
  if (r.visibility === 'team' && r.approved_json) return { name: r.name, description: r.description, files: (JSON.parse(r.approved_json) as Snapshot).files };
}
/** Ids of the skills a user has: their own, then the team's approved ones. */
export const skillIdsOf = (userId: string): string[] => (db.prepare("SELECT id FROM packages WHERE kind = 'skill' AND (owner_id = ? OR (visibility = 'team' AND approved_json IS NOT NULL)) ORDER BY (owner_id = ?) DESC, name").all(userId, userId) as { id: string }[]).map((r) => r.id);
