// An Assistant draft as files: what the creator chat (a CLI agent in a folder of the user's storage) reads and edits. Pure: no database, no sandbox.
//   assistant.json {name, description, icon, agent} · instructions.md · skills.json [ids] · skills/<name>/SKILL.md (new skills) · mcp.json [ids] · helpers.json [{role, agent, edit}]
//   catalog.json (read-only: what the person may pick) · CLAUDE.md / AGENTS.md (the creator's brief). Any other file is part of the Assistant's bundle (bundle.ts).
// Model, provider and effort are never in the files: the creator does not see model ids.

export const DRAFT_ROOT = '/files/.hefyn/assistant-drafts';
export const DRAFT_ID = /^[a-z0-9]{8,32}$/;
export const SECTIONS = ['basics', 'instructions', 'skills', 'mcp', 'helpers'] as const;
export type Section = (typeof SECTIONS)[number];
export const SECTION_LABEL: Record<Section, string> = { basics: 'Basics', instructions: 'Instructions', skills: 'Skills', mcp: 'MCP servers', helpers: 'Helpers' };

export interface DraftHelper { role: string; agent: string; provider?: string | null; model?: string | null; edit?: boolean }
export interface NewSkill { name: string; description: string; body: string }
export interface Draft { name: string; description: string; icon: string; agent: string | null; instructions: string; skills: string[]; newSkills: NewSkill[]; mcp: string[]; helpers: DraftHelper[] }
export interface Catalog { agents: { id: string; name: string; helper?: boolean; mcp?: boolean }[]; skills: { id: string; name: string; description: string }[]; mcp: { id: string; name: string }[] }

export const ICON_OK = /^(?:[A-Za-z0-9]{1,30}|emoji:\S{1,16})$/u;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The folder of a draft: only a well-formed id gets one. */
export function draftDir(draftId: string): string {
  if (!DRAFT_ID.test(draftId)) throw new Error('invalid draft id');
  return `${DRAFT_ROOT}/${draftId}`;
}

/** A conversation's own working folder: a draft folder directly below the drafts root, else undefined (a `..`, a deeper path, another root). A conversation without one works in /files. */
export function validCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string' || !cwd.startsWith(`${DRAFT_ROOT}/`)) return;
  return DRAFT_ID.test(cwd.slice(DRAFT_ROOT.length + 1)) ? cwd : undefined; // exactly one well-formed id below the root: no `..`, no slash, no extra segment
}

export const emptyDraft = (): Draft => ({ name: '', description: '', icon: 'Sparkles', agent: null, instructions: '', skills: [], newSkills: [], mcp: [], helpers: [] });
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** The draft's files, relative to its folder. */
export function serializeDraft(d: Draft): Record<string, string> {
  const files: Record<string, string> = {
    'assistant.json': json({ name: d.name, description: d.description, icon: d.icon, agent: d.agent }),
    'instructions.md': d.instructions,
    'skills.json': json(d.skills),
    'mcp.json': json(d.mcp),
    'helpers.json': json(d.helpers.map((h) => ({ role: h.role, agent: h.agent, edit: h.edit === true }))),
  };
  for (const s of d.newSkills) files[`skills/${s.name}/SKILL.md`] = `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n${s.body}`;
  return files;
}

