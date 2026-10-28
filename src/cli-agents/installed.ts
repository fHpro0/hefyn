import { db } from '../server/appdb.ts';
import { type AgentSource, moduleAgents } from './agent-modules.ts';
import { type AgentProfile, type Api, PROFILES, canonicalAgent, profileOf } from './profiles.ts';
import { type RegistryAgent, registry, resetRegistryCache } from './registry.ts';

// Installed CLI agents (table cli_agents, filled by the admin through the `agents` router): the catalog merge, the install request the runner gets,
// and who may use what. The files themselves live in the hefyn-agents volume, written only by the runner's installer container (docs/SANDBOX.md).

export class AgentError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

export interface AgentRow { id: string; version: string; status: 'installing' | 'ready' | 'failed'; error: string | null; enabled: number; roles: string; key_provider: string | null; installed_at: string | null;
  default_provider?: string | null; default_model?: string | null; auto_update?: number | null; update_version?: string | null; retired?: string | null; cli_version?: string | null; last_checked?: string | null; last_update_error?: string | null; last_update_error_at?: string | null }
export const rowOf = (id: string) => db.prepare('SELECT * FROM cli_agents WHERE id = ?').get(id) as AgentRow | undefined;
export const allRows = () => db.prepare('SELECT * FROM cli_agents').all() as unknown as AgentRow[];
const rolesOf = (r: Pick<AgentRow, 'roles'>): string[] => { try { const j = JSON.parse(r.roles); return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : ['!']; } catch { return ['!']; } }; // unreadable: no role matches, never "every role"

