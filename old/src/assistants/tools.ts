import * as v from 'valibot';
import { useDataTools } from '../agents/data-tools.ts';
import { offOf } from '../agents/tool-filter.ts';
import { profileOf } from '../cli-agents/profiles.ts';
import { assistantAvailability } from '../server/assistant-access.ts';
import { visibleTo } from '../server/assistants.ts';
import { actorOf, hasCollections } from '../server/data.ts';
import { connectorFor, listConnectors, openClient } from '../server/mcp.ts';
import { fsFor, shellEnabled } from '../server/runner.ts';
import { type Flow, isSimple } from './flow.ts';
import { skillPackages } from './validate.ts';

// The Tools tab (docs/ASSISTANTS.md "Tools"): what each agent step of an Assistant can use, and a way to try a tool. Which tools are OFF is the Assistant's `flow.tools.disabled`;
// the agent process applies it (agents/tool-filter.ts, mount.ts, cli-agents/mcp.ts). Everything here is for the person editing: no model is involved.

export type ToolSource = 'builtin' | 'connector' | 'skill' | 'assistant';
export interface ToolItem { id: string; name: string; description: string; source: ToolSource; /** the connector's or kind's name */ group: string; enabled: boolean; tryable: boolean; readOnly?: boolean; schema?: unknown }
export interface ToolGroup { name: string; source: ToolSource | 'agent'; items: ToolItem[]; /** shown instead of items that cannot be listed */ note?: string }
export interface StepTools { node: string; label: string; agent: string | null; agentName: string; groups: ToolGroup[]; on: number; total: number }

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms).unref())]);
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const str = (description: string) => ({ type: 'string', description });

