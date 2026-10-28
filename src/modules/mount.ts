import { db } from '../server/appdb.ts';
import { permissionsOf } from '../server/runner.ts';
import { openForTeam } from '../server/vault.ts';
import type { Manifest } from './manifest.ts';

// What reaches a module's MCP server: its settings as headers, and (only if the manifest has an `agent` section) its allowed tools for the chat agent.
// Light on purpose: the agent process imports this, not the module routes.

export class MissingSetting extends Error {}

export const settingAad = (id: string, key: string) => `modset:${id}:${key}`;

/** Settings as headers for the module's MCP server (`x-hefyn-setting-<key>`). Throws MissingSetting for a required one that is not set. */
export function settingHeaders(id: string, m: Manifest) {
  const stored = new Map((db.prepare('SELECT key, value, secret FROM module_settings WHERE module_id = ?').all(id) as { key: string; value: string; secret: number }[]).map((s) => [s.key, s]));
  const out: Record<string, string> = {};
  for (const f of m.settings ?? []) {
    const s = stored.get(f.key);
    const val = s ? (s.secret ? openForTeam(s.value, settingAad(id, f.key)) : JSON.parse(s.value)) : f.default;
    if (val === undefined || val === '') { if (f.required) throw new MissingSetting(`setting "${f.label}" is required`); continue; }
    out[`x-hefyn-setting-${f.key.toLowerCase()}`] = String(val);
  }
  return out;
}

/**
 * Module connectors this user's agent may mount: the module is enabled, declares `agent`, and the user holds `agent.permission` (if any).
 * Only the declared tools are mounted. A module whose settings cannot be read (required one missing, team key locked) is skipped.
 */
export function moduleMounts(userId: string) {
  const held = permissionsOf(userId) as string[];
  const out: { name: string; url: string; transport: 'streamable-http' | 'sse'; headers: Record<string, string>; tools: string[] }[] = [];
  for (const r of db.prepare('SELECT id, manifest FROM modules WHERE enabled = 1').all() as { id: string; manifest: string }[]) {
    const m = JSON.parse(r.manifest) as Manifest;
    if (!m.agent || (m.agent.permission && !held.includes(`mod.${r.id}.${m.agent.permission}`))) continue;
    const c = db.prepare("SELECT url, transport FROM mcp_connectors WHERE source = ? AND visibility = 'team'").get(`module:${r.id}`) as { url: string; transport: 'streamable-http' | 'sse' } | undefined;
    if (!c) continue;
    try { out.push({ name: `mod_${r.id.replace(/-/g, '_')}`, url: c.url, transport: c.transport, headers: settingHeaders(r.id, m), tools: m.agent.tools }); } catch { /* optional: the agent runs without it */ }
  }
  return out;
}
