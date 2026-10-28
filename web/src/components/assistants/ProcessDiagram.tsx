import { useId, useLayoutEffect, useRef, useState } from 'react';
import { layoutProcess, type LaidEdge, type Process } from '../../../../src/assistants/process';

// The process as a vertical lane of stage cards. Steps to the next card are HTML arrows between the cards; loops and skips are arcs on the right (an SVG layer measured from the cards, like Diagram.tsx), each worded in its source card's footer.
const LANE = 10, BASE = 16;
const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

const tag = (by: string) => (by === 'agent' ? 'agent' : by === 'person' ? 'you decide' : by.startsWith('helper:') ? `helper: ${by.slice(7)}` : 'script');
/** The file a stage opens, if any. */
const fileOf = (by: string) => (by.startsWith('script:') ? `skills/${by.slice(7)}` : by.startsWith('helper:') ? 'helpers.json' : undefined);

interface Arc { i: number; d: string }

export function ProcessDiagram({ process, onOpen }: { process: Process; /** open a file in the Files tab */ onOpen?: (path: string) => void }) {
  const { stages, side, edges, loops } = layoutProcess(process);
  const pos = new Map(stages.map((s, i) => [s.id, i])), title = (id: string) => stages.find((s) => s.id === id)!.title;
  // a step to the next card is an arrow between the cards; only real loop-backs are arcs; every other edge is a line in its source card
  const step = (e: LaidEdge) => e.kind === 'forward' && pos.get(e.to)! === pos.get(e.from)! + 1 && (pos.get(e.from)! + 1 < side || pos.get(e.from)! >= side);
  const arcs = edges.map((e, i) => ({ e, i })).filter((x) => x.e.kind === 'back');
  // shortest loops first, each in the first lane free of overlapping loops: nested loops sit inside the ones around them
  const lane = new Map<number, number>(), span = (x: { e: LaidEdge }) => [pos.get(x.e.to)!, pos.get(x.e.from)!] as const;
  for (const x of [...arcs].sort((a, b) => span(a)[1] - span(a)[0] - (span(b)[1] - span(b)[0]))) {
    const [lo, hi] = span(x), taken = new Set(arcs.filter((y) => lane.has(y.i) && span(y)[0] <= hi && lo <= span(y)[1]).map((y) => lane.get(y.i)));
    let k = 0; while (taken.has(k)) k++;
    lane.set(x.i, k);
  }
  const gutter = BASE + LANE * (arcs.length ? Math.max(...lane.values()) + 1 : 0);
  const [hot, set] = useState<string | null>(null);
  const [lines, setLines] = useState<Arc[]>([]);
  const [brackets, setBrackets] = useState<{ y1: number; y2: number }[]>([]);
  const wrap = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const mark = useId();
  const reg = (id: string) => (el: HTMLElement | null) => { if (el) els.current.set(id, el); else els.current.delete(id); };
  const sig = JSON.stringify(process);

  // Redraw whenever the container resizes (wrapping changes the card heights).
  useLayoutEffect(() => {
    const c = wrap.current;
    if (!c) return;
    const draw = () => {
      const cr = c.getBoundingClientRect();
      const r = (id: string) => { const b = els.current.get(id)?.getBoundingClientRect(); return b && { top: b.top - cr.top, bottom: b.bottom - cr.top, right: b.right - cr.left, mid: (b.top + b.bottom) / 2 - cr.top }; };
      setLines(arcs.flatMap(({ e, i }) => {
        const a = r(`edge:${i}`), c1 = r(`stage:${e.from}`), t = r(`stage:${e.to}`);
        if (!a || !c1 || !t) return [];
        const x = c1.right + 8 + lane.get(i)! * LANE;
        return [{ i, d: `M${c1.right} ${a.mid}H${x}V${t.mid}H${t.right + 1}` }];
      }));
      setBrackets(loops.flatMap((l) => { const a = r(`stage:${stages[l.from]!.id}`), b = r(`stage:${stages[l.to]!.id}`); return a && b ? [{ y1: a.top, y2: b.bottom }] : []; }));
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps -- everything derives from the process

  const touches = (e: LaidEdge) => e.from === hot || e.to === hot;
  const edgeDim = (e: LaidEdge) => (hot && !touches(e) ? 'opacity-30' : '');
  const on = hot ? new Set([hot, ...edges.filter(touches).flatMap((e) => [e.from, e.to])]) : null;
  const hover = (id: string) => ({ onMouseEnter: () => set(id), onMouseLeave: () => set(null), onFocus: () => set(id), onBlur: () => set(null) });
  const label = (e: LaidEdge) => `${e.when ?? 'otherwise'}${e.max ? ` · max ${e.max} → ${title(e.then!)}` : ''}`;

  return (
    <section aria-label="How this Assistant's process runs" className="grid gap-3 rounded-xl border border-border p-4">
      <h2 className="text-[15px] leading-6 font-semibold">How it works</h2>
      <p className="text-[13px] text-muted-foreground">{process.title}</p>
      <div ref={wrap} className="relative pl-4" style={{ paddingRight: gutter }}>
        <svg className="pointer-events-none absolute inset-0 size-full overflow-visible text-muted-foreground" aria-hidden="true">
          <defs><marker id={mark} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="context-stroke" /></marker></defs>
          {brackets.map((b, k) => <path key={k} d={`M10 ${b.y1}H4V${b.y2}H10`} fill="none" strokeWidth={1.5} className="stroke-border" />)}
          {lines.map((l) => {
            const e = edges[l.i]!, act = !!hot && touches(e);
            return <path key={l.i} d={l.d} fill="none" strokeWidth={1.5} markerEnd={`url(#${mark})`} className={`transition-opacity ${act ? 'stroke-foreground' : 'stroke-border'} ${edgeDim(e)}`} />;
          })}
        </svg>
        <ol className="relative grid">
          {stages.map((s, i) => {
            const loop = loops.find((l) => l.from === i), file = fileOf(s.by), out = edges.map((e, k) => ({ e, k })).filter((x) => x.e.from === s.id);
            const head = <>{s.title}{file && <span className="sr-only"> (opens {file})</span>}</>;
            return (
              <li key={s.id} className="grid">
                {i === side && <h3 className="mt-2 mb-2 text-xs font-medium text-muted-foreground">When a loop runs out</h3>}
                <div ref={reg(`stage:${s.id}`)} className={`grid gap-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[13px] transition-opacity ${on && !on.has(s.id) ? 'opacity-40' : ''}`} {...hover(s.id)}>
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <h3 className="min-w-0 break-words text-[13px] leading-5 font-medium">
                      {file && onOpen ? <button type="button" className={`text-left underline-offset-2 hover:underline ${focus}`} onClick={() => onOpen(file)}>{head}</button> : head}
                    </h3>
                    <span className="rounded border border-border px-1 text-[11px] leading-4 text-muted-foreground">{tag(s.by)}</span>
                    {loop && <span className="rounded border border-border px-1 text-[11px] leading-4 text-muted-foreground">for each {loop.list}</span>}
                    {s.end && <span className="rounded border border-border px-1 text-[11px] leading-4 text-muted-foreground">end</span>}
                  </div>
                  {s.does && <p className="text-xs leading-4 text-muted-foreground">{s.does}</p>}
                  {out.filter((x) => !step(x.e)).map(({ e, k }) => (
                    <p key={k} ref={reg(`edge:${k}`)} className={`text-xs leading-4 text-muted-foreground transition-opacity ${edgeDim(e)}`}>{e.kind === 'back' ? '↩' : '→'} {e.when ?? 'otherwise'} → {e.kind === 'back' && 'back to '}{title(e.to)}{e.max && ` (up to ${e.max}×, then ${title(e.then!)})`}</p>
                  ))}
                </div>
                {i < stages.length - 1 && i + 1 !== side && (
                  <div className="flex min-h-7 flex-wrap items-center gap-x-4 gap-y-0.5 py-1 pl-4 text-[11px] leading-4 text-muted-foreground">
                    {out.filter((x) => step(x.e)).map(({ e, k }) => <span key={k} className={`transition-opacity ${edgeDim(e)}`}>↓ {e.when && label(e)}</span>)}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      <p className="text-xs text-muted-foreground">↓ next stage · ↩ goes back to an earlier stage (arc) · → goes to another stage</p>
    </section>
  );
}