// ---- the runner's agent endpoints (web -> runner, internal token) ----
async function runner(method: string, path: string, body?: unknown): Promise<any> {
  const base = (process.env.HEFYN_RUNNER_URL ?? '').replace(/\/$/, '');
  if (!base) throw new AgentError(503, 'This hefyn has no sandbox runner, so agents cannot be installed.');
  const res = await fetch(base + path, { method, headers: { 'x-hefyn-internal': process.env.HEFYN_INTERNAL_TOKEN ?? '', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
    .catch((e) => { throw new AgentError(502, `The sandbox runner is unreachable (${(e as Error).message}).`); });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new AgentError(res.status === 503 || res.status === 429 ? 503 : 502,j.error ?? `the sandbox runner answered ${res.status}`);
  return j;
}

// ---- install ----
/** The distribution of an agent module as a registry entry: the registry's own (under the module's id) when the module names a registry id, else built from what it declares. */
export function entryOf(p: AgentProfile, reg: RegistryAgent[]): RegistryAgent | undefined {
  const d = p.spec.distribution, base = { id: p.registryId, name: p.name, description: p.description, ...(p.spec.license ? { license: p.spec.license } : {}), ...(p.spec.licenseUrl ? { license_url: p.spec.licenseUrl } : {}) };
  if ('registry' in d) { const e = reg.find((a) => a.id === d.registry); return e && { ...e, id: p.registryId }; }
  if ('npm' in d) return { ...base, version: d.version, distribution: { npx: { package: d.npm } } };
  const bin = p.binary!;
  return { ...base, version: d.version, distribution: { binary: Object.fromEntries(Object.entries(d.binary).map(([k, e]) => [k, { archive: e.archive, sha256: e.sha256, cmd: bin.cmd, args: bin.args }])) } };
}

/** What the runner is asked to install, from the registry entry, and only if the entry still launches the way hefyn's profile does. Throws AgentError. */
export function installRequest(entry: RegistryAgent, profile: AgentProfile) {
  const d = entry.distribution;
  if (profile.npm) {
    const pkg = d.npx?.package;
    if (!pkg) throw new AgentError(409, 'The registry no longer distributes this agent as an npm package, which hefyn needs. hefyn has to be updated first.');
    if (pkg.slice(0, pkg.lastIndexOf('@')) !== profile.npm.package || (d.npx?.args?.length ?? 0) > 0) throw new AgentError(409, 'The registry changed how this agent is started. hefyn has to be updated before it can install it.');
    return { id: entry.id, version: entry.version, check: [`node_modules/.bin/${profile.npm.bin}`, ...(profile.npm.check ?? [])], distribution: { npx: { package: pkg, extra: profile.npm.extra ?? [] } } };
  }
  const bin = profile.binary!, linux = Object.fromEntries(Object.entries(d.binary ?? {}).filter(([k]) => k.startsWith('linux-')));
  if (!Object.keys(linux).length) throw new AgentError(409, 'This agent has no download for Linux.');
  for (const e of Object.values(linux)) if (e.cmd !== bin.cmd || JSON.stringify(e.args ?? []) !== JSON.stringify(bin.args)) throw new AgentError(409, 'The registry changed how this agent is started. hefyn has to be updated before it can install it.');
  return { id: entry.id, version: entry.version, check: [], distribution: { binary: linux } };
}

const fail = (id: string, message: string) => db.prepare("UPDATE cli_agents SET status = 'failed', error = ? WHERE id = ?").run(message.slice(0, 500), id);

// ---- updates: the new version is installed next to the running one (the runner keeps a directory per version) ----
// The row keeps the old version, `ready`, until the new one is installed; then new sessions start on the new one. A session that is open keeps its version's
// files (it holds a lease, taken in host.ts); a replaced version is listed in `retired` and removed once nothing holds a lease on it.
const leases = new Map<string, number>();
/** A running agent process (ACP or terminal) holds its version's files; call the result when it is gone. */
export function lease(id: string, version: string): () => void {
  const k = `${id}/${version}`; let done = false;
  leases.set(k, (leases.get(k) ?? 0) + 1);
  return () => { if (done) return; done = true; const n = (leases.get(k) ?? 1) - 1; if (n > 0) leases.set(k, n); else leases.delete(k); };
}
export const inUse = (id: string, version: string) => leases.has(`${id}/${version}`);
// shortcut: leases are in memory of this web process (the only one that runs agents); after a restart no session is open, so the next reconcile removes what is retired.

/** Numeric comparison of dotted versions (1.19.4 > 1.9.0; a pre-release tag is ignored). 1 / 0 / -1. */
export function compareVersions(a: string, b: string): number {
  const n = (v: string) => v.split(/[-+]/)[0]!.split('.').map((x) => parseInt(x, 10) || 0);
  const x = n(a), y = n(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
/** Agents that follow the ACP Registry update themselves unless the admin turned it off; an agent module with its own pinned distribution is updated by hand. */
export const autoUpdateOn = (r: Pick<AgentRow, 'auto_update'>, p: AgentProfile) => (r.auto_update == null ? 'registry' in p.spec.distribution : !!r.auto_update);
/** The version an update would install: the entry's, if it is newer than the installed one and nothing is in progress. */
export const updateTarget = (r: Pick<AgentRow, 'status' | 'version' | 'update_version'>, entry: Pick<RegistryAgent, 'version'> | undefined) =>
  entry && r.status === 'ready' && !r.update_version && compareVersions(entry.version, r.version) > 0 ? entry.version : null;

const updateFailed = (id: string, to: string, message: string) => {
  const r = rowOf(id);
  db.prepare('UPDATE cli_agents SET update_version = NULL, last_update_error = ?, last_update_error_at = ? WHERE id = ?')
    .run(`Could not update to ${to}${r ? `; still on ${r.version}, which keeps working` : ''}. ${message}`.slice(0, 500), new Date().toISOString(), id);
};

async function startUpdate(id: string, req: ReturnType<typeof installRequest>) {
  db.prepare('UPDATE cli_agents SET update_version = ?, last_update_error = NULL, last_update_error_at = NULL WHERE id = ?').run(req.version, id);
  try {
    const st = await runner('POST', '/agents/install', req);
    if (st.state === 'ready') await reconcile();
  } catch (e) { updateFailed(id, req.version, (e as Error).message); }
}

/** Install (or update to) the registry's current version. Returns at once; the runner works on, and `reconcile` picks up the result. */
export async function installAgent(id: string) {
  const profile = profileOf(id);
  if (!profile) throw new AgentError(400, 'This agent is not available. Add it as an agent module first.');
  const entry = entryOf(profile, 'registry' in profile.spec.distribution ? (await registry()).agents : []);
  if (!entry) throw new AgentError(400, 'The ACP Registry does not list this agent right now, so there is nothing to install. Try again later.');
  const req = installRequest(entry, profile);
  const prev = rowOf(id);
  if (prev?.status === 'installing' || prev?.update_version) return;
  if (prev?.status === 'ready' && prev.version !== entry.version) return startUpdate(id, req); // side by side: the agent stays usable
  db.prepare("INSERT INTO cli_agents (id, version, status, error, enabled, roles, key_provider, installed_at) VALUES (?, ?, 'installing', NULL, 0, '[]', NULL, NULL) ON CONFLICT(id) DO UPDATE SET version = excluded.version, status = 'installing', error = NULL")
    .run(id, entry.version);
  try {
    const st = await runner('POST', '/agents/install', req);
    if (st.state === 'ready') await reconcile();
  } catch (e) { fail(id, (e as Error).message); }
}

const retiredOf = (r: Pick<AgentRow, 'retired'>): string[] => { try { const j = JSON.parse(r.retired ?? '[]'); return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : []; } catch { return []; } };

/** Bring the rows up to date with the runner (the catalog and the update job call this): finished installs and updates, replaced versions to remove, the agents' own versions. */
export async function reconcile() {
  for (const r of allRows()) {
    if (r.status === 'installing') {
      let st: { state: string; error?: string };
      try { st = await runner('GET', `/agents/${r.id}/${r.version}`); } catch { continue; } // the runner is down: unchanged
      if (st.state === 'ready') db.prepare("UPDATE cli_agents SET status = 'ready', error = NULL, installed_at = ?, cli_version = NULL WHERE id = ?").run(new Date().toISOString(), r.id);
      else if (st.state === 'failed') fail(r.id, st.error ?? 'The install failed.');
      else if (st.state === 'none') fail(r.id, 'The install did not finish (it timed out or the server restarted). Try again.');
    } else if (r.status === 'ready' && r.update_version) {
      let st: { state: string; error?: string };
      try { st = await runner('GET', `/agents/${r.id}/${r.update_version}`); } catch { continue; }
      if (st.state === 'ready') {
        db.prepare("UPDATE cli_agents SET version = update_version, update_version = NULL, retired = ?, installed_at = ?, cli_version = NULL, last_update_error = NULL, last_update_error_at = NULL WHERE id = ?")
          .run(JSON.stringify([...new Set([...retiredOf(r), r.version])]), new Date().toISOString(), r.id);
      } else if (st.state === 'failed') updateFailed(r.id, r.update_version, st.error ?? 'The install failed.');
      else if (st.state === 'none') updateFailed(r.id, r.update_version, 'The install did not finish (it timed out or the server restarted). It is tried again at the next check.');
    }
  }
  for (const r of allRows().filter((x) => x.status === 'ready')) {
    const left = retiredOf(r);
    for (const v of left.filter((x) => x !== r.version && x !== r.update_version && !inUse(r.id, x))) {
      try { await runner('DELETE', `/agents/${r.id}/${v}`); left.splice(left.indexOf(v), 1); } catch { /* the next pass tries again */ }
    }
    if (left.length !== retiredOf(r).length) db.prepare('UPDATE cli_agents SET retired = ? WHERE id = ?').run(JSON.stringify(left), r.id);
    const spec = profileOf(r.id)?.spec.cliVersion;
    if (spec && !r.cli_version) {
      try {
        const j = await runner('POST', `/agents/${r.id}/${r.version}/json`, { path: spec.packageJson, field: spec.field });
        if (typeof j.value === 'string') db.prepare('UPDATE cli_agents SET cli_version = ? WHERE id = ? AND version = ?').run(j.value, r.id, r.version);
      } catch { /* shown as the adapter's version until the next pass */ }
    }
  }
}

/** Look at the registry and start the updates of the agents that update themselves. `fresh`: ignore the registry cache (the admin asked). Never throws; a failed update keeps the old version. */
export async function checkUpdates(fresh = false) {
  if (fresh) resetRegistryCache();
  await reconcile();
  const reg = (await registry()).agents, now = new Date().toISOString();
  for (const r of allRows().filter((x) => x.status === 'ready')) {
    const p = profileOf(r.id);
    if (!p) continue;
    db.prepare('UPDATE cli_agents SET last_checked = ? WHERE id = ?').run(now, r.id);
    const entry = entryOf(p, reg), to = updateTarget(r, entry);
    if (!to || !autoUpdateOn(r, p)) continue;
    try { await startUpdate(r.id, installRequest(entry!, p)); } catch (e) { updateFailed(r.id, to, (e as Error).message); }
  }
}

export const CHECK_EVERY_MS = 6 * 3_600_000;
let lastCheck = 0;
/** The background job (src/modules/builtin.ts): finishes updates and removes replaced versions often, asks the registry every 6 hours. */
export async function updateTick(now = Date.now()) {
  if (!allRows().length || !process.env.HEFYN_RUNNER_URL) return;
  if (now - lastCheck >= CHECK_EVERY_MS) { lastCheck = now; await checkUpdates(); } else await reconcile();
}

export async function uninstallAgent(id: string) {
  const r = rowOf(id);
  if (!r) throw new AgentError(404, 'This agent is not installed.');
  if (process.env.HEFYN_RUNNER_URL) {
    await runner('DELETE', `/agents/${r.id}/${r.version}`).catch((e) => { if (r.status !== 'failed') throw e; }); // a failed install may have left nothing, or the runner may be gone
    for (const v of [...retiredOf(r), ...(r.update_version ? [r.update_version] : [])]) await runner('DELETE', `/agents/${r.id}/${v}`).catch(() => {});
  }
  db.prepare('DELETE FROM cli_agents WHERE id = ?').run(id);
}

// ---- the catalog (what the admin sees) ----
export interface CatalogItem {
  id: string; name: string; registryName: string; description: string; icon: string | null;
  /** The agent's own version (Claude Code 2.1.310) where known: the installed one, else the adapter's. `adapterVersion`: the ACP adapter's (the registry's) version, installed or current. */
  version: string; adapterVersion: string; license: string | null; licenseUrl: string | null;
  api: Api; actsWithoutAsking: boolean; source: AgentSource;
  installed: null | { version: string; status: AgentRow['status']; error?: string };
  enabled: boolean; roles: string[]; keyProvider: string | null; defaultProvider: string | null; defaultModel: string | null;
  /** The adapter version the registry offers when it is newer than the installed one (the agent's own version of it is only known once installed). */
  updateAvailable: string | null;
  autoUpdate: boolean; lastChecked: string | null; lastUpdateError: { message: string; at: string | null } | null;
  /** The version being installed next to the current one; the agent stays usable meanwhile. */
  updating: string | null;
}
/** The agents that have a module (built-in or added), with the registry's version, icon and licence where the module uses the registry, and install state; by name. */
export function mergeCatalog(reg: RegistryAgent[], rows: AgentRow[]): CatalogItem[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const defs = [...Object.values(PROFILES).map((profile) => ({ profile, source: { type: 'builtin' } as AgentSource })), ...moduleAgents().filter((m) => !Object.hasOwn(PROFILES, m.profile.registryId))];
  return defs.map(({ profile: p, source }) => {
    const a = entryOf(p, reg), r = byId.get(p.registryId), latest = a?.version ?? '', adapterVersion = r?.version ?? latest;
    return {
      id: p.registryId, name: p.name, registryName: a?.name ?? p.name, description: p.description, icon: p.spec.icon ?? a?.icon ?? null, version: (r ? r.cli_version : null) || adapterVersion, adapterVersion, license: a?.license ?? null, licenseUrl: a?.license_url ?? null,
      api: p.api, actsWithoutAsking: !!p.actsWithoutAsking, source,
      installed: r ? { version: r.version, status: r.status, ...(r.error ? { error: r.error } : {}) } : null,
      enabled: !!r?.enabled, roles: r ? rolesOf(r) : [], keyProvider: r?.key_provider ?? null, defaultProvider: r?.default_provider ?? null, defaultModel: r?.default_model ?? null,
      updateAvailable: r && r.status === 'ready' && latest && compareVersions(latest, r.version) > 0 ? latest : null,
      autoUpdate: r ? autoUpdateOn(r, p) : 'registry' in p.spec.distribution, lastChecked: r?.last_checked ?? null,
      lastUpdateError: r?.last_update_error ? { message: r.last_update_error, at: r.last_update_error_at ?? null } : null, updating: r?.update_version ?? null,
    };
  }).sort((x, y) => x.name.localeCompare(y.name));
}

// ---- who may use what ----
/** A role may use an agent if the agent's `roles` lists it; an empty list means every role (that has the sandbox, which the caller checks). */
export const roleMayUse = (r: Pick<AgentRow, 'roles'>, roleId: string | undefined) => { const roles = rolesOf(r); return roles.length === 0 || (!!roleId && roles.includes(roleId)); };

/** The agents installed, ready, turned on and open to this role. */
export const usableAgents = (roleId: string | undefined) =>
  allRows().filter((r) => r.status === 'ready' && r.enabled && profileOf(r.id) && roleMayUse(r, roleId));

export const userRole = (userId: string) => (db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').get(userId) as { role_id: string } | undefined)?.role_id;

/** The row and profile to launch a conversation's agent with, or the reason in plain words why not. `agent` may be the legacy `claude-code`. */
export function launchable(userId: string, agent: string, viaAssistant = false): { row: AgentRow; profile: AgentProfile } | { reason: string } {
  const id = canonicalAgent(agent), profile = profileOf(id), row = rowOf(id);
  if (!profile || !row || row.status !== 'ready') return { reason: 'This agent is not installed. Ask your administrator.' };
  // an Assistant that runs on the agent has its own role list (the caller checked it); the agent's own list is for raw use
  if (!row.enabled || !(viaAssistant || roleMayUse(row, userRole(userId)))) return { reason: 'This agent is not available to you any more. Ask your administrator.' };
  return { row, profile };
}
