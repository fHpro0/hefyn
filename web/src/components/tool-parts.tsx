import { FileText, Globe, MessagesSquare, Search, Terminal as TerminalIcon, Wrench } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/ui/button';
import { Label, Subagent, SubagentContent, SubagentHeader, Terminal, Tool, ToolContent, ToolCode, ToolHeader, ToolInput, ToolOutput } from './ai-elements';
import { Elapsed } from './ActivityStatus';
import { Dialog } from './dialogs';
import { Md } from './markdown';

// A Flue tool part rendered with AI Elements: task -> Subagent, bash -> Terminal, the rest -> Tool.
// ---- output handling: a string, or { content: [{type:'text'|'image'}], details: { exitCode } } ----
interface Img { src?: string }
export function normalize(out: unknown) {
  let text = ''; let stdout: string | undefined; let stderr: string | undefined; let exit: number | undefined; const images: Img[] = [];
  const o = out as any;
  if (typeof out === 'string') text = out;
  else if (Array.isArray(o?.content) || Array.isArray(o)) {
    for (const c of (o.content ?? o) as any[]) {
      if (c?.type === 'text') text += (text ? '\n' : '') + c.text;
      else if (c?.type === 'image') images.push(typeof c.data === 'string' && !c.data.startsWith('[') ? { src: c.data.startsWith('data:') ? c.data : `data:${c.mimeType ?? 'image/png'};base64,${c.data}` } : {});
    }
    if (typeof o.details?.exitCode === 'number') exit = o.details.exitCode;
  } else if (o && typeof o === 'object') {
    if (typeof o.stdout === 'string' || typeof o.stderr === 'string') { stdout = o.stdout ?? ''; stderr = o.stderr ?? ''; text = [stdout, stderr].filter(Boolean).join('\n'); }
    else text = JSON.stringify(out, null, 2);
    if (typeof o.exitCode === 'number') exit = o.exitCode;
  } else if (out !== undefined) text = String(out);
  const m = /\n*Command exited with code (\d+)\s*$/.exec(text);
  if (m) { exit = Number(m[1]); text = text.slice(0, m.index); }
  return { text, stdout, stderr, exit, images };
}

export function Shot({ img }: { img: Img }) {
  const [big, setBig] = useState(false);
  if (!img.src) return <p className="text-sm text-muted-foreground">The image is not kept in the history.</p>;
  return (
    <>
      <button type="button" onClick={() => setBig(true)} aria-label="Enlarge image" className="block max-w-md cursor-zoom-in overflow-hidden rounded-lg bg-muted ring-1 ring-border outline-none focus-visible:ring-2 focus-visible:ring-ring/50"><img src={img.src} alt="Image from the tool" className="block max-h-64 w-full object-contain object-top" /></button>
      {big && <Dialog title="Screenshot" xl onClose={() => setBig(false)}><img src={img.src} alt="Screenshot from the tool, enlarged" className="w-full rounded-lg ring-1 ring-border" /><div className="flex justify-end"><Button variant="outline" onClick={() => setBig(false)}>Close</Button></div></Dialog>}
    </>
  );
}

const MCP_NAME = /^mcp__(.+?)_[0-9a-f]{4}__(.+)$/;
const human = (n: string) => { const s = n.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };

