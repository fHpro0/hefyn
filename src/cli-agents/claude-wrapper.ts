// Claude Code, unmodified, in a PTY (docs/WRAPPER.md). The chat is built from what Claude Code itself reports: its hooks (http, to /hooks/<event> on the
// model socket) and its transcript (JSONL). This file is the pure part: payloads in, the event-log shapes the chat already renders out (ACP-style
// `tool_call`, `agent_message_chunk` ..., see web cli-transcript.ts). Formats captured from Claude Code 2.1.310 (test/fixtures/claude-wrapper/captured.json).

export type Update = Record<string, any>;
export interface PermissionOption { optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }

interface Tool { name: string; input: any; emitted: boolean; done: boolean; claimed?: boolean }
const SUB = /^(task|agent)$/i;
const KIND: Record<string, string> = { Read: 'read', Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Bash: 'execute', Grep: 'search', Glob: 'search', WebFetch: 'fetch', WebSearch: 'fetch' };
const clip = (s: unknown, n = 100) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** What the user typed or hefyn sent, made safe for a bracketed paste: no escape sequences (they could end the paste early), CRLF as LF. */
export const pasteText = (t: string) => t.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
/** A prompt Claude Code made up itself (a background agent finished ...): not something the user said. */
export const isSystemPrompt = (p: string) => /^\s*<[a-z-]+>/.test(p) && /^\s*<(task-notification|system-reminder|command-)/.test(p);

export function toolInfo(name: string, input: any): { title: string; kind: string; content: Update[] } {
  const i = input && typeof input === 'object' ? input : {}, path = typeof i.file_path === 'string' ? i.file_path : typeof i.notebook_path === 'string' ? i.notebook_path : undefined;
  const what = path ?? (name === 'Bash' ? (i.description || i.command) : i.pattern ?? i.url ?? i.query ?? (SUB.test(name) ? i.description : undefined));
  const diff = (p: string, oldText: string | null, newText: string) => ({ type: 'diff', path: p, oldText, newText });
  let content: Update[] = [];
  if (name === 'Write' && path) content = [diff(path, null, String(i.content ?? ''))];
  else if (name === 'Edit' && path) content = [diff(path, String(i.old_string ?? ''), String(i.new_string ?? ''))];
  else if (name === 'MultiEdit' && path && Array.isArray(i.edits)) content = i.edits.map((e: any) => diff(path, String(e?.old_string ?? ''), String(e?.new_string ?? '')));
  return { title: what ? `${name} ${clip(what)}` : name, kind: KIND[name] ?? (SUB.test(name) ? 'think' : 'other'), content };
}

const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('') : '');

const MAX_IMAGE = 5_000_000; // base64 chars: the event log is sealed in sqlite and streamed with no cap
/** The image blocks of a tool result (Anthropic shape) as ACP tool content; an oversized one becomes a short note. */
const imagesOf = (c: unknown): Update[] => !Array.isArray(c) ? [] : c.filter((b: any) => b?.type === 'image' && typeof b.source?.data === 'string').map((b: any) => {
  const d: string = b.source.data;
  return d.length > MAX_IMAGE ? { type: 'content', content: { type: 'text', text: `Image too large to show (${Math.round(d.length / 1e6)} MB).` } }
    : { type: 'content', content: { type: 'image', data: d, mimeType: String(b.source.media_type || 'image/png') } };
});

/** `sidechain`: this mapper reads a sub-agent's own transcript and hooks (lines with isSidechain), the default one the main conversation's. */
export class Mapper {
  private tools = new Map<string, Tool>();
  private text = false; // the last event was a text block: the next one is a new paragraph
  constructor(private sidechain = false) {}
  has(id: string) { return this.tools.has(id); }
  /** The latest-started Agent/Task call that no sub-agent has been matched to yet (a SubagentStart carries no tool_use_id): oldest first, so parallel ones pair in order. */
  claimAgent(): { id: string; description: string; type: string } | undefined {
    for (const [id, t] of this.tools) if (SUB.test(t.name) && t.emitted && !t.done && !t.claimed) { t.claimed = true; return { id, description: clip(t.input?.description ?? t.input?.prompt, 200), type: clip(t.input?.subagent_type, 60) }; }
  }

