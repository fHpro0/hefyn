import { db } from './appdb.ts';
import { defaultAssistantId } from './profile.ts';
import { canonicalAgent } from '../cli-agents/profiles.ts';
import type { Helper } from '../cli-agents/session-config.ts';
import { type Flow, isSimple, simpleAgent, simpleFlow } from '../assistants/flow.ts';

// Assistants: an admin's presets over the `profiles` table (which model, what to do, which skills, what may be sent in). Users pick one and never see models.
// Since 2026-10-27 an Assistant is a simple preset of a CLI agent (name, agent, instructions, skills); the flow builder moved to old/ and a stored flow Assistant is not available. This file is the plain data layer.

export const DEFAULT_AGENT = 'claude-acp';
// An Assistant also names the MCP servers it uses (connector ids) and its helpers ("what to use where": a role and the agent that does it). New columns on `profiles`, added idempotently.
for (const c of ["mcp TEXT NOT NULL DEFAULT '[]'", "helpers TEXT NOT NULL DEFAULT '[]'"]) try { db.exec(`ALTER TABLE profiles ADD COLUMN ${c}`); } catch { /* column exists */ }
/** The icon is a lucide component name (`Sparkles`) or an emoji (`emoji:🙂`): one string, so old rows and exports keep working. */
export const ICON_RE = /^(?:[A-Za-z0-9]{1,30}|emoji:\S{1,16})$/u;
export interface Inputs { images: 'off' | 'on'; maxImageEdge: number; imageQuality: number; documents: boolean; maxUploadMb: number }
export const INPUT_DEFAULTS: Inputs = { images: 'off', maxImageEdge: 1568, imageQuality: 0.8, documents: false, maxUploadMb: 25 };
const within = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : def);

/** Tolerant on read (a bad stored value falls back to the default, which is the closed one); `assistants.save` validates strictly. */
export function inputsOf(raw: unknown): Inputs {
  let o: any = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { o = {}; } }
  if (!o || typeof o !== 'object') o = {};
  return {
    images: o.images === 'on' ? 'on' : 'off', maxImageEdge: Math.round(within(o.maxImageEdge, 64, 8192, INPUT_DEFAULTS.maxImageEdge)),
    imageQuality: within(o.imageQuality, 0.1, 1, INPUT_DEFAULTS.imageQuality), documents: o.documents === true, maxUploadMb: within(o.maxUploadMb, 1, 1024, INPUT_DEFAULTS.maxUploadMb),
  };
}

