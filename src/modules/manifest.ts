import { z } from 'zod';
import { assertPublicUrl } from '../server/mcp.ts';
import { AgentSpecError, parseAgentManifest, parseSpec, type AgentSpec } from './agent-manifest.ts';
import { fieldSchema, flatIssues, screenSchema, toolsOf, type Screen } from './screen-schema.ts';

// hefyn.module.json (docs/MODULES.md): the manifest of an installed module. Strict: unknown keys are errors, not stripped.

export class ManifestError extends Error {}
export const MAX_MANIFEST_BYTES = 256 * 1024;

const text = (max: number) => z.string().min(1).max(max);
const LOCAL = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'must be lowercase letters, digits and _');
const ICON = z.string().regex(/^[A-Z][A-Za-z0-9]{0,39}$/, 'must be a lucide icon name such as Blocks'); // capitalised, so never `constructor` & co
const SCREEN =/^[a-z][a-z0-9-]{0,31}$/;
const ITEM = z.string().regex(/^[A-Za-z0-9][\w.-]{0,63}$/, 'letters, digits, dot, dash and underscore (max 64)'); // the hub's NAME rule
const entry = {
  label: text(60), href: z.string().max(200), icon: ICON.optional(),
  permission: LOCAL.optional(), order: z.number().int().min(0).max(1000).optional(),
};

const schema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'must be 2-32 characters: lowercase letters, digits and -'),
  name: text(60), version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/, 'invalid version'),
  description: text(500).optional(), icon: ICON.optional(),
  permissions: z.array(z.strictObject({ name: LOCAL, label: text(60), hint: text(200).optional() })).max(20).optional(),
  nav: z.array(z.strictObject({ ...entry, place: z.enum(['main', 'settings']) })).max(20).optional(),
  commands: z.array(z.strictObject(entry)).max(20).optional(),
  settings: z.array(fieldSchema).max(20).optional(),
  // Same fields the hub parses from SKILL.md / agents/*.md (hub.ts SkillItem / AgentItem, without bundled files).
  skills: z.array(z.strictObject({ name: ITEM, description: text(2000), instructions: text(20_000) })).max(10).optional(),
  agents: z.array(z.strictObject({ name: ITEM, description: text(2000), instructions: text(20_000), model: text(200).optional(), skills: z.array(ITEM).max(10).optional() })).max(10).optional(),
  mcp: z.strictObject({ url: z.string().max(500).optional(), image: z.string().optional() })
    .refine((m) => !m.image, 'runner-hosted MCP is not supported yet')
    .refine((m) => !!m.url, 'url is required')
    .refine((m) => !m.url || m.url.startsWith('https://'), 'url must be https')
    .refine((m) => { try { assertPublicUrl(m.url!); return true; } catch { return false; } }, 'private or internal addresses are not allowed')
    .optional(),
  // Tools the module offers to the chat agent (all other module tools are only reachable from its screens), for users holding `permission`.
  agent: z.strictObject({ tools: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'invalid tool name')).min(1).max(20), permission: LOCAL.optional() }).optional(),
  screens: z.record(z.string().regex(SCREEN, 'invalid screen name'), z.any()).optional(),
  cliAgent: z.record(z.string(), z.unknown()).optional(), // a CLI coding agent hefyn can host (agent-manifest.ts); checked below
});
type Parsed = z.output<typeof schema>;
export type Manifest = Omit<Parsed, 'screens' | 'cliAgent'> & { screens?: Record<string, Screen>; cliAgent?: AgentSpec };

const where = (path: string, msg: string) => new ManifestError(`${path ? path + ': ' : ''}${msg}`);

// JSON.parse makes `__proto__` an own key and a schema's key check may use `in`, so these are rejected up front, at any depth.
export function scan(x: unknown, path: string, depth = 0) {
  if (depth > 10) throw where(path, 'nested too deeply');
  if (!x || typeof x !== 'object') return;
  for (const [k, val] of Object.entries(x)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw where(`${path}.${k}`.replace(/^\./, ''), 'forbidden key');
    scan(val, path ? `${path}.${k}` : k, depth + 1);
  }
}

/** Validates a manifest and returns it typed; throws ManifestError whose message starts with the path of the first problem. */
export function parseManifest(raw: unknown): Manifest {
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(raw) ?? ''); } catch { throw where('', 'not JSON'); }
  if (size > MAX_MANIFEST_BYTES) throw where('', `manifest is larger than ${MAX_MANIFEST_BYTES / 1024} KB`);
  scan(raw, '');
  if ((raw as { kind?: unknown } | null)?.kind === 'agent') { // the standalone agent manifest becomes a module whose only content is the agent
    try { const { kind: _k, id, name, version, description, ...spec } = parseAgentManifest(raw); raw = { id, name, version: version ?? '1', description, cliAgent: spec }; }
    catch (e) { if (e instanceof AgentSpecError) throw new ManifestError(e.message); throw e; }
  }
  const r = schema.safeParse(raw);
  if (!r.success) { const i = flatIssues(r.error)[0]!; throw where(i.path, i.message); }
  const m = r.data;
  const perms = new Set((m.permissions ?? []).map((p) => p.name));
  if (perms.size !== (m.permissions ?? []).length) throw where('permissions', 'duplicate permission name');
  const need = (p: string | undefined, path: string) => { if (p && !perms.has(p)) throw where(path, `unknown permission "${p}"`); };

  const screens: Record<string, Screen> = {};
  const one = screenSchema(m.id);
  for (const [name, s] of Object.entries(m.screens ?? {})) {
    const sr = one.safeParse(s);
    if (!sr.success) { const i = flatIssues(sr.error)[0]!; throw where(`screens.${name}${i.path ? '.' + i.path : ''}`, i.message); }
    need(sr.data.permission, `screens.${name}.permission`);
    screens[name] = sr.data;
  }
  if (m.agent && !m.mcp) throw where('agent', 'the agent section needs an mcp server');
  need(m.agent?.permission, 'agent.permission');
  const tools = Object.entries(screens).flatMap(([, s]) => toolsOf(s));
  if (tools.length && !m.mcp) throw where('mcp', 'screens call tools, so the module needs an mcp server');
  const prefix = `/m/${m.id}/`;
  for (const key of ['nav', 'commands'] as const) {
    (m[key] ?? []).forEach((e, i) => {
      const path = `${key}.${i}`;
      const screen = e.href.startsWith(prefix) ? screens[e.href.slice(prefix.length)] : undefined;
      if (!screen) throw where(`${path}.href`, `must be ${prefix}<screen> of a declared screen`);
      need(e.permission, `${path}.permission`);
      if (e.permission !== screen.permission) throw where(`${path}.permission`, `must match the permission of screen "${e.href.slice(prefix.length)}"`);
    });
  }
  const keys = (m.settings ?? []).map((f) => f.key.toLowerCase()); // settings travel as lowercase header names
  if (new Set(keys).size !== keys.length) throw where('settings', 'duplicate key');
  let cliAgent: AgentSpec | undefined;
  if (m.cliAgent) {
    try { cliAgent = parseSpec(m.cliAgent); } catch (e) { if (e instanceof AgentSpecError) throw where(`cliAgent${e.path ? '.' + e.path : ''}`, e.reason); throw e; }
  }
  return { ...m, screens: m.screens ? screens : undefined, cliAgent };
}