  private call(id: string, name: string, input: any, status: string): Update[] {
    const t = this.tools.get(id) ?? { name, input, emitted: false, done: false };
    this.tools.set(id, t);
    if (name === 'TodoWrite' && Array.isArray(input?.todos)) {
      t.emitted = t.done = true;
      return [{ sessionUpdate: 'plan', entries: input.todos.map((x: any) => ({ content: String(x?.content ?? ''), priority: 'medium', status: x?.status === 'completed' || x?.status === 'in_progress' ? x.status : 'pending' })) }];
    }
    const info = toolInfo(name, input);
    if (t.emitted) return status === 'pending' ? [] : [{ sessionUpdate: 'tool_call_update', toolCallId: id, status }];
    t.emitted = true;
    return [{ sessionUpdate: 'tool_call', toolCallId: id, title: info.title, kind: info.kind, status, rawInput: input, content: info.content }];
  }
  private finish(id: string, failed: boolean, text?: string, extra?: Update[]): Update[] {
    const t = this.tools.get(id);
    if (!t || t.done) return [];
    t.done = true;
    const content = failed || (!extra && KIND[t.name] !== 'edit') ? (text ? [{ type: 'content', content: { type: 'text', text } }] : undefined) : extra;
    return [{ sessionUpdate: 'tool_call_update', toolCallId: id, status: failed ? 'failed' : 'completed', ...(content ? { content } : {}) }];
  }
  /** Tools still open (a cancelled turn leaves them so). */
  closeTools(): Update[] {
    const out: Update[] = [];
    for (const [id, t] of this.tools) if (t.emitted && !t.done) { t.done = true; out.push({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed' }); }
    return out;
  }

  /** One line of the transcript. `end`: the line says the turn is over (turn_duration, or an interrupt). Side chains (sub-agents) have their own files and are not read. */
  line(o: any): { events: Update[]; end?: 'done' | 'interrupted' } {
    const events: Update[] = [];
    if (!o || typeof o !== 'object' || !!o.isSidechain !== this.sidechain) return { events };
    if (o.type === 'system' && o.subtype === 'turn_duration') { this.text = false; return { events, end: 'done' }; }
    const content = o.message?.content;
    if (o.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        // each text block is its own paragraph: blocks with nothing between them would otherwise run together in the chat
        if (b?.type === 'text' && b.text) { events.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: (this.text ? '\n\n' : '') + String(b.text) } }); this.text = true; }
        else if (b?.type === 'thinking' && b.thinking) events.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: String(b.thinking) } });
        else if (b?.type === 'tool_use' && typeof b.id === 'string') { const c = this.call(b.id, String(b.name), b.input, 'pending'); events.push(...c); if (c.length) this.text = false; } // only a call that makes a new row splits the text: a PreToolUse hook may have emitted it already (out of order), and the texts around it would run together
      }
    } else if (this.sidechain && o.type === 'user' && typeof content === 'string') {
      events.push({ hefyn: 'user', text: content.slice(0, 20_000) }); // the brief the sub-agent was given
    } else if (o.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const text = textOf(b.content).slice(0, 20_000), id = b.tool_use_id, imgs = imagesOf(b.content);
          if (!imgs.length) events.push(...this.finish(id, b.is_error === true, text));
          else {
            const content = [...(text ? [{ type: 'content', content: { type: 'text', text } }] : []), ...imgs]; // an update replaces the content, so the text goes along
            const open = this.finish(id, b.is_error === true, text, content);
            // the PostToolUse hook may have finished the tool already: the images still need to reach the chat
            events.push(...(open.length ? open : this.tools.has(id) ? [{ sessionUpdate: 'tool_call_update', toolCallId: id, content }] : []));
          }
        }
        else if (b?.type === 'text' && /^\[Request interrupted/.test(String(b.text))) return { events, end: 'interrupted' };
      }
    }
    return { events };
  }

  /** A hook that is not a question: tool progress. A sub-agent's tool hooks (`agent_id`) go to that sub-agent's own mapper (the host picks). */
  hook(event: string, b: any): Update[] {
    if (typeof b?.tool_use_id !== 'string') return [];
    if (event === 'PreToolUse') return this.call(b.tool_use_id, String(b.tool_name), b.tool_input, 'in_progress');
    if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
      const r = b.tool_response, failed = event === 'PostToolUseFailure' || (typeof r === 'string' && /^Error:/.test(r));
      this.call(b.tool_use_id, String(b.tool_name), b.tool_input, 'in_progress'); // a tool we never saw start
      const old = b.tool_name === 'Write' && typeof r?.originalFile === 'string' && r.type === 'update' && typeof b.tool_input?.file_path === 'string' ? [{ type: 'diff', path: b.tool_input.file_path, oldText: r.originalFile, newText: String(b.tool_input.content ?? '') }] : undefined;
      return this.finish(b.tool_use_id, failed, failed ? clip(typeof r === 'string' ? r.replace(/^Error:\s*/, '') : b.error, 2000) : undefined, old);
    }
    return [];
  }

  /** The PreToolUse that a PermissionRequest (which has no tool_use_id) belongs to: the latest started, unfinished tool of that name and input. */
  toolFor(b: any): string | undefined {
    const want = JSON.stringify(b?.tool_input ?? null);
    return [...this.tools].reverse().find(([, t]) => !t.done && t.name === b?.tool_name && JSON.stringify(t.input ?? null) === want)?.[0];
  }
}

/** The chat card for a PermissionRequest hook: Claude Code's own question, with the choices its dialog has. */
export function permissionOptions(b: any): PermissionOption[] {
  return [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    ...(Array.isArray(b?.permission_suggestions) && b.permission_suggestions.length ? [{ optionId: 'allow_session', name: 'Allow for this session', kind: 'allow_always' as const }] : []),
    { optionId: 'deny', name: 'Don’t allow', kind: 'reject_once' },
  ];
}
export function permissionCall(b: any, toolCallId: string) {
  const info = toolInfo(String(b?.tool_name ?? 'a step'), b?.tool_input);
  return { toolCallId, title: info.title, kind: info.kind, rawInput: b?.tool_input, content: info.content };
}
/** The hook's answer: the user's choice from the chat, or nothing (`{}`: Claude Code asks in its own terminal). */
export function hookDecision(b: any, optionId: string | null): Update {
  if (optionId === null) return {};
  const allow = optionId === 'allow' || optionId === 'allow_session';
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: allow
    // "for this session" means it: Claude Code's own suggestions may name a settings file (localSettings/projectSettings), which lives in /files and would carry the rule into every other chat of the user
    ? { behavior: 'allow', ...(optionId === 'allow_session' ? { updatedPermissions: (Array.isArray(b?.permission_suggestions) ? b.permission_suggestions : []).map((s: any) => ({ ...s, destination: 'session' })) } : {}) }
    : { behavior: 'deny', message: 'The user did not allow this in the chat.' } } };
}
