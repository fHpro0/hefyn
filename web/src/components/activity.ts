// What a chat is doing right now, as pure functions (no React, no fetch). Two sources: the open page (it holds the live stream, so it knows first)
// and the server's `conversations.activity` (covers other chats and a reload mid-run). A chat is never idle while either says it works.

export type ActivityState = 'running' | 'waiting' | 'idle';
export interface ActivityAgent { id?: string; name: string; kind: 'helper' | 'assistant' | 'agent' | 'step'; state: 'running' | 'waiting' | 'done' | 'failed'; /** what a waiting agent asks to do: a tool kind or name, never a target */ ask?: string }
/** One entry of `conversations.activity` (idle chats may be missing). `since` is an ISO time. `ask`: what the chat itself (not a sub-agent) asks to do. */
export interface Activity { state: ActivityState; since?: string; label?: string; agents?: ActivityAgent[]; ask?: string }
/** What the open page says about its own chat (sent as the `hefyn-busy` event). `since` is in ms. */
export interface Live { busy: boolean; waiting?: boolean; label?: string; agents?: ActivityAgent[]; since?: number }
export interface Status { state: ActivityState; since?: number; label?: string; agents: ActivityAgent[]; ask?: string }
export const IDLE: Status = { state: 'idle', agents: [] };

const active = (a: ActivityAgent) => a.state === 'running' || a.state === 'waiting';
/** The agents that are still working, from both sources, once each. */
export function mergeAgents(local?: ActivityAgent[], remote?: ActivityAgent[]): ActivityAgent[] {
  const seen = new Set<string>(), out: ActivityAgent[] = [];
  const all = [...(local ?? []), ...(remote ?? [])].sort((a, b) => Number(!a.id) - Number(!b.id)); // ones with an id first: two sub-agents of one name stay two, an id-less twin of one is dropped
  for (const a of all) { const k = `${a.kind}:${a.id ?? a.name}`; if (active(a) && !seen.has(k)) { seen.add(k); seen.add(`${a.kind}:${a.name}`); out.push(a); } }
  return out;
}

export function chatActivity(local?: Live, remote?: Activity): Status {
  const state: ActivityState = local?.waiting ? 'waiting' : local?.busy ? 'running' : remote?.state ?? 'idle';
  if (state === 'idle') return IDLE;
  const since = local?.since ?? (remote?.since ? Date.parse(remote.since) : undefined);
  return { state, since: since && !Number.isNaN(since) ? since : undefined, label: local?.label ?? remote?.label, agents: mergeAgents(local?.agents, remote?.agents), ...(remote?.ask ? { ask: remote.ask } : {}) };
}

/** One open request somewhere in the reader's chats. `lane` is the sub-agent that asks (absent: the chat's own agent). */
export interface Attention { key: string; chatId: string; title: string; lane?: string; who?: string; text: string }
const VERBS: [RegExp, string][] = [
  [/^(write|edit|multiedit|notebookedit)$/i, 'write a file'], [/^delete$/i, 'delete a file'], [/^move$/i, 'move a file'], [/^read$/i, 'read a file'],
  [/^(search|grep|glob)$/i, 'search your files'], [/^(execute|bash)$/i, 'run a command'], [/^(fetch|webfetch|websearch)$/i, 'use the web'], [/^(task|agent)$/i, 'start a helper'], [/^mcp__/i, 'use a tool'],
];
/** "<who> wants to write a file"; an unknown kind (or a flow's question) is "<who> needs your answer". */
export function askSentence(who: string | undefined, ask?: string): string {
  const verb = ask && (VERBS.find(([re]) => re.test(ask))?.[1] ?? 'do something'), w = who || 'The agent';
  return verb ? `${w} wants to ${verb}` : `${w} needs your answer`;
}
/** Every chat that waits for the reader (and every waiting sub-agent in it), except the chat that is open: its own dock shows the request. */
export function attention(states: Record<string, Status>, titles: Record<string, string>, openChat?: string): Attention[] {
  const out: Attention[] = [];
  for (const [chatId, s] of Object.entries(states)) {
    if (s.state !== 'waiting' || chatId === openChat || !(chatId in titles)) continue; // not in the list: archived or deleted
    const title = titles[chatId]!, subs = s.agents.filter((a) => a.kind === 'agent' && a.id && a.state === 'waiting');
    for (const a of subs) out.push({ key: `${chatId}:${a.id}`, chatId, title, lane: a.id, who: a.name, text: askSentence(a.name, a.ask) });
    if (s.ask || !subs.length) out.push({ key: chatId, chatId, title, text: askSentence(undefined, s.ask) });
  }
  return out;
}
/** The tab title: "(2) …" while requests wait, "● …" while something works. */
export const pageTitle = (base: string, waiting: number, working: boolean) => (waiting ? `(${waiting}) ${base}` : working ? `● ${base}` : base);
export const bareTitle = (t: string) => t.replace(/^(\(\d+\) |● )/, '');

/** "<1 s", "12 s", "4 min 12 s", "47 min" (seconds dropped from 10 min), "2 h 5 min". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), r = s % 60;
  if (s < 1) return '<1 s';
  if (s < 60) return `${s} s`;
  if (s < 600) return r ? `${m} min ${r} s` : `${m} min`;
  if (s < 3600) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
}

/** The classic chat's delegations still running: `task` tool parts (input.agent) that have no output yet. Pass the parts of the last message only. */
export function delegations(parts: { type: string; toolName?: string; input?: unknown; state?: string }[]): ActivityAgent[] {
  return parts.filter((p) => p.type === 'dynamic-tool' && p.toolName === 'task' && p.state !== 'output-available' && p.state !== 'output-error')
    .map((p) => ({ name: String((p.input as { agent?: unknown } | undefined)?.agent ?? 'agent'), kind: 'helper' as const, state: 'running' as const }));
}

/** The line under "Working…": flow steps, the classic chat's delegations and CLI sub-agents each get their own wording. */
export function helperLine(agents: ActivityAgent[]): string {
  const names = (k: (a: ActivityAgent) => boolean) => agents.filter(k).map((a) => a.name).join(', ');
  const groups: [string, (a: ActivityAgent) => boolean][] = [['Working on', (a) => a.kind === 'step' || a.kind === 'assistant'], ['Helpers working', (a) => a.kind === 'helper'], ['Sub-agent', (a) => a.kind === 'agent']];
  return groups.map(([prefix, k]) => (names(k) ? `${prefix}: ${names(k)}` : '')).filter(Boolean).join(' · ');
}
