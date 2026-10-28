import { db, grantAdmin, modulePermissions } from '../server/appdb.ts';
import * as hub from '../server/hub.ts';
import { createConnector, deleteConnector, moduleConnectorId, openClient } from '../server/mcp.ts';
import { setInstalledPermissions } from '../server/permissions.ts';
import type { Client } from '@modelcontextprotocol/client';
import { LockedError, sealForTeam } from '../server/vault.ts';
import { BUILTIN_AGENTS } from './agents/index.ts';
import { builtin } from './builtin.ts';
import { ManifestError, parseManifest, type Manifest } from './manifest.ts';
import { MissingSetting, settingAad, settingHeaders } from './mount.ts';
import { toolsOf, type Screen } from './screen-schema.ts';
import type { HefynModule } from './types.ts';

// Installed modules (docs/MODULES.md): lifecycle, settings and screen access. Contributions (skills, agents, the MCP connector) exist only
// while a module is enabled; install, enable, disable and uninstall each run in one transaction, so a failure leaves nothing behind.

export class ModuleError extends Error {
  status: 400 | 403 | 404 | 409 | 502;
  constructor(status: ModuleError['status'], message: string) { super(message); this.status = status; }
}
const fail = (status: ModuleError['status'], msg: string): never => { throw new ModuleError(status, msg); };

interface Row { id: string; manifest: string; enabled: number; installed_by: string; created_at: string; updated_at: string }
const rows = () => db.prepare('SELECT * FROM modules ORDER BY created_at, id').all() as unknown as Row[];
const rowOf = (id: string) => db.prepare('SELECT * FROM modules WHERE id = ?').get(id) as unknown as Row | undefined;
const manifestOf = (r: Row) => JSON.parse(r.manifest) as Manifest;
const need = (id: string) => rowOf(id) ?? fail(404, 'module not found');
const permId = (id: string, name: string) => `mod.${id}.${name}` as const;
const now = () => new Date().toISOString();

setInstalledPermissions(modulePermissions);

function tx<T>(f: () => T): T {
  db.exec('BEGIN');
  try {
    const r = f();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    if (e instanceof ModuleError) throw e;
    if (e instanceof hub.HubError) throw new ModuleError(e.status === 502 ? 502 : e.status === 404 ? 404 : e.status === 409 ? 409 : 400, e.message);
    if (e instanceof Error && /private or internal|URLs are allowed|name is required/.test(e.message)) throw new ModuleError(400, e.message);
    throw e;
  }
}

function contribute(m: Manifest, userId: string) {
  hub.installModuleItems(userId, m.id, m);
  if (m.mcp) db.prepare('UPDATE mcp_connectors SET source = ? WHERE id = ?').run(`module:${m.id}`, createConnector(userId, { name: m.name, url: m.mcp.url!, visibility: 'team' }));
}
function withdraw(id: string) {
  hub.removeModuleItems(id);
  const c = moduleConnectorId(id);
  if (c) deleteConnector(c);
}

/** `hubPackage`: the Hub package this came from; Hub install state and uninstall match on it, not on the module id. */
export function installModule(me: { id: string }, raw: unknown, hubPackage?: string) {
  let m: Manifest;
  try { m = parseManifest(raw); } catch (e) { if (e instanceof ManifestError) fail(400, e.message); throw e; }
  if (builtin.some((b) => b.id === m.id)) fail(400, `id: "${m.id}" is used by a built-in module`);
  if (m.cliAgent && BUILTIN_AGENTS.some((a) => a.id === m.id)) fail(400, `id: "${m.id}" is a built-in agent`);
  if (rowOf(m.id)) fail(409, `module "${m.id}" is already installed`);
  tx(() => {
    db.prepare('INSERT INTO modules (id, manifest, enabled, installed_by, created_at, updated_at, hub_package) VALUES (?,?,1,?,?,?,?)').run(m.id, JSON.stringify(m), me.id, now(), now(), hubPackage ?? null);
    contribute(m, me.id);
    grantAdmin();
  });
  return { id: m.id };
}

