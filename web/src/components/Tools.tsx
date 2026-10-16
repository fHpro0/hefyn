import { Bot, ChevronRight, Globe, Search, Terminal, Wrench, Brain } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import { buttonGhost, Dialog, mdComponents } from './ui';

// ---- steps: compact one-line rows with a status dot; delegated agents indent with a seal-coloured rail ----
export const Timeline = ({ children }: { children: ReactNode }) => <ol className="my-1 grid grid-cols-[minmax(0,1fr)]">{children}</ol>;

type Node = 'running' | 'done' | 'failed' | 'agent';
const DOT: Record<Node, string> = {
  running: 'size-2 border border-foreground', done: 'size-2 bg-success', failed: 'size-2 bg-danger', agent: 'size-2 bg-seal',
};

function Step({ node, head, children, defaultOpen = false, lane = false }: { node: Node; head: ReactNode; children?: ReactNode; defaultOpen?: boolean; lane?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <li>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="flex h-8 w-full items-center gap-2 rounded-lg px-1.5 text-left text-[13px] hover:bg-foreground/5">
        <span aria-hidden className={`shrink-0 rounded-full ${DOT[node]}`} />{head}<ChevronRight size={14} strokeWidth={1.75} aria-hidden className={`shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && <div id={id} className={`mt-1 mb-2 grid grid-cols-[minmax(0,1fr)] gap-3 ${lane ? 'ml-[7px] border-l-2 border-seal pl-4' : 'pl-5'}`}>{children}</div>}
    </li>
  );
}

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

function Folded({ text, className, max = 12 }: { text: string; className: string; max?: number }) {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > max;
  return (
    <div>
      <pre className={`max-h-96 overflow-auto font-mono text-[13px] leading-5 break-words whitespace-pre-wrap ${className}`}>{long && !all ? lines.slice(0, max).join('\n') : text}</pre>
      {long && <button type="button" aria-expanded={all} className="mt-1 text-xs text-foreground hover:underline" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${lines.length} lines`}</button>}
    </div>
  );
}

function Shot({ img }: { img: Img }) {
  const [big, setBig] = useState(false);
  if (!img.src) return <p className="text-sm text-muted">The image is not kept in the history.</p>;
  return (
    <>
      <button type="button" onClick={() => setBig(true)} aria-label="Enlarge screenshot" className="block max-w-md cursor-zoom-in overflow-hidden rounded-lg ring-1 ring-border"><img src={img.src} alt="Screenshot from the tool" className="block max-h-64 w-full object-cover object-top" /></button>
      {big && <Dialog title="Screenshot" xl onClose={() => setBig(false)}><img src={img.src} alt="Screenshot from the tool, enlarged" className="w-full rounded-lg ring-1 ring-border" /><div className="flex justify-end"><button className={buttonGhost} onClick={() => setBig(false)}>Close</button></div></Dialog>}
    </>
  );
}

const MCP_NAME = /^mcp__(.+?)_[0-9a-f]{4}__(.+)$/;
const Label = ({ children }: { children: ReactNode }) => <div className="mb-1 text-xs font-medium text-muted">{children}</div>;
const Ms = ({ ms }: { ms?: string }) => (ms ? <span className="tnum shrink-0 text-xs text-muted">{ms}</span> : null);
const Mono = ({ children }: { children: ReactNode }) => <span className="min-w-0 grow truncate font-mono text-[13px] text-muted">{children}</span>;

export function ThinkingStep({ text }: { text: string }) {
  return <Step node="done" head={<><Brain size={14} aria-hidden className="shrink-0 text-muted" /><span className="grow text-muted">Thinking</span></>}><pre className="text-sm break-words whitespace-pre-wrap text-muted">{text}</pre></Step>;
}

