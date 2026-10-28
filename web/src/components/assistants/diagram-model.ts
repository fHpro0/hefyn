// What the diagram shows: the groups hanging off the base agent. Pure, so the grouping and the collapse are testable.
export interface DiagramIn { agent: string | null; skills: string[]; bundledSkills: string[]; mcp: string[]; helpers: { role: string; agent: string; edit?: boolean }[]; files: string[]; instructions?: string }
export interface Names { agent: (id: string) => string; skill: (id: string) => string; mcp: (id: string) => string; /** catalog skill description */ skillHint?: (id: string) => string | undefined }
export interface Item { label: string; /** words, not colour, carry the meaning */ tag?: string; hint?: string; /** the file this entry opens */ file?: string }
export interface Group { key: 'skills' | 'mcp' | 'helpers' | 'files'; title: string; /** the arrow's verb */ verb: string; /** the file the whole lane opens */ file?: string; items: Item[] }

/** Empty groups are left out. Catalog skills and MCP servers are "on hefyn", the folder's own skills are "own". */
export function groups(d: DiagramIn, n: Names): Group[] {
  const g: Group[] = [
    { key: 'skills', title: 'Skills', verb: 'uses skill', items: [...d.skills.map((id) => ({ label: n.skill(id), tag: 'on hefyn', hint: n.skillHint?.(id) || undefined })), ...d.bundledSkills.map((s) => ({ label: s, tag: 'own', file: `skills/${s}/SKILL.md` }))] },
    { key: 'mcp', title: 'MCP servers', verb: 'calls tools', file: 'mcp.json', items: d.mcp.map((id) => ({ label: n.mcp(id), tag: 'on hefyn' })) },
    { key: 'helpers', title: 'Helpers', verb: 'delegates to', file: 'helpers.json', items: d.helpers.map((h) => ({ label: h.role, tag: h.edit === true ? 'can edit files' : 'read-only', hint: `→ ${n.agent(h.agent)}` })) },
    { key: 'files', title: `Files (${d.files.length})`, verb: 'reads', items: d.files.map((f) => ({ label: f, file: f })) },
  ];
  return g.filter((x) => x.items.length);
}

/** One-line hint of the instructions: whitespace folded, cut at `n` chars. */
export const snippet = (s = '', n = 120) => {
  const t = s.replace(/^ {0,3}(?:`{3,}|~{3,}).*$/gm, '').replace(/<[^>\n]*>/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)+/gm, '').replace(/(\*\*|__|[*`]|(?<!\w)_|_(?!\w))/g, '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t; };

/** Node ids on the path You → agent → node: lanes are their group key, entries `key:index`, the instructions card `instructions`. */
export const trace = (id: string): Set<string> => new Set(['you', 'agent', id, id.split(':')[0]!]);

/** A long list shows its first `limit` entries until "show all". */
export const collapse = <T,>(items: T[], limit: number, all: boolean) => ({ shown: all ? items : items.slice(0, limit), more: all ? 0 : Math.max(0, items.length - limit) });

export const MAX_ZIP = 10 * 1024 * 1024;