/** agent/model/thinking/instructions/skills mirror the flow's agent node while the flow is the simple shape (`simple`); the classic chat and the CLI host read them. A flow Assistant has none. */
export interface Assistant {
  id: string; name: string; description: string; icon: string; agent: string | null; model: string | null; /** the model provider of a CLI agent (read from the flow's agent node; null = the agent's own API's) */ provider?: string | null; thinking: string | null; instructions: string;
  skills: string[]; /** MCP connector ids */ mcp: string[]; /** role -> agent (+ its provider/model) the base agent hands that work to */ helpers: Helper[]; inputs: Inputs; roles: string[]; isDefault: boolean; archived: boolean; updatedAt: string | null;
  owner: string | null; scope: 'private' | 'team'; shareStatus: 'pending' | 'declined' | null; version: number; flow: Flow; simple: boolean;
}
const helpersOf = (s: string): Helper[] => {
  try { const j = JSON.parse(s); return Array.isArray(j) ? j.filter((h) => h && typeof h.role === 'string' && typeof h.agent === 'string').map((h) => ({ role: h.role, agent: h.agent, provider: h.provider ?? null, model: h.model ?? null, edit: h.edit === true })) : []; } catch { return []; }
};
const list = (s: string): string[] => { try { const j = JSON.parse(s); return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : []; } catch { return []; } };
const toAssistant = (r: any): Assistant => {
  let flow: Flow;
  try { flow = JSON.parse(r.flow) ?? simpleFlow({}); } catch { flow = simpleFlow({}); }
  const simple = isSimple(flow);
  // A preset made for the retired hefyn agent (agent NULL) reads as Claude Code; its hefyn model/thinking do not carry over. Nothing is rewritten in the database.
  const legacy = simple && !r.agent;
  return {
    id: r.id, name: r.name, description: r.description, icon: r.icon, agent: simple ? r.agent || DEFAULT_AGENT : null, model: simple && !legacy ? r.model : null, provider: simple && !legacy ? simpleAgent(flow).config?.provider || null : null, thinking: simple && !legacy ? r.thinking : null, instructions: simple ? r.instructions : '',
    skills: simple ? list(r.skills) : [], mcp: simple ? list(r.mcp ?? '[]') : [], helpers: simple ? helpersOf(r.helpers ?? '[]') : [], inputs: inputsOf(r.inputs), roles: list(r.roles), isDefault: !!r.is_default, archived: !!r.archived, updatedAt: r.updated_at,
    owner: r.owner_id ?? null, scope: r.scope === 'private' ? 'private' : 'team', shareStatus: r.share_status ?? null, version: r.version ?? 1, flow, simple,
  };
};
const COLS = (db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]).map((c) => c.name).filter((n) => n !== 'bundle').join(', '); // the bundle (up to 10 MB) is read on its own: assistant-bundle.ts
export const getAssistant = (id: string): Assistant | undefined => { const r = db.prepare(`SELECT ${COLS} FROM profiles WHERE id = ?`).get(id); return r ? toAssistant(r) : undefined; };
/** Default first, then the admin's order. Every Assistant, private ones too: use `visibleTo` for a person. */
export const allAssistants = (): Assistant[] => (db.prepare(`SELECT ${COLS} FROM profiles ORDER BY is_default DESC, sort, name`).all() as any[]).map(toAssistant);
/** Empty `roles` = every role. A role that is unknown (a user without one) matches only an open Assistant. */
export const roleMay = (a: Pick<Assistant, 'roles'>, roleId: string | undefined) => a.roles.length === 0 || (!!roleId && a.roles.includes(roleId));
/** May this person chat with the Assistant? Private: its owner only. Team: not archived and open to their role. */
export const mayUseBy = (a: Assistant, userId: string, roleId: string | undefined) => !a.archived && (a.scope === 'private' ? a.owner === userId : roleMay(a, roleId));
/** What a person may start a chat with. */
export const visibleTo = (userId: string, roleId: string | undefined) => allAssistants().filter((a) => mayUseBy(a, userId, roleId));
/** What a person may edit: their own private Assistants, and every team one with `assistants.manage`. */
export const editableBy = (userId: string, manage: boolean) => allAssistants().filter((a) => (a.scope === 'private' ? a.owner === userId : manage));
export const roleOf = (userId: string) => (db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').get(userId) as { role_id: string } | undefined)?.role_id;

/** The Assistant a conversation runs on: a test chat of the editor carries its unsaved draft (`snapshot`), every other chat its saved Assistant. */
export function conversationAssistant(conversationId: string): Assistant | undefined {
  const c = db.prepare('SELECT assistant_id, snapshot FROM conversations WHERE id = ?').get(conversationId) as { assistant_id: string | null; snapshot: string | null } | undefined;
  if (c?.snapshot) { try { return JSON.parse(c.snapshot) as Assistant; } catch { return; } }
  return c?.assistant_id ? getAssistant(c.assistant_id) : undefined;
}

const convRow = (id: string) => db.prepare('SELECT assistant_id, agent FROM conversations WHERE id = ?').get(id) as { assistant_id: string | null; agent: string | null } | undefined;

/** The conversation's Assistant (NULL = the default one). */
export const assistantIdOf = (conversationId: string) => convRow(conversationId)?.assistant_id ?? defaultAssistantId();

/** The input rules of a conversation's Assistant (NULL = the default one). An unknown conversation or Assistant gets the closed defaults. */
export function inputsForConversation(conversationId: string): Inputs {
  const c = convRow(conversationId);
  return c ? (getAssistant(c.assistant_id ?? defaultAssistantId())?.inputs ?? inputsOf({})) : inputsOf({});
}

/** Does the conversation's Assistant (not archived, open to the user's role) run on the conversation's CLI agent? Then it grants that agent's sandbox without `sandbox.shell`. */
export function assistantGrantsAgent(userId: string, conversationId: string): boolean {
  const c = convRow(conversationId);
  if (!c?.assistant_id || !c.agent) return false;
  const a = getAssistant(c.assistant_id);
  if (!a || a.scope !== 'team' || a.archived || !roleMay(a, roleOf(userId))) return false; // a private Assistant grants nothing: its owner needs the sandbox themselves
  return a.simple && !!a.agent && canonicalAgent(a.agent) === canonicalAgent(c.agent);
}

export interface SkillBundle { name: string; description: string; instructions: string; files: Record<string, string>; all: Record<string, string> }
/** The approved team skills among `ids` (Hub package ids): Flue's view (`instructions` + `files`) and the whole tree for an agent's skills dir (`all`, SKILL.md included). Unknown or unapproved ids are skipped. */
export function skillBundles(ids: string[]): SkillBundle[] {
  const out: SkillBundle[] = [];
  for (const id of ids) {
    let r: { approved_json: string } | undefined;
    try { r = db.prepare("SELECT approved_json FROM packages WHERE id = ? AND kind = 'skill' AND visibility = 'team' AND approved_json IS NOT NULL").get(id) as typeof r; } catch { return out; } // no Hub table yet: no skills
    const snap = r && JSON.parse(r.approved_json), s = snap?.manifest?.items?.skills?.[0];
    if (s) out.push({ name: s.name, description: s.description, instructions: s.instructions, files: s.files ?? {}, all: snap.files ?? {} });
  }
  return out;
}