/** Web pages and chats a tool call used, for the Sources line under an answer. */
export function sourcesOf(parts: { type: string; toolName?: string; input?: unknown; state?: string }[]) {
  const seen = new Map<string, string>();
  for (const p of parts) {
    if (p.type !== 'dynamic-tool' || p.state === 'output-error') continue;
    const i = (p.input ?? {}) as Record<string, unknown>;
    if (typeof i.url === 'string' && /^https?:\/\//.test(i.url)) seen.set(i.url, new URL(i.url).hostname);
  }
  return [...seen].map(([href, title]) => ({ href, title }));
}

export default function ToolPart({ name, input, state, output, errorText, ms, models }: { name: string; input: Record<string, any>; state: string; output?: unknown; errorText?: string; ms?: string; models?: Record<string, string | undefined> }) {
  const failed = state === 'output-error', done = state === 'output-available';
  const st = failed ? 'error' : done ? 'done' : 'running';
  const o = normalize(failed ? errorText : output);
  const [pick, setPick] = useState<boolean>();
  const Pair = ({ k, children }: { k: string; children: ReactNode }) => <div><Label>{k}</Label>{children}</div>;

  if (name === 'task') {
    const agent = String(input.agent ?? 'agent');
    return (
      <Subagent open={pick ?? st === 'running'} onOpenChange={setPick}>{/* open while it runs, collapsed once finished unless the reader opened it */}
        <SubagentHeader name={agent} model={models?.[agent]} task={input.description ?? input.prompt} state={st} ms={st === 'running' ? <Elapsed /> : ms} />
        <SubagentContent>
          <Pair k="Task"><p className="text-sm whitespace-pre-wrap">{String(input.prompt ?? '')}</p></Pair>
          {o.text && <Pair k={failed ? 'Error' : 'Result'}><div className="text-sm"><Md>{o.text}</Md></div></Pair>}
        </SubagentContent>
      </Subagent>
    );
  }

  if (name === 'bash') {
    const code = o.exit ?? (done ? 0 : undefined), bad = failed || (code !== undefined && code !== 0);
    return (
      <Tool defaultOpen>
        <ToolHeader icon={<TerminalIcon />} state={bad ? 'error' : st} title="Run" detail={String(input.command ?? '')} ms={ms} />
        <ToolContent><Terminal command={String(input.command ?? '')} stdout={o.stdout} stderr={o.stderr} text={o.text} exit={code} running={state === 'input-available'} /></ToolContent>
      </Tool>
    );
  }

  if (name === 'grep' || name === 'glob') {
    const lines = o.text.split('\n').filter(Boolean);
    return (
      <Tool>
        <ToolHeader icon={<Search />} state={st} title={name === 'grep' ? 'Search' : 'Find files'} detail={`${input.pattern ?? ''}${input.path ? ` in ${input.path}` : ''}`} ms={done ? `${lines.length} ${lines.length === 1 ? 'match' : 'matches'}` : undefined} />
        <ToolContent>{lines.length ? <ToolCode code={lines.join('\n')} lang="text" title="Matches" /> : <p className="text-sm text-muted-foreground">No matches.</p>}</ToolContent>
      </Tool>
    );
  }

  if (name === 'message_chat') { // the result is { chat: <title>, answer }; a failure is plain text
    let r: { chat?: string; answer?: string } = {};
    try { r = JSON.parse(o.text); } catch { /* running or failed */ }
    return (
      <Subagent open={pick ?? st === 'running'} onOpenChange={setPick}>
        <SubagentHeader name={r.chat ?? 'another chat'} task={`Asked: ${input.message ?? ''}`} state={st} ms={ms} />
        <SubagentContent>
          <Pair k="Message"><p className="text-sm whitespace-pre-wrap">{String(input.message ?? '')}</p></Pair>
          {(r.answer ?? (failed ? o.text : '')) && <Pair k={failed ? 'Error' : 'Answer'}><div className="text-sm"><Md>{r.answer ?? o.text}</Md></div></Pair>}
        </SubagentContent>
      </Subagent>
    );
  }


  const mcp = MCP_NAME.exec(name);
  const verb = name === 'read' ? 'Read' : name === 'write' ? 'Write' : name === 'edit' ? 'Edit' : name === 'list' ? 'List' : null;
  const Icon = /playwright|browser/i.test(name) ? Globe : verb ? FileText : name === 'message_chat' ? MessagesSquare : Wrench;
  return (
    <Tool>
      <ToolHeader icon={<Icon />} state={st} title={verb ?? human(mcp ? mcp[2] : name)} ms={ms}
        detail={String(input.path ?? input.url ?? input.element ?? (Object.values(input).find((v) => typeof v === 'string') as string | undefined) ?? (mcp ? mcp[1] : ''))} />
      <ToolContent>
        <ToolInput input={input} />
        {o.images.map((im, i) => <Shot key={i} img={im} />)}
        <ToolOutput output={failed ? undefined : o.text} errorText={failed ? o.text : undefined} />
      </ToolContent>
    </Tool>
  );
}