export function creatorFiles(c: Catalog): Record<string, string> {
  const brief = `# Assistant creator

You edit one Assistant draft, as files in this folder. The person sees your changes next to the draft and accepts or rejects each part.

Files you may edit:
- assistant.json: name, description (one short line people read when choosing), icon (a lucide icon name such as "Sparkles", or "emoji:🙂"), agent (an id from catalog.json "agents")
- instructions.md: what the Assistant does, in plain words: the job, the tone, the rules
- skills.json: a list of skill ids from catalog.json "skills" the Assistant uses
- skills/<name>/SKILL.md: a new skill for this Assistant (front matter with name and description, then the instructions). The name uses lower-case letters, digits and dashes
- mcp.json: a list of MCP server ids from catalog.json "mcp"
- helpers.json: a list of {"role": "review", "agent": "<id>", "edit": false}; agents come from catalog.json "agents" with "helper": true
- process.json (optional): add one when the work has stages with reviews, approvals or loops. It only describes the process; the agent follows it with the bundle's runner script, and hefyn draws it. Format:
  {"version": 1, "title": "...", "start": "<stage id>", "stages": [{"id": "plan", "title": "...", "by": "agent" | "person" | "helper:<role>" | "script:<skill>/<file>", "does": "one line", "each": "<list name>", "end": true}], "next": [{"from": "a", "to": "b"}, {"from": "review", "to": "draft", "when": "changes requested", "max": 3, "then": "escalate"}]}
  An edge without "when" is the default way out (one per stage). "by" helper roles must be in helpers.json and script files must exist in the bundle. "each" starts a loop over a list; its edges are "next item" and "all items done". Keep every loop bounded: a way back needs "max" and "then". Every stage must be reachable from "start", and end stages ("end": true) have no way out.

Rules:
- catalog.json is read-only. Never invent a skill, MCP server or agent id that is not in it; if something is missing, say so in your reply instead.
- When the person asks you to improve one part ("Improving: Instructions"), change only that part's files.
- Keep files valid. Any other text file you add here (templates, reference notes, data) belongs to the Assistant: each new chat gets its own copy of it. Never put secrets in them.
- Answer in the person's language. Keep replies short and say what you changed and why.
`;
  return { 'catalog.json': json(c), 'CLAUDE.md': brief, 'AGENTS.md': brief };
}

const parseJson = (s: string | undefined): unknown => { if (s === undefined) return undefined; try { return JSON.parse(s); } catch { return Symbol.for('bad'); } };
const BAD = Symbol.for('bad');
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Reads a SKILL.md: front matter (name, description) and the body. */
export function parseSkill(dir: string, text: string): NewSkill | undefined {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  const field = (k: string) => { const l = m?.[1]!.split('\n').find((x) => x.startsWith(`${k}:`))?.slice(k.length + 1).trim(); if (!l) return ''; try { const v = JSON.parse(l); return typeof v === 'string' ? v : l; } catch { return l; } };
  const name = SKILL_NAME.test(dir) ? dir : undefined;
  if (!m || !name) return;
  return { name, description: field('description').slice(0, 300), body: m[2]!.slice(0, 100_000) };
}

/** The draft the files describe. A missing file keeps `prev`'s part; an unreadable file or an id that is not in the catalog is reported in `errors` (the bad part keeps `prev`'s value, the bad id is dropped). */
export function parseDraft(files: Record<string, string | undefined>, catalog: Catalog, prev: Draft): { draft: Draft; errors: string[] } {
  const errors: string[] = [], d: Draft = { ...prev, newSkills: [] };
  const agents = new Map(catalog.agents.map((a) => [a.id, a]));
  const a = parseJson(files['assistant.json']);
  if (a === BAD || (a !== undefined && (typeof a !== 'object' || a === null))) errors.push('assistant.json is not valid.');
  else if (a) {
    const o = a as Record<string, unknown>;
    if (typeof o.name === 'string') d.name = o.name.trim().slice(0, 80);
    if (typeof o.description === 'string') d.description = o.description.slice(0, 300);
    if (typeof o.icon === 'string') { if (ICON_OK.test(o.icon)) d.icon = o.icon; else errors.push(`The icon "${o.icon}" is not valid.`); }
    if (o.agent === null) d.agent = null;
    else if (typeof o.agent === 'string') { if (agents.has(o.agent)) d.agent = o.agent; else errors.push(`The agent "${o.agent}" is not available.`); }
  }
  if (typeof files['instructions.md'] === 'string') d.instructions = files['instructions.md'].slice(0, 20_000);
  const pickIds = (file: string, known: Set<string>, what: string, into: (ids: string[]) => void) => {
    const v = parseJson(files[file]);
    if (v === undefined) return;
    if (!Array.isArray(v)) return void errors.push(`${file} is not valid.`);
    const ids = strs(v), ok = ids.filter((id) => known.has(id));
    for (const id of ids) if (!known.has(id)) errors.push(`${what} "${id}" is not in the catalog.`);
    into([...new Set(ok)]);
  };
  pickIds('skills.json', new Set(catalog.skills.map((s) => s.id)), 'The skill', (ids) => { d.skills = ids; });
  pickIds('mcp.json', new Set(catalog.mcp.map((s) => s.id)), 'The MCP server', (ids) => { d.mcp = ids; });
  const h = parseJson(files['helpers.json']);
  if (h === BAD || (h !== undefined && !Array.isArray(h))) errors.push('helpers.json is not valid.');
  else if (Array.isArray(h)) {
    d.helpers = [];
    for (const x of h.slice(0, 10)) {
      const role = typeof x?.role === 'string' ? x.role.trim().slice(0, 40) : '', agent = typeof x?.agent === 'string' ? x.agent : '';
      const ag = agents.get(agent);
      if (!role) { errors.push('A helper in helpers.json needs a "role".'); continue; }
      if (!ag) { errors.push(`The helper "${role}" runs on "${agent}", which is not available here.`); continue; }
      if (!ag.helper) { errors.push(`The helper "${role}" runs on "${agent}", which can not run as a helper.`); continue; }
      const old = prev.helpers.find((p) => p.role === role);
      d.helpers.push({ role, agent, provider: old && old.agent === agent ? old.provider ?? null : null, model: old && old.agent === agent ? old.model ?? null : null, edit: x.edit === true });
    }
  }
  for (const [path, text] of Object.entries(files)) {
    const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
    if (!m || text === undefined) continue;
    const s = parseSkill(m[1]!, text);
    if (s) d.newSkills.push(s); else errors.push(`skills/${m[1]}/SKILL.md is not valid.`);
  }
  return { draft: d, errors };
}

