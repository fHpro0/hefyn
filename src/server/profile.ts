import type { SkillDefinition } from '@flue/runtime';
import { DEFAULT_PROFILE, db } from './appdb.ts';

export interface AgentRow { name: string; description: string; model: string | null; instructions: string; skills: SkillDefinition[] }
export interface Profile { model: string | null; instructions: string; agents: AgentRow[] }

// Sync on purpose: Flue renders the agent function synchronously, and node:sqlite reads are sync.
export function loadProfile(id = DEFAULT_PROFILE): Profile {
  const p = db.prepare('SELECT model, instructions FROM profiles WHERE id = ?').get(id) as { model: string | null; instructions: string };
  const rows = db.prepare('SELECT name, description, model, instructions, skills FROM profile_agents WHERE profile_id = ? ORDER BY rowid').all(id) as any[];
  return { model: p.model, instructions: p.instructions, agents: rows.map((r) => ({ ...r, skills: JSON.parse(r.skills) })) };
}