export function setEnabled(me: { id: string }, id: string, on: boolean) {
  const r = need(id);
  if (!on && !r.enabled) return;
  tx(() => {
    withdraw(id); // enabling an enabled module re-syncs it: a connector or package that went missing is restored
    if (on) contribute(manifestOf(r), me.id);
    db.prepare('UPDATE modules SET enabled = ?, updated_at = ? WHERE id = ?').run(on ? 1 : 0, now(), id);
  });
}

/** Uninstall of the module a Hub package installed (404 if that package's module is not installed). */
export function uninstallHubModule(hubPackage: string) {
  const r = db.prepare('SELECT id FROM modules WHERE hub_package = ?').get(hubPackage) as { id: string } | undefined;
  if (!r) fail(404, 'this package has no installed module');
  uninstallModule(r!.id);
}

export function uninstallModule(id: string) {
  const r = need(id);
  tx(() => {
    withdraw(id);
    if (manifestOf(r).cliAgent) db.prepare('DELETE FROM cli_agents WHERE id = ?').run(id); // no profile any more; the files in the volume go with `agents.removeModule`
    db.prepare('DELETE FROM module_settings WHERE module_id = ?').run(id);
    db.prepare('DELETE FROM modules WHERE id = ?').run(id);
    for (const r of db.prepare('SELECT id, permissions FROM roles').all() as { id: string; permissions: string }[]) {
      const kept = (JSON.parse(r.permissions) as string[]).filter((p) => !p.startsWith(`mod.${id}.`));
      if (kept.length !== JSON.parse(r.permissions).length) db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify(kept), r.id);
    }
    grantAdmin();
  });
}

export const listInstalled = () => rows().map((r) => {
  const m = manifestOf(r);
  return { id: r.id, name: m.name, version: m.version, description: m.description, icon: m.icon, enabled: !!r.enabled, installedBy: r.installed_by, createdAt: r.created_at, mcp: m.mcp?.url, settings: m.settings?.length ?? 0, agent: !!m.cliAgent, screens: Object.keys(m.screens ?? {}) };
});

/** Enabled installed modules in the registry's shape: permissions grouped under the module's name, ids namespaced. */
export function installedModules(): HefynModule[] {
  return rows().filter((r) => r.enabled).map((r) => {
    const m = manifestOf(r);
    const ns = <T extends { permission?: string }>(e: T) => ({ ...e, permission: e.permission ? permId(m.id, e.permission) : undefined });
    return {
      id: m.id, name: m.name, description: m.description, icon: m.icon,
      permissions: (m.permissions ?? []).map((p) => ({ id: permId(m.id, p.name), label: p.label, hint: p.hint, group: m.name })),
      nav: (m.nav ?? []).map(ns), commands: (m.commands ?? []).map(ns),
    };
  });
}

// ---- settings ----

const CONTROL = /[\x00-\x1f\x7f]/;

export function getSettings(id: string) {
  const m = manifestOf(need(id));
  const stored = new Map((db.prepare('SELECT key, value, secret FROM module_settings WHERE module_id = ?').all(id) as { key: string; value: string; secret: number }[]).map((s) => [s.key, s]));
  const values: Record<string, unknown> = {};
  for (const f of m.settings ?? []) {
    const s = stored.get(f.key);
    if (f.type === 'secret') values[f.key] = { set: !!s }; // secrets never leave the server
    else if (s) values[f.key] = JSON.parse(s.value);
    else if (f.default !== undefined) values[f.key] = f.default;
  }
  return { fields: m.settings ?? [], values };
}