/** Which sections differ between two drafts. */
export function changedSections(a: Draft, b: Draft): Section[] {
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const out: Section[] = [];
  if (!same([a.name, a.description, a.icon, a.agent], [b.name, b.description, b.icon, b.agent])) out.push('basics');
  if (a.instructions !== b.instructions) out.push('instructions');
  if (!same([a.skills, a.newSkills], [b.skills, b.newSkills])) out.push('skills');
  if (!same(a.mcp, b.mcp)) out.push('mcp');
  if (!same(a.helpers.map((h) => [h.role, h.agent, !!h.edit]), b.helpers.map((h) => [h.role, h.agent, !!h.edit]))) out.push('helpers');
  return out;
}

/** Which sections of the form must be written into the files: the person changed them since the last write (`pushed`) and the creator has not touched them (`files` still equals `pushed`). */
export function syncPlan(form: Draft, files: Draft, pushed: Draft): Section[] {
  const agentTouched = changedSections(files, pushed), formTouched = changedSections(form, pushed);
  return formTouched.filter((s) => !agentTouched.includes(s));
}

/** A line diff for the instructions preview. */
export function diffLines(a: string, b: string): { t: 'same' | 'add' | 'del'; s: string }[] {
  const x = a.split('\n'), y = b.split('\n'), n = x.length, m = y.length;
  const l = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) l[i]![j] = x[i] === y[j] ? l[i + 1]![j + 1]! + 1 : Math.max(l[i + 1]![j]!, l[i]![j + 1]!);
  const out: { t: 'same' | 'add' | 'del'; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ t: 'same', s: x[i]! }); i++; j++; }
    else if (l[i + 1]![j]! >= l[i]![j + 1]!) out.push({ t: 'del', s: x[i++]! });
    else out.push({ t: 'add', s: y[j++]! });
  }
  while (i < n) out.push({ t: 'del', s: x[i++]! });
  while (j < m) out.push({ t: 'add', s: y[j++]! });
  return out;
}

/** Copies one section of `from` into `into`. */
export function applySection(into: Draft, from: Draft, s: Section): Draft {
  switch (s) {
    case 'basics': return { ...into, name: from.name, description: from.description, icon: from.icon, agent: from.agent };
    case 'instructions': return { ...into, instructions: from.instructions };
    case 'skills': return { ...into, skills: from.skills, newSkills: from.newSkills };
    case 'mcp': return { ...into, mcp: from.mcp };
    case 'helpers': return { ...into, helpers: from.helpers.map((h) => ({ ...h })) };
  }
}

/** What a retired flow's main agent step leaves for a simple Assistant: its agent, instructions and skills (ids) if the flow has an agent step. */
export function simpleFromFlow(flow: { nodes?: { type?: string; config?: Record<string, any> }[] } | null | undefined): { agent: string | null; instructions: string; skills: string[] } {
  const c = flow?.nodes?.find((n) => n?.type === 'agent')?.config;
  return { agent: typeof c?.agent === 'string' ? c.agent : null, instructions: typeof c?.instructions === 'string' ? c.instructions : '', skills: strs(c?.skills) };
}