interface Def { name: string; title: string; description: string; readOnly: boolean; schema: unknown }
const FILES: Def[] = [
  { name: 'read', title: 'Read a file', description: 'Open a file from your files and read it.', readOnly: true, schema: obj({ path: str('Where the file is, for example /files/notes.txt') }, ['path']) },
  { name: 'write', title: 'Create or replace a file', description: 'Save text as a file in your files. An existing file with that name is replaced.', readOnly: false, schema: obj({ path: str('Where to save it'), content: str('The text to save') }, ['path', 'content']) },
  { name: 'edit', title: 'Change part of a file', description: 'Replace a piece of text inside an existing file.', readOnly: false, schema: obj({ path: str('The file'), old_string: str('The text to replace'), new_string: str('What to put instead') }, ['path', 'old_string', 'new_string']) },
];
const SHELL: Def[] = [
  { name: 'bash', title: 'Run commands', description: 'Run shell commands in your private sandbox (no internet access).', readOnly: false, schema: obj({ command: str('The command to run') }, ['command']) },
  { name: 'grep', title: 'Search inside files', description: 'Find the files that contain some text.', readOnly: true, schema: obj({ pattern: str('What to look for'), path: str('Where to look') }, ['pattern']) },
  { name: 'glob', title: 'Find files by name', description: 'List files whose name matches a pattern such as *.pdf.', readOnly: true, schema: obj({ pattern: str('The name pattern'), path: str('Where to look') }, ['pattern']) },
];
const LIST: Def = { name: 'list', title: 'List files', description: 'Show the files and folders in a folder of your files.', readOnly: true, schema: obj({ path: str('The folder, for example /files'), recursive: { type: 'boolean', description: 'Also list the folders inside (the agent can; the Try box lists one level)' } }) };
const DATA: Def[] = [
  { name: 'data_collections', title: 'See your data collections', description: 'List your data collections (tables), their fields and how many records they hold.', readOnly: true, schema: obj({}) },
  { name: 'data_query', title: 'Read records', description: 'Look up records of a data collection, with an optional filter and sort order.', readOnly: true, schema: obj({ collection: str('The collection\'s name or slug'), filter: str('For example status != "done"'), sort: str('A field, with - in front for descending'), limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many records at most' } }, ['collection']) },
  { name: 'data_create', title: 'Add a record', description: 'Add a new record to a data collection you can edit.', readOnly: false, schema: obj({ collection: str('The collection'), values: { type: 'object', description: 'Field names with their values' } }, ['collection', 'values']) },
  { name: 'data_update', title: 'Change a record', description: 'Change fields of an existing record.', readOnly: false, schema: obj({ collection: str('The collection'), id: str('The record\'s id'), values: { type: 'object', description: 'The fields to change' } }, ['collection', 'id', 'values']) },
];
const TRYABLE = new Set(['read', 'list', 'data_collections', 'data_query']);

/** The built-in tools a hefyn agent gets for this person: the sandbox's (the shell ones only with sandbox.shell) and the data ones (only with data.use and a collection). */
function builtinDefs(userId: string): Def[] {
  const a = actorOf(userId);
  const data = !!a && a.permissions.includes('data.use') && hasCollections(a);
  return [...(shellEnabled(userId) ? [SHELL[0]!, SHELL[1]!, SHELL[2]!, FILES[0]!, FILES[1]!, FILES[2]!] : [FILES[0]!, FILES[1]!, FILES[2]!, LIST]), ...(data ? DATA : [])];
}

interface ConnectorTools { id: string; name: string; tools: { name: string; description: string; schema: unknown; readOnly: boolean }[] }
/** The tools of the person's connectors (own and team); one that does not answer within 4 s is listed without tools. */
async function connectorTools(userId: string): Promise<ConnectorTools[]> {
  return Promise.all(listConnectors(userId).map(async (r) => {
    let tools: ConnectorTools['tools'] = [];
    try {
      const c = await withTimeout(openClient(userId, r.id), 4000);
      try { tools = (await withTimeout(c.listTools(), 4000)).tools.map((t) => ({ name: t.name, description: t.description ?? t.title ?? '', schema: t.inputSchema, readOnly: t.annotations?.readOnlyHint === true })); } finally { await c.close().catch(() => {}); }
    } catch { /* unreachable: listed without tools */ }
    return { id: r.id as string, name: r.name as string, tools };
  }));
}

export async function toolsOf(me: { id: string; roleId: string | undefined }, flow: Flow, selfId?: string): Promise<{ steps: StepTools[]; disabled: string[] }> {
  const off = offOf(flow), enabled = (id: string) => !off.has(id);
  const [conns, others] = await Promise.all([connectorTools(me.id), (async () => {
    const mine = visibleTo(me.id, me.roleId).filter((a) => a.id !== selfId);
    const ok = await Promise.all(mine.map((a) => assistantAvailability(me.id, a).then((r) => r.available, () => false)));
    return mine.filter((_, i) => ok[i]);
  })()]);
  const skills = new Map(skillPackages().map((s) => [s.id, s]));
  const hefyn = (): ToolGroup[] => {
    const item = (d: Def): ToolItem => ({ id: `builtin:${d.name}`, name: d.title, description: d.description, source: 'builtin', group: 'hefyn', enabled: enabled(`builtin:${d.name}`), tryable: TRYABLE.has(d.name), readOnly: d.readOnly, schema: d.schema });
    const defs = builtinDefs(me.id), data = defs.filter((d) => d.name.startsWith('data_'));
    return [
      { name: 'Files and sandbox', source: 'builtin', items: defs.filter((d) => !d.name.startsWith('data_')).map(item) },
      ...(data.length ? [{ name: 'Your data', source: 'builtin' as const, items: data.map(item) }] : []),
      ...conns.map((c): ToolGroup => ({ name: c.name, source: 'connector', note: c.tools.length ? undefined : 'No tools to show: the connector did not answer, or has none.',
        items: c.tools.map((t) => ({ id: `connector:${c.id}:${t.name}`, name: t.name, description: t.description, source: 'connector', group: c.name, enabled: enabled(`connector:${c.id}:${t.name}`), tryable: true, readOnly: t.readOnly, schema: t.schema })) })),
    ];
  };
  const steps = flow.nodes.filter((n) => n?.type === 'agent').map((n): StepTools => {
    const agent = n.config.agent ? String(n.config.agent) : null, profile = agent ? profileOf(agent) : undefined;
    const groups: ToolGroup[] = agent ? [{ name: `${profile?.name ?? 'The agent'}'s own tools`, source: 'agent', items: [], note: `${profile?.name ?? 'The agent'} brings its own tools (such as a shell, file editing and web search) and asks in the chat before it uses them. hefyn does not list or switch them.` }] : hefyn();
    const picked = (Array.isArray(n.config.skills) ? n.config.skills : []).map(String);
    if (picked.length) groups.push({ name: 'Skills', source: 'skill', items: picked.map((id): ToolItem => ({ id: `skill:${id}`, name: skills.get(id)?.name ?? id, description: skills.get(id)?.description ?? '', source: 'skill', group: 'Skills', enabled: enabled(`skill:${id}`), tryable: false })) });
    if (agent && profile?.hasMcp) {
      if (isSimple(flow)) groups.push({ name: 'Other Assistants', source: 'assistant', items: others.map((a): ToolItem => ({ id: `assistant:${a.id}`, name: a.name, description: a.description || a.name, source: 'assistant', group: 'Other Assistants', enabled: enabled(`assistant:${a.id}`), tryable: false })) });
      else groups.push({ name: 'Other Assistants', source: 'assistant', items: [], note: 'Assistants are offered to an agent as tools only when the agent is the Assistant\'s only step.' });
    }
    const all = groups.flatMap((g) => g.items);
    return { node: n.id, label: typeof n.label === 'string' && n.label ? n.label : n.id, agent, agentName: profile?.name ?? 'hefyn', groups, on: all.filter((t) => t.enabled).length, total: all.length };
  });
  return { steps, disabled: [...off] };
}

// ---- trying a tool ----
export const MAX_RESULT = 64 * 1024;
export interface TryResult { ok: boolean; result?: unknown; truncated?: boolean; error?: string; ms: number }
const clip = (result: unknown): { result: unknown; truncated?: boolean } => {
  const s = typeof result === 'string' ? result : JSON.stringify(result) ?? '';
  return s.length > MAX_RESULT ? { result: s.slice(0, MAX_RESULT), truncated: true } : { result };
};
const textOf = (parts: { type: string; text?: string }[]) => parts.map((p) => (p.type === 'text' ? p.text ?? '' : `[${p.type}]`)).join('\n');
const parsed = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

/** Calls a tool as the person (their own connector credentials, their own files and data). Only tools that change nothing are tried: no writes, edits or commands. */
export async function tryTool(userId: string, tool: string, args: Record<string, unknown>): Promise<TryResult> {
  const t0 = Date.now(), done = (r: Omit<TryResult, 'ms'>): TryResult => ({ ...r, ms: Date.now() - t0 });
  const [kind, ...rest] = tool.split(':');
  try {
    if (kind === 'connector') {
      const cid = rest[0] ?? '', name = rest.slice(1).join(':');
      if (!name || !connectorFor(userId, cid)) return done({ ok: false, error: 'That connector is not available to you.' });
      const c = await withTimeout(openClient(userId, cid), 15_000);
      try {
        const res = await withTimeout(c.callTool({ name, arguments: args }), 60_000) as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
        const text = textOf(res.content ?? []);
        if (res.isError) return done({ ok: false, error: text.slice(0, 2000) || 'The tool reported an error.' });
        return done({ ok: true, ...clip(res.structuredContent !== undefined ? res.structuredContent : parsed(text)) });
      } finally { await c.close().catch(() => {}); }
    }
    const name = kind === 'builtin' ? rest.join(':') : '';
    if (kind === 'builtin' && !TRYABLE.has(name) && [...FILES, ...SHELL, LIST, ...DATA].some((d) => d.name === name)) return done({ ok: false, error: 'This tool changes things or runs commands, so it cannot be tried here. The agent uses it inside a chat.' });
    if (kind === 'builtin' && (name === 'read' || name === 'list')) {
      const path = typeof args.path === 'string' ? args.path : name === 'list' ? '/files' : '';
      if (!/^\/files(\/|$)/.test(path) || path.split('/').includes('..')) return done({ ok: false, error: 'Give a path inside /files, for example /files/notes.txt.' });
      const fs = fsFor(userId, `u_${userId}_teststep`);
      if (name === 'read') return done({ ok: true, ...clip(Buffer.from(await fs.readFileBuffer(path)).toString('utf8')) });
      return done({ ok: true, ...clip((await fs.list(path)).map((e) => (e.type === 'dir' ? `${e.name}/` : e.name))) });
    }
    if (kind === 'builtin' && (name === 'data_collections' || name === 'data_query')) {
      let def: { input?: v.GenericSchema; run(a: { data: unknown }): Promise<unknown> } | undefined;
      useDataTools(userId, ((d: { name: string }) => { if (d.name === name) def = d as never; }) as never);
      if (!def) return done({ ok: false, error: 'You have no data collections to read.' });
      const p = v.safeParse(def.input ?? v.object({}), args);
      if (!p.success) return done({ ok: false, error: p.issues.map((i) => `${i.path?.map((k) => k.key).join('.') || 'input'}: ${i.message}`)[0]! });
      const out = await def.run({ data: p.output });
      return done({ ok: true, ...clip(typeof out === 'string' ? parsed(out) : out) });
    }
    return done({ ok: false, error: kind === 'skill' || kind === 'assistant' ? 'Skills and Assistants are used by the agent inside a chat; they cannot be called here.' : 'Unknown tool.' });
  } catch (e) { return done({ ok: false, error: e instanceof Error && e.message === 'timeout' ? 'The tool did not answer in time.' : e instanceof Error ? e.message : String(e) }); }
}
