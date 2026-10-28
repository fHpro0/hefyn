import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AgentIcon, loadAgents } from '../AgentChoice';
import { collapse, groups, snippet, trace, type DiagramIn, type Group } from './diagram-model';
import type { Options } from './parts';

// How the Assistant works, as a flow: You -> the base agent -> the skills, MCP servers, helpers and files it brings. Boxes are HTML (theme tokens, wrapping), edges are an SVG layer measured from the boxes.
const LIMIT = 6;
const NARROW = 560;
// Dashes crawl along the edges; still under reduced motion.
const CSS = '@keyframes hf-flow{to{stroke-dashoffset:-16}}.hf-flow{stroke-dasharray:5 3;animation:hf-flow 1.2s linear infinite}@media (prefers-reduced-motion:reduce){.hf-flow{animation:none}}';

type Reg = (id: string) => (el: HTMLElement | null) => void;
type Hot = { hot: string | null; set: (id: string | null) => void; on: Set<string> | null };

interface Edge { id: string; to: string; verb: string }
interface Line { id: string; d: string; verb: string; lx: number; ly: number }

const box = 'rounded-lg border border-border bg-muted/40 px-3 py-2 text-[13px]';
const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function Lane({ g, reg, h, narrow, onOpen }: { g: Group; reg: Reg; h: Hot; narrow: boolean; onOpen?: (path: string) => void }) {
  const [all, setAll] = useState(false);
  const { shown, more } = collapse(g.items, LIMIT, all);
  const dim = (id: string) => (h.on && !h.on.has(id) ? 'opacity-40' : '');
  const hover = (id: string) => ({ onMouseEnter: () => h.set(id), onMouseLeave: () => h.set(null), onFocus: () => h.set(id), onBlur: () => h.set(null) });
  const open = (f?: string) => (f && onOpen ? () => onOpen(f) : undefined);
  const head = <>{g.title}{narrow && <span className="font-normal text-muted-foreground"> · {g.verb}</span>}</>;
  return (
    <div ref={reg(g.key)} className={`grid gap-1.5 transition-opacity ${box} ${narrow ? 'ml-6' : ''} ${dim(g.key)}`}>
      <h3 className="text-[13px] leading-5 font-medium">
        {g.file ? <button type="button" className={`text-left underline-offset-2 hover:underline ${focus}`} {...hover(g.key)} onClick={open(g.file)}>{head}</button> : head}
      </h3>
      <ul className="grid gap-1">
        {shown.map((x, i) => {
          const id = `${g.key}:${i}`;
          return (
            <li key={`${x.label}${i}`} className={`transition-opacity ${dim(id)}`}>
              <button type="button" className={`block w-full min-w-0 rounded text-left ${open(x.file) ? 'hover:underline' : 'cursor-default'} underline-offset-2 ${focus}`} {...hover(id)} onClick={open(x.file)}>
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 leading-5">
                  <span className="min-w-0 break-all">{x.label}</span>
                  {x.tag && <span className="rounded border border-border px-1 text-[11px] leading-4 text-muted-foreground">{x.tag}</span>}
                </span>
                {x.hint && <span className="line-clamp-1 block text-xs leading-4 text-muted-foreground">{x.hint}</span>}
              </button>
            </li>
          );
        })}
        {g.items.length > LIMIT && (
          <li><button type="button" className={`text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground ${focus}`} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${g.items.length} (${more} more)`}</button></li>
        )}
      </ul>
    </div>
  );
}

export function Diagram({ data, options, onOpen, title = 'How it works' }: { data: DiagramIn; options: Options; title?: string; /** open a file in the Files tab */ onOpen?: (path: string) => void }) {
  const [icons, setIcons] = useState<Record<string, string | undefined>>({});
  const [hot, set] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const wrap = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const mark = useId();
  useEffect(() => { void loadAgents().then((l) => setIcons(Object.fromEntries(l.map((a) => [a.id, a.icon])))); }, []);
  const agentName = (id: string) => options.agents.find((a) => a.id === id)?.name ?? id;
  const list = groups(data, { agent: agentName, skill: (id) => options.skills.find((s) => s.id === id)?.name ?? id, mcp: (id) => options.mcp?.find((m) => m.id === id)?.name ?? id, skillHint: (id) => options.skills.find((s) => s.id === id)?.description });
  const reg: Reg = (id) => (el) => { if (el) els.current.set(id, el); else els.current.delete(id); };
  const edges: Edge[] = [{ id: 'you', to: 'agent', verb: 'asks' }, ...list.map((g) => ({ id: 'agent', to: g.key, verb: g.verb }))];
  const sig = edges.map((e) => e.to).join();

  // Redraw whenever the container resizes (that includes wrapping and collapsing lanes) or the lanes change.
  useLayoutEffect(() => {
    const c = wrap.current;
    if (!c) return;
    const draw = () => {
      const n = c.clientWidth < NARROW;
      setNarrow(n);
      const cr = c.getBoundingClientRect();
      const r = (id: string) => { const b = els.current.get(id)?.getBoundingClientRect(); return b && { x: b.left - cr.left, y: b.top - cr.top, w: b.width, h: b.height }; };
      setLines(edges.flatMap((e) => {
        const a = r(e.id), b = r(e.to);
        if (!a || !b) return [];
        if (!n) {
          const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, m = (x1 + x2) / 2;
          return [{ id: e.to, d: `M${x1} ${y1}C${m} ${y1} ${m} ${y2} ${x2} ${y2}`, verb: e.verb, lx: m, ly: (y1 + y2) / 2 }];
        }
        // Stacked: straight down from You to the agent; down the agent's left edge, then right into each indented lane.
        if (e.id === 'you') { const x = a.x + a.w / 2, y1 = a.y + a.h, y2 = b.y; return [{ id: e.to, d: `M${x} ${y1}V${y2}`, verb: e.verb, lx: x + 6, ly: (y1 + y2) / 2 + 3 }]; }
        const x1 = a.x + 14, y1 = a.y + a.h, y2 = b.y + 14;
        return [{ id: e.to, d: `M${x1} ${y1}V${y2}H${b.x}`, verb: '', lx: 0, ly: 0 }];
      }));
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps -- edges derive from sig

  const on = hot ? trace(hot) : null;
  const dim = (id: string) => (on && !on.has(id) ? 'opacity-40' : '');
  const hover = (id: string) => ({ onMouseEnter: () => set(id), onMouseLeave: () => set(null), onFocus: () => set(id), onBlur: () => set(null) });
  const h: Hot = { hot, set, on };
  const open = (f: string) => (onOpen ? () => onOpen(f) : undefined);
  const snip = snippet(data.instructions);
  return (
    <section aria-label="How this Assistant works" className="grid gap-3 rounded-xl border border-border p-4">
      <style>{CSS}</style>
      <h2 className="text-[15px] leading-6 font-semibold">{title}</h2>
      <div ref={wrap} className="relative">
        <svg className="pointer-events-none absolute inset-0 size-full overflow-visible text-muted-foreground" aria-hidden="true">
          <defs><marker id={mark} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="context-stroke" /></marker></defs>
          {lines.map((l) => {
            const act = !on || on.has(l.id);
            return (
              <g key={l.id} className={`transition-opacity ${act ? '' : 'opacity-30'}`}>
                <path d={l.d} fill="none" strokeWidth={1.5} markerEnd={`url(#${mark})`} className={`hf-flow ${on && act ? 'stroke-foreground' : 'stroke-border'}`} />
                {/* wide: the label sits on the curve's midpoint, in the gap between the agent and the lanes, on a background patch (shortcut: width is estimated per character) */}
                {l.verb && !narrow && <rect x={l.lx - l.verb.length * 2.8 - 4} y={l.ly - 8} width={l.verb.length * 5.6 + 8} height={16} rx={3} className="fill-background" />}
                {l.verb && <text x={l.lx} y={l.ly} dominantBaseline={narrow ? undefined : 'middle'} textAnchor={narrow ? 'start' : 'middle'} className="fill-muted-foreground stroke-background text-[10px]" strokeWidth={3} paintOrder="stroke">{l.verb}</text>}
              </g>
            );
          })}
        </svg>
        <div className={`relative flex ${narrow ? 'flex-col gap-9' : 'items-center gap-24'}`}>
          <div ref={reg('you')} className={`w-fit self-center transition-opacity ${box} font-medium ${dim('you')}`}>You</div>
          <div ref={reg('agent')} className={`grid min-w-0 gap-2 transition-opacity ${box} ${narrow ? '' : 'w-56 shrink-0'} ${dim('agent')}`}>
            <button type="button" className={`flex min-w-0 items-center gap-2 rounded text-left font-medium ${onOpen ? 'hover:underline' : 'cursor-default'} underline-offset-2 ${focus}`} {...hover('agent')} onClick={open('assistant.json')}>
              <AgentIcon src={data.agent ? icons[data.agent] : undefined} size={16} />
              <span className="min-w-0 break-words">{data.agent ? agentName(data.agent) : 'No agent chosen yet'}</span>
              <span className="text-xs font-normal text-muted-foreground">base agent</span>
            </button>
            <button type="button" className={`rounded border border-border bg-background px-2 py-1.5 text-left transition-opacity ${onOpen ? 'hover:bg-muted' : 'cursor-default'} ${focus} ${dim('instructions')}`} {...hover('instructions')} onClick={open('instructions.md')}>
              <span className="block text-xs font-medium">instructions.md</span>
              <span className="line-clamp-3 block text-xs leading-4 text-muted-foreground">{snip || 'No instructions yet.'}</span>
            </button>
          </div>
          {list.length > 0 && <div className={`grid min-w-0 gap-3 ${narrow ? '' : 'flex-1'}`}>{list.map((g) => <Lane key={g.key} g={g} reg={reg} h={h} narrow={narrow} onOpen={onOpen} />)}</div>}
        </div>
      </div>
      {list.length === 0 && <p className="text-[13px] text-muted-foreground">No skills, servers, helpers or files yet. Ask the chat to add some.</p>}
      <p className="text-xs text-muted-foreground">own = in this Assistant's files · on hefyn = shared on this server</p>
    </section>
  );
}
