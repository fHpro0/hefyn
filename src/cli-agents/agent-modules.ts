import { db } from '../server/appdb.ts';
import type { Manifest } from '../modules/manifest.ts';
import { profileFromSpec } from './manifest-profile.ts';
import type { AgentProfile } from './profiles.ts';

// Agent modules that were added (docs/MODULES.md "Agent modules"): enabled rows of the `modules` table whose manifest has a `cliAgent` section. Read on every
// call, so adding, disabling and removing a module take effect at once in every process; the profile is rebuilt only when the stored manifest changes.

interface Row { id: string; manifest: string; hub_package: string | null }
const cache = new Map<string, { raw: string; profile: AgentProfile | undefined }>();

function build(r: Pick<Row, 'id' | 'manifest'>): AgentProfile | undefined {
  const hit = cache.get(r.id);
  if (hit?.raw === r.manifest) return hit.profile;
  let profile: AgentProfile | undefined;
  try { const m = JSON.parse(r.manifest) as Manifest; if (m.cliAgent) profile = profileFromSpec(m.id, m.name, m.description ?? m.name, m.cliAgent); } catch { /* unreadable: not an agent */ }
  cache.set(r.id, { raw: r.manifest, profile });
  return profile;
}

export const moduleProfile = (id: string): AgentProfile | undefined => {
  const r = db.prepare('SELECT id, manifest FROM modules WHERE id = ? AND enabled = 1').get(id) as Pick<Row, 'id' | 'manifest'> | undefined;
  return r && build(r);
};

export type AgentSource = { type: 'builtin' } | { type: 'hub'; name: string } | { type: 'upload' };
const hubName = (id: string) => { try { return (db.prepare('SELECT name FROM packages WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? 'the Hub'; } catch { return 'the Hub'; } };

/** The added agents, with where each came from. */
export const moduleAgents = (): { profile: AgentProfile; source: AgentSource }[] =>
  (db.prepare('SELECT id, manifest, hub_package FROM modules WHERE enabled = 1 ORDER BY created_at, id').all() as unknown as Row[])
    .flatMap((r) => { const profile = build(r); return profile ? [{ profile, source: r.hub_package ? { type: 'hub' as const, name: hubName(r.hub_package) } : { type: 'upload' as const } }] : []; });