export function putSettings(id: string, body: unknown) {
  const m = manifestOf(need(id));
  const input = (body as { values?: unknown } | null)?.values;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'values must be an object');
  const ins = db.prepare('INSERT OR REPLACE INTO module_settings (module_id, key, value, secret) VALUES (?,?,?,?)');
  tx(() => {
    for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
      const f = (m.settings ?? []).find((x) => x.key === key) ?? fail(400, `unknown setting "${key}"`);
      if (val === null) { db.prepare('DELETE FROM module_settings WHERE module_id = ? AND key = ?').run(id, key); continue; }
      const bad = (what: string) => fail(400, `${key}: ${what}`);
      if (f.type === 'number') { if (typeof val !== 'number' || !Number.isFinite(val)) bad('must be a number'); }
      else if (f.type === 'boolean') { if (typeof val !== 'boolean') bad('must be true or false'); }
      else {
        if (typeof val !== 'string' || val.length > 2000 || CONTROL.test(val)) bad('must be a single-line string of at most 2000 characters');
        if (f.type === 'secret' && val === '') continue; // empty keeps the stored secret
        if (f.type === 'select' && !f.options?.includes(val as string)) bad('not one of the options');
      }
      if (f.type === 'secret') ins.run(id, key, sealForTeam(val as string, settingAad(id, key)), 1);
      else ins.run(id, key, JSON.stringify(val), 0);
    }
  });
}

// ---- screens and tool calls ----

const held = (perms: readonly string[], m: Manifest, s: Screen) => !s.permission || perms.includes(permId(m.id, s.permission));
function enabled(id: string) {
  const r = rowOf(id);
  if (!r?.enabled) fail(404, 'module not found');
  return manifestOf(r!);
}

export function screenFor(id: string, name: string, perms: readonly string[]): Screen {
  const m = enabled(id);
  const s = Object.hasOwn(m.screens ?? {}, name) ? m.screens![name] : undefined;
  if (!s) fail(404, 'screen not found');
  if (!held(perms, m, s!)) fail(403, 'forbidden');
  return s!;
}

export const MAX_ARGS_BYTES = 64 * 1024;
export const MAX_RESULT_BYTES = 1_000_000;
export const CALL_TIMEOUT_MS = 20_000;

export type Caller = (userId: string, connectorId: string, tool: string, args: Record<string, unknown>, headers: Record<string, string>) => Promise<unknown>;
// Straight from the web process to the module's server (like the connector test button), not through the egress proxy; the host is on its allowlist.
// Connect and call each get the same timeout; a client that connects after the timeout is closed. The 1 MB result cap is checked after the
// SDK has parsed the answer (it has no cheap way to stop reading earlier), so a hostile server can still make us buffer one response.
let caller: Caller = async (userId, connectorId, tool, args, headers) => {
  const opening = openClient(userId, connectorId, headers);
  let client: Client | undefined;
  let timer: ReturnType<typeof setTimeout>;
  try {
    client = await Promise.race([opening, new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('connect timed out')), CALL_TIMEOUT_MS); })]);
    return await client.callTool({ name: tool, arguments: args }, { timeout: CALL_TIMEOUT_MS });
  } finally {
    clearTimeout(timer!);
    if (client) await client.close().catch(() => {}); else opening.then((c) => c.close(), () => {});
  }
};
export const setCaller = (f: Caller) => void (caller = f); // tests stub the MCP boundary

export async function callTool(me: { id: string; permissions: readonly string[] }, id: string, tool: string, args: unknown) {
  const m = enabled(id);
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail(400, 'the body must be a JSON object');
  if (!Object.values(m.screens ?? {}).some((s) => held(me.permissions, m, s) && toolsOf(s).includes(tool))) fail(403, 'this tool is not used by any screen you can open');
  const cid = moduleConnectorId(id) ?? fail(409, 'the module has no MCP server');
  let headers: Record<string, string>;
  try { headers = settingHeaders(id, m); } catch (e) { if (e instanceof MissingSetting) fail(409, e.message); throw e; }
  let timer: ReturnType<typeof setTimeout>;
  let result: unknown;
  try {
    result = await Promise.race([
      caller(me.id, cid, tool, args as Record<string, unknown>, headers),
      new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('timed out')), 2 * CALL_TIMEOUT_MS + 2000); }), // backstop for a stub that never answers
    ]);
  } catch (e) {
    if (e instanceof ModuleError || e instanceof LockedError) throw e;
    console.error('[hefyn] module call', id, tool, (e as Error).message);
    fail(502, 'the module server did not answer');
  } finally {
    clearTimeout(timer!);
  }
  if (Buffer.byteLength(JSON.stringify(result) ?? '') > MAX_RESULT_BYTES) fail(502, 'the tool result is too large');
  return { result };
}