export default function ToolStep({ name, input, state, output, errorText, ms }: { name: string; input: Record<string, any>; state: string; output?: unknown; errorText?: string; ms?: string }) {
  const failed = state === 'output-error';
  const done = state === 'output-available';
  const node: Node = failed ? 'failed' : done ? 'done' : 'running';
  const o = normalize(failed ? errorText : output);

  if (name === 'task') {
    return (
      <Step node="agent" lane defaultOpen={!done && !failed} head={<>
        <Bot size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-seal" /><span className="rounded-md bg-seal/12 px-1.5 text-xs font-medium text-seal">{String(input.agent ?? 'agent')}</span>
        <span className="min-w-0 grow truncate text-muted">{input.description ?? input.prompt}</span><Ms ms={ms} />
        {!done && !failed && <span className="text-xs text-muted">working</span>}{failed && <span className="text-xs text-danger-ink">failed</span>}
      </>}>
        <div><Label>Task</Label><p className="text-sm whitespace-pre-wrap">{String(input.prompt ?? '')}</p></div>
        {o.text && <div><Label>{failed ? 'Error' : 'Result'}</Label><div className="text-sm"><Markdown components={mdComponents}>{o.text}</Markdown></div></div>}
      </Step>
    );
  }

  if (name === 'bash') {
    const code = o.exit ?? (done ? 0 : undefined);
    const bad = failed || (code !== undefined && code !== 0);
    return (
      <Step node={bad ? 'failed' : node} defaultOpen head={<>
        <Terminal size={14} aria-hidden className="shrink-0 text-muted" /><span className="font-medium">Run</span><Mono>{String(input.command ?? '')}</Mono>
        {code !== undefined && <span className={`shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap ${code === 0 ? 'bg-success/15 text-success-ink' : 'bg-danger/15 text-danger-ink'}`}>exit {code}</span>}<Ms ms={ms} />
      </>}>
        <div className="grid gap-1.5 rounded-lg bg-[#09090b] p-3 text-[#fafafa] ring-1 ring-border">
          <div className="font-mono text-[13px] break-words whitespace-pre-wrap"><span className="text-[#3dd68c]">$</span> {String(input.command ?? '')}</div>
          {state === 'input-available' && <div className="font-mono text-[13px] text-[#9aa2bf]">running…</div>}
          {o.stdout !== undefined || o.stderr !== undefined ? <>{o.stdout && <Folded text={o.stdout} className="text-[#e6e9f5]" />}{o.stderr && <Folded text={o.stderr} className="text-[#ff6369]" />}</>
            : o.text && <Folded text={o.text} className={bad ? 'text-[#ff8f93]' : 'text-[#e6e9f5]'} />}
        </div>
      </Step>
    );
  }

  if (name === 'grep' || name === 'glob') {
    const lines = o.text.split('\n').filter(Boolean);
    return (
      <Step node={node} head={<>
        <Search size={14} aria-hidden className="shrink-0 text-muted" /><span className="font-medium">{name === 'grep' ? 'Search' : 'Find files'}</span>
        <Mono>{String(input.pattern ?? '')}{input.path ? ` in ${input.path}` : ''}</Mono>{done && <span className="tnum shrink-0 text-xs text-muted">{lines.length} {lines.length === 1 ? 'match' : 'matches'}</span>}
      </>}>
        {lines.length ? <Folded text={lines.join('\n')} className="rounded-lg bg-foreground/[0.06] p-3" max={15} /> : <p className="text-sm text-muted">No matches.</p>}
      </Step>
    );
  }

  const mcp = MCP_NAME.exec(name);
  const browser = /playwright|browser/i.test(name);
  const verb = name === 'read' ? 'Read' : name === 'write' ? 'Write' : name === 'edit' ? 'Edit' : name === 'list' ? 'List' : null;
  return (
    <Step node={node} defaultOpen={o.images.length > 0} head={<>
      {browser ? <Globe size={14} aria-hidden className="shrink-0 text-muted" /> : <Wrench size={14} aria-hidden className="shrink-0 text-muted" />}
      <span className="font-medium">{verb ?? (mcp ? mcp[2].replace(/_/g, ' ') : name)}</span>
      <Mono>{input.path ?? input.url ?? input.element ?? (mcp ? mcp[1] : '')}</Mono><Ms ms={ms} />
    </>}>
      <div><Label>Input</Label><Folded text={JSON.stringify(input, null, 2)} className="rounded-lg bg-foreground/[0.06] p-3" /></div>
      {o.images.map((im, i) => <Shot key={i} img={im} />)}
      {o.text && <div><Label>{failed ? 'Error' : 'Output'}</Label><Folded text={o.text} className="rounded-lg bg-foreground/[0.06] p-3" /></div>}
    </Step>
  );
}
