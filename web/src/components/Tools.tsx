import { Bot, ChevronRight, Globe, Search, Terminal, Wrench, Brain } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import { buttonGhost, Chip, Dialog, mdComponents } from './ui';

// ---- the activity timeline: a real sequence, so a line and nodes in the gutter carry information ----
export const Timeline = ({ children }: { children: ReactNode }) => (
  <ol className="relative my-1 grid grid-cols-[minmax(0,1fr)] gap-0.5 pl-6 before:absolute before:top-3 before:bottom-3 before:left-2 before:w-px before:bg-line">{children}</ol>
);

type Node = 'running' | 'done' | 'failed' | 'agent';
const NODE: Record<Node, string> = {
  running: 'size-[9px] border-2 border-hefyn bg-paper', done: 'size-[9px] bg-field', failed: 'size-[9px] bg-alarm', agent: 'size-[11px] bg-seal ring-4 ring-seal/20',
};

function Step({ node, head, children, defaultOpen = false, lane = false }: { node: Node; head: ReactNode; children?: ReactNode; defaultOpen?: boolean; lane?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <li className="relative">
      <span aria-hidden className={`absolute top-[17px] -left-5 -translate-y-1/2 rounded-full ${NODE[node]} ${node === 'agent' ? '-ml-px' : ''}`} />
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded-[10px] px-2 py-2 text-left text-sm hover:bg-ink/5">
        {head}<ChevronRight size={14} aria-hidden className={`shrink-0 text-soft transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && <div id={id} className={`mt-1 mb-3 grid grid-cols-[minmax(0,1fr)] gap-3 ${lane ? 'ml-2 border-l-2 border-seal/60 pl-4' : 'pl-2'}`}>{children}</div>}
    </li>
  );
}

// ---- output handling: a string, or { content: [{type:'text'|'image'}], details: { exitCode } } ----
interface Img { src?: string }
function normalize(out: unknown) {
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
      {long && <button type="button" aria-expanded={all} className="mt-1 text-xs text-hefyn hover:underline" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${lines.length} lines`}</button>}
    </div>
  );
}

function Shot({ img }: { img: Img }) {
  const [big, setBig] = useState(false);
  if (!img.src) return <p className="text-sm text-soft">The image is not kept in the history.</p>;
  return (
    <>
      <button type="button" onClick={() => setBig(true)} aria-label="Enlarge screenshot" className="block max-w-md cursor-zoom-in overflow-hidden rounded-[10px] ring-1 ring-line"><img src={img.src} alt="Screenshot from the tool" className="block max-h-64 w-full object-cover object-top" /></button>
      {big && <Dialog title="Screenshot" xl onClose={() => setBig(false)}><img src={img.src} alt="Screenshot from the tool, enlarged" className="w-full rounded-[10px] ring-1 ring-line" /><div className="flex justify-end"><button className={buttonGhost} onClick={() => setBig(false)}>Close</button></div></Dialog>}
    </>
  );
}

const MCP_NAME = /^mcp__(.+?)_[0-9a-f]{4}__(.+)$/;
const Label = ({ children }: { children: ReactNode }) => <div className="mb-1 text-xs font-medium text-soft">{children}</div>;
const Ms = ({ ms }: { ms?: string }) => (ms ? <span className="tnum shrink-0 text-xs text-soft">{ms}</span> : null);
const Mono = ({ children }: { children: ReactNode }) => <span className="min-w-0 grow truncate font-mono text-[13px] text-soft">{children}</span>;

export function ThinkingStep({ text }: { text: string }) {
  return <Step node="done" head={<><Brain size={14} aria-hidden className="shrink-0 text-soft" /><span className="grow text-soft">Thinking</span></>}><pre className="text-sm break-words whitespace-pre-wrap text-soft">{text}</pre></Step>;
}

export default function ToolStep({ name, input, state, output, errorText, ms }: { name: string; input: Record<string, any>; state: string; output?: unknown; errorText?: string; ms?: string }) {
  const failed = state === 'output-error';
  const done = state === 'output-available';
  const node: Node = failed ? 'failed' : done ? 'done' : 'running';
  const o = normalize(failed ? errorText : output);

  if (name === 'task') {
    return (
      <Step node="agent" lane defaultOpen={!done && !failed} head={<>
        <Bot size={15} aria-hidden className="shrink-0 text-seal" /><Chip tone="seal">{String(input.agent ?? 'agent')}</Chip>
        <span className="min-w-0 grow truncate text-soft">{input.description ?? input.prompt}</span><Ms ms={ms} />
        {!done && !failed && <span className="text-xs text-hefyn">working</span>}{failed && <span className="text-xs text-alarm-ink">failed</span>}
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
        <Terminal size={14} aria-hidden className="shrink-0 text-soft" /><span className="font-medium">Run</span><Mono>{String(input.command ?? '')}</Mono>
        {code !== undefined && <span className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${code === 0 ? 'bg-ok/15 text-ok-ink' : 'bg-alarm/15 text-alarm-ink'}`}>exit {code}</span>}<Ms ms={ms} />
      </>}>
        <div className="grid gap-1.5 rounded-[10px] bg-[#0d1120] p-3.5 text-[#e6e9f5] ring-1 ring-line">
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
        <Search size={14} aria-hidden className="shrink-0 text-soft" /><span className="font-medium">{name === 'grep' ? 'Search' : 'Find files'}</span>
        <Mono>{String(input.pattern ?? '')}{input.path ? ` in ${input.path}` : ''}</Mono>{done && <span className="tnum shrink-0 text-xs text-soft">{lines.length} {lines.length === 1 ? 'match' : 'matches'}</span>}
      </>}>
        {lines.length ? <Folded text={lines.join('\n')} className="rounded-[10px] bg-ink/[0.06] p-3" max={15} /> : <p className="text-sm text-soft">No matches.</p>}
      </Step>
    );
  }

  const mcp = MCP_NAME.exec(name);
  const browser = /playwright|browser/i.test(name);
  const verb = name === 'read' ? 'Read' : name === 'write' ? 'Write' : name === 'edit' ? 'Edit' : name === 'list' ? 'List' : null;
  return (
    <Step node={node} defaultOpen={o.images.length > 0} head={<>
      {browser ? <Globe size={14} aria-hidden className="shrink-0 text-soft" /> : <Wrench size={14} aria-hidden className="shrink-0 text-soft" />}
      <span className="font-medium">{verb ?? (mcp ? mcp[2].replace(/_/g, ' ') : name)}</span>
      <Mono>{input.path ?? input.url ?? input.element ?? (mcp ? mcp[1] : '')}</Mono><Ms ms={ms} />
    </>}>
      <div><Label>Input</Label><Folded text={JSON.stringify(input, null, 2)} className="rounded-[10px] bg-ink/[0.06] p-3" /></div>
      {o.images.map((im, i) => <Shot key={i} img={im} />)}
      {o.text && <div><Label>{failed ? 'Error' : 'Output'}</Label><Folded text={o.text} className="rounded-[10px] bg-ink/[0.06] p-3" /></div>}
    </Step>
  );
}
