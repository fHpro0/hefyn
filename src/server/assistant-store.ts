import { randomBytes } from 'node:crypto';
import { type Flow, isSimple, simpleAgent } from '../assistants/flow.ts';
import { canonicalAgent } from '../cli-agents/profiles.ts';
import { db } from './appdb.ts';
import type { Helper } from '../cli-agents/session-config.ts';
import { type Inputs, getAssistant } from './assistants.ts';

export interface AssistantWrite {
  id?: string; name: string; description: string; icon: string; inputs: Inputs; roles: string[]; flow: Flow;
  scope?: 'private' | 'team'; owner?: string | null; /** the id to create under (a team copy of a shared Assistant) */ newId?: string;
  /** MCP connector ids and helpers; left out = unchanged (a new Assistant starts with none) */ mcp?: string[]; helpers?: Helper[];
  /** the Assistant's files as tar.gz (src/assistants/bundle.ts); left out = unchanged */ bundle?: Buffer;
}

/** Writes an Assistant: the flow is the truth; while it is the simple shape the classic columns (agent, model, ..., profile_agents) are rewritten from it, otherwise cleared. Bumps `version`. */
export function writeAssistant(o: AssistantWrite): { id: string; version: number } {
  const prev = o.id ? getAssistant(o.id) : undefined;
  const now = new Date().toISOString(), simple = isSimple(o.flow), c = simple ? simpleAgent(o.flow).config : {} as Record<string, any>;
  const mirror = [simple && c.agent ? canonicalAgent(String(c.agent)) : null, simple ? c.model || null : null, simple ? c.thinking || null : null, simple ? String(c.instructions ?? '') : '', JSON.stringify(simple ? c.skills ?? [] : [])] as const;
  const rolesJson = JSON.stringify([...new Set(o.roles)]), inputsJson = JSON.stringify(o.inputs), flowJson = JSON.stringify(o.flow);
  const mcpJson = o.mcp && JSON.stringify([...new Set(o.mcp)]), helpersJson = o.helpers && JSON.stringify(o.helpers);
  db.exec('BEGIN');
  try {
    let id: string, version: number;
    if (prev) {
      id = prev.id; version = prev.version + 1;
      db.prepare('UPDATE profiles SET name = ?, description = ?, icon = ?, agent = ?, model = ?, thinking = ?, instructions = ?, skills = ?, inputs = ?, roles = ?, flow = ?, version = ?, updated_at = ?, mcp = COALESCE(?, mcp), helpers = COALESCE(?, helpers), bundle = COALESCE(?, bundle) WHERE id = ?')
        .run(o.name, o.description, o.icon, ...mirror, inputsJson, rolesJson, flowJson, version, now, mcpJson ?? null, helpersJson ?? null, o.bundle ?? null, id);
    } else {
      id = o.newId ?? `a_${randomBytes(8).toString('hex')}`; version = 1;
      const sort = ((db.prepare('SELECT MAX(sort) AS m FROM profiles').get() as { m: number | null }).m ?? 0) + 1;
      db.prepare('INSERT INTO profiles (id, name, description, icon, agent, model, thinking, instructions, skills, inputs, roles, flow, version, scope, owner_id, sort, updated_at, mcp, helpers, bundle) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, o.name, o.description, o.icon, ...mirror, inputsJson, rolesJson, flowJson, version, o.scope ?? 'team', o.owner ?? null, sort, now, mcpJson ?? '[]', helpersJson ?? '[]', o.bundle ?? null);
    }
    db.prepare('DELETE FROM profile_agents WHERE profile_id = ?').run(id);
    if (simple) for (const s of c.subAgents ?? []) {
      db.prepare('INSERT INTO profile_agents (profile_id, name, description, model, thinking, instructions, skills) VALUES (?,?,?,?,?,?,?)')
        .run(id, s.name, s.description, s.model || null, s.thinking || null, s.instructions, JSON.stringify(s.skills ?? []));
    }
    db.exec('COMMIT');
    return { id, version };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
