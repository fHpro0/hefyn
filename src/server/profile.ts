import { DEFAULT_PROFILE, db } from './appdb.ts';

export interface SkillDefinition { readonly name: string; readonly description: string; readonly instructions: string }

export interface AgentRow { name: string; description: string; model: string | null; thinking: string | null; instructions: string; skills: SkillDefinition[] }
/** `skills`: Hub skill package ids of the Assistant (assistants.ts resolves them). */
export interface Profile { model: string | null; thinking: string | null; instructions: string; skills: string[]; agents: AgentRow[] }

/** The default Assistant (is_default), else the seeded profile. */
export const defaultAssistantId = () => (db.prepare('SELECT id FROM profiles WHERE is_default = 1 ORDER BY rowid LIMIT 1').get() as { id: string } | undefined)?.id ?? DEFAULT_PROFILE;

// Sync on purpose: node:sqlite reads are sync.
export function loadProfile(id = defaultAssistantId()): Profile {
  const p = db.prepare('SELECT model, thinking, instructions, skills FROM profiles WHERE id = ?').get(id) as { model: string | null; thinking: string | null; instructions: string; skills: string };
  const rows = db.prepare('SELECT name, description, model, thinking, instructions, skills FROM profile_agents WHERE profile_id = ? ORDER BY rowid').all(id) as any[];
  return { model: p.model, thinking: p.thinking, instructions: p.instructions, skills: JSON.parse(p.skills), agents: rows.map((r) => ({ ...r, skills: JSON.parse(r.skills) })) };
}
