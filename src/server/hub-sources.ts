import { HubError, LIMITS } from './hub.ts';
import { assertPublicHost, assertPublicUrl } from './mcp.ts';

// Extra import sources for the Hub (docs/HUB.md): GitLab archives and the SkillsMP skill search. Parses and downloads text only.
// The web process fetches directly, like the GitHub import; the agent egress proxy (egress-list.ts) is not involved.

const fail = (status: HubError['status'], msg: string): never => { throw new HubError(status, msg); };

// ---------- GitLab (gitlab.com and self-hosted, public projects, https only) ----------

export interface GitlabTarget { host: string; project: string }
export interface GlTarget { owner: string; repo: string; ref: string; path: string; gl: GitlabTarget }

/** `https://<host>/<group…>/<project>[/-/tree/<ref>/<path>]`. The host must be public; ref and path are validated like the GitHub ones. */
export function parseGitlabUrl(raw: string, refOverride?: string): GlTarget {
  let u: URL;
  try { u = new URL(raw); } catch { return fail(400, 'invalid URL'); }
  if (u.protocol !== 'https:' || u.username || u.password) fail(400, 'only https URLs are supported (https://github.com or a GitLab project)');
  try { assertPublicUrl(raw); } catch (e) { fail(400, (e as Error).message); }
  const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const dash = segs.indexOf('-');
  const proj = dash < 0 ? segs : segs.slice(0, dash);
  const rest = dash < 0 ? [] : segs.slice(dash + 1);
  if (proj.length) proj[proj.length - 1] = proj[proj.length - 1]!.replace(/\.git$/, '');
  if (proj.length < 2 || !proj.every((s) => /^[\w.-]+$/.test(s) && s !== '..')) fail(400, 'expected https://<gitlab host>/group/project[/-/tree/ref/path]');
  if (rest.length && rest[0] !== 'tree') fail(400, 'expected https://<gitlab host>/group/project[/-/tree/ref/path]');
  const ref = refOverride || rest[1] || 'HEAD'; // HEAD = the default branch (no sha parameter)
  if (!/^[\w./-]+$/.test(ref) || ref.includes('..')) fail(400, 'invalid ref');
  const path = rest.slice(2);
  if (path.includes('..')) fail(400, 'invalid path');
  return { owner: u.host, repo: proj[proj.length - 1]!, ref, path: path.join('/'), gl: { host: u.host, project: proj.join('/') } };
}

/** The project archive through the GitLab API. Manual redirects, same host only. A sign-in redirect or 401/403/404 means a private (or missing) project. */
export async function gitlabArchive(g: GitlabTarget, ref: string, hops = 0, url?: string): Promise<Response> {
  url ??= `https://${g.host}/api/v4/projects/${encodeURIComponent(g.project)}/repository/archive.tar.gz${ref === 'HEAD' ? '' : `?sha=${encodeURIComponent(ref)}`}`;
  await assertPublicHost(url).catch(() => fail(400, 'that address is not allowed')); // every hop, resolved: a public name that points inside is refused
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(LIMITS.timeoutMs), headers: { 'user-agent': 'hefyn-hub' } }).catch((e) => fail(502, `${g.host} is unreachable (${(e as Error).message})`));
  const missing = 'project or ref not found (private projects are not supported)';
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc || hops >= 3) fail(502, 'too many redirects');
    const next = new URL(loc!, url);
    if (next.protocol !== 'https:' || next.host !== g.host) fail(400, `redirect to another host refused (${next.host})`);
    if (/sign_in/.test(next.pathname)) fail(404, missing);
    return gitlabArchive(g, ref, hops + 1, next.toString());
  }
  if ([401, 403, 404].includes(res.status)) fail(404, missing);
  if (!res.ok) fail(502, `${g.host} answered HTTP ${res.status}`);
  return res;
}

// ---------- SkillsMP (https://skillsmp.com/openapi.json; anonymous 50/day, 10/min per IP) ----------

export interface SkillHit { id: string; name: string; author: string; description: string; stars: number; updatedAt: string; githubUrl: string; skillUrl: string }
export interface SkillSearch { skills: SkillHit[]; page: number; hasNext: boolean }

const SKILLSMP = 'https://skillsmp.com/api/v1/skills/search';
const TTL = 10 * 60_000;
const cache = new Map<string, { at: number; data: SkillSearch }>();
export const clearSkillsmpCache = () => cache.clear();

const iso = (n: unknown) => { const t = Number(n); return Number.isFinite(t) && t > 0 ? new Date(t < 1e12 ? t * 1000 : t).toISOString() : ''; };

/** Identical queries are served from memory for 10 minutes to save quota. The optional HEFYN_SKILLSMP_API_KEY raises the limits. */
export async function skillsmpSearch(q: string, page = 1): Promise<SkillSearch> {
  q = q.trim();
  if (!q || q.length > 200) fail(400, 'search text is required (max 200 characters)');
  page = Number.isInteger(page) && page > 0 ? page : 1;
  const key = `${q.toLowerCase()}|${page}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const apiKey = process.env.HEFYN_SKILLSMP_API_KEY;
  const res = await fetch(`${SKILLSMP}?${new URLSearchParams({ q, page: String(page), limit: '20' })}`, {
    redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'hefyn-hub', accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
  }).catch((e) => fail(502, `SkillsMP is unreachable (${(e as Error).message})`));
  if (res.status === 429) fail(502, 'SkillsMP search limit reached for today. Paste a link instead.');
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) fail(res.status === 400 ? 400 : 502, `SkillsMP answered HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''}`);
  const skills: SkillHit[] = (body.data?.skills ?? [])
    .filter((s: any) => typeof s?.githubUrl === 'string' && s.githubUrl.startsWith('https://github.com/')) // the only source the importer reads from SkillsMP
    .map((s: any) => ({ id: String(s.id), name: String(s.name ?? ''), author: String(s.author ?? ''), description: String(s.description ?? ''), stars: Number(s.stars) || 0, updatedAt: iso(s.updatedAt), githubUrl: s.githubUrl, skillUrl: String(s.skillUrl ?? '') }));
  const data: SkillSearch = { skills, page, hasNext: !!body.data?.pagination?.hasNext };
  if (cache.size > 200) cache.clear();
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** A skillsmp.com skill page URL -> its GitHub URL (looked up by slug through the search API); other URLs pass through. */
export async function resolveSource(url: string): Promise<string> {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  if (u.protocol !== 'https:' || !/^(www\.)?skillsmp\.com$/.test(u.hostname)) return url;
  const slug = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
  if (!slug || slug === 'skills') fail(400, 'expected a SkillsMP skill page URL (https://skillsmp.com/skills/…)');
  // page slugs look like `skills-nano-pdf`; ids like `owner-repo-skills-nano-pdf-skill-md`; the search wants the skill's own name
  const { skills } = await skillsmpSearch(slug.replace(/-skill-md$/, '').split(/(?:^|-)skills?-/).pop()!.replace(/[-_]+/g, ' '));
  const found = skills.find((s) => s.id === slug || (s.skillUrl && new URL(s.skillUrl).pathname.replace(/\/$/, '') === u.pathname.replace(/\/$/, '')));
  return found?.githubUrl ?? fail(404, 'could not find that skill on SkillsMP. Paste its GitHub link instead.');
}
