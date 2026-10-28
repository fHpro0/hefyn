import '@xyflow/react/dist/style.css';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import { PanelLeft, PanelRight, TriangleAlert, Wand2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { getTheme } from '../theme';
import { Config } from './Config';
import { addAfter, addNode, align, canConnect, canTest, connect, copyNodes, disconnectNode, distribute, duplicateNodes, GROUPS, insertOnEdge, layout, META, metaOf, moveNode, parseClip, pasteClip, portsOf, removeEdge, removeNode, setConfig, setLabel, summary, upstream, type Clip, type Flow, type FlowError, type FlowNode } from './flow';
import { CanvasMenu, iconOf, type MenuActions, type MenuTarget } from './Menu';
import type { Options } from './parts';
import { TestPane, type TestState } from './TestPane';

type StepData = { fn: FlowNode; error?: string; renaming?: boolean; onRename: (label?: string) => void };
type Step = Node<StepData, 'step'>;
const dot = { width: 10, height: 10, background: 'var(--foreground)', border: '2px solid var(--background)' };

function StepNode({ data, selected }: NodeProps<Step>) {
  const n = data.fn, m = metaOf(n.type), Icon = iconOf(n.type), ports = portsOf(n), many = ports.length > 1;
  return (
    <div className={cn('w-full rounded-lg border bg-surface text-sm shadow-sm', selected ? 'border-foreground ring-1 ring-foreground' : data.error ? 'border-danger' : 'border-border')}>
      {n.type !== 'trigger.chat' && <Handle type="target" position={Position.Left} style={dot} />}
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <Icon size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted-foreground" />
        {data.renaming
          ? <input autoFocus aria-label="Step name" maxLength={60} defaultValue={n.label ?? ''} placeholder={m.label} onFocus={(e) => e.currentTarget.select()}
              className="nodrag nopan nowheel min-w-0 grow rounded border border-input bg-background px-1 py-0 font-medium outline-none focus:ring-1 focus:ring-ring"
              onKeyDown={(e) => { e.stopPropagation(); const t = e.currentTarget; if (e.key === 'Enter') { t.dataset.done = '1'; data.onRename(t.value.trim()); } else if (e.key === 'Escape') { t.dataset.done = '1'; data.onRename(); } }}
              onBlur={(e) => { if (!e.currentTarget.dataset.done) data.onRename(e.currentTarget.value.trim()); }} />
          : <span className="min-w-0 grow truncate font-medium">{n.label || m.label}</span>}
        {data.error && <TriangleAlert size={14} aria-label="Needs attention" className="shrink-0 text-danger" />}
      </div>
      <p className="truncate px-3 pt-0.5 pb-2.5 text-[12px] text-muted-foreground">{summary(n) || m.hint}</p>
      {many && ports.map((p) => (
        <div key={p.id} className="relative border-t border-border px-4 py-1.5 text-right"><span className="text-[12px] font-medium text-foreground">{p.label}</span><Handle type="source" position={Position.Right} id={p.id} style={dot} /></div>
      ))}
      {!many && ports.length === 1 && <Handle type="source" position={Position.Right} style={dot} />}
    </div>
  );
}
const nodeTypes = { step: StepNode };
// Fit the flow but never below a readable zoom: a wide flow is cropped (pan to see it, the minimap shows the rest) rather than shrunk to 8 px text.
const MIN_ZOOM = 0.6;
const NODE_W = 288; // px; flow.ts LAYER_GAP (380) leaves room for it
const clampW = (w: number) => Math.min(720, Math.max(280, w));
const stored = (k: string) => localStorage.getItem(`hefyn-assistant-${k}`) !== '0';
const useFlag = (k: string) => {
  const [on, set] = useState(() => stored(k));
  return [on, (v: boolean) => { localStorage.setItem(`hefyn-assistant-${k}`, v ? '1' : '0'); set(v); }] as const;
};

interface Props {
  flow: Flow; options: Options; errors: FlowError[]; readOnly: boolean;
  /** Replace the flow as one undo step; `key` lets quick edits of one field share a step. */
  edit: (f: Flow, key?: string) => void;
  /** Replace the flow without a new undo step (while dragging). */
  drag: (f: Flow) => void; checkpoint: () => void;
}

export default function Canvas(p: Props) {
  return <ReactFlowProvider><Inner {...p} /></ReactFlowProvider>;
}

function Inner({ flow, options, errors, readOnly, edit, drag, checkpoint }: Props) {
  const rf = useReactFlow();
  const box = useRef<HTMLDivElement>(null);
  const dark = document.documentElement.classList.contains('dark');
  const [sel, setSel] = useState<string[]>([]);
  const [selEdges, setSelEdges] = useState<string[]>([]);
  const nodeErr = useMemo(() => { const m = new Map<string, string>(); for (const e of errors) if (e.node && !m.has(e.node)) m.set(e.node, e.message); return m; }, [errors]);
  const edgeErr = useMemo(() => new Set(errors.map((e) => e.edge).filter(Boolean) as string[]), [errors]);

  const [width, setWidth] = useState(() => clampW(Number(localStorage.getItem('hefyn-assistant-panel-width')) || 360));
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [renaming, setRenaming] = useState<string>();
  const [tests, setTests] = useState<Record<string, TestState>>({}); // sample inputs and last results: this editing session only, never saved
  const clip = useRef<Clip | null>(null);

  const nodes: Step[] = useMemo(() => flow.nodes.map((n) => ({
    // the width is xyflow's (px), the card fills it: a CSS width (w-72 = 18rem) shrinks with the app's text size while xyflow places the handles at its own width
    id: n.id, type: 'step', position: n.position, width: NODE_W, initialHeight: 76,
    data: { fn: n, error: nodeErr.get(n.id), renaming: renaming === n.id, onRename: (l?: string) => { setRenaming(undefined); if (l !== undefined && l !== (n.label ?? '')) edit(setLabel(flow, n.id, l)); } }, selected: sel.includes(n.id),
    ariaLabel: `${metaOf(n.type).label}: ${n.label || metaOf(n.type).label}${nodeErr.has(n.id) ? ', needs attention' : ''}`,
  })), [flow, sel, nodeErr, renaming]);
  const edges: Edge[] = useMemo(() => flow.edges.map((e) => ({
    id: e.id, source: e.from, target: e.to, sourceHandle: e.port ?? null, selected: selEdges.includes(e.id), markerEnd: { type: MarkerType.ArrowClosed },
    style: edgeErr.has(e.id) ? { stroke: 'var(--danger)', strokeWidth: 2 } : undefined,
  })), [flow.edges, selEdges, edgeErr]);

  const onNodesChange = (changes: NodeChange<Step>[]) => {
    let next = flow, moved = false;
    for (const c of changes) {
      if (c.type === 'position' && c.position) { next = moveNode(next, c.id, c.position.x, c.position.y); moved = true; }
      else if (c.type === 'select') setSel((s) => (c.selected ? [...s.filter((x) => x !== c.id), c.id] : s.filter((x) => x !== c.id)));
    }
    if (moved && !readOnly) drag(next);
  };
  const add = (type: string, at?: { x: number; y: number }) => {
    if (readOnly) return;
    let pos = at;
    if (!pos && box.current) { const r = box.current.getBoundingClientRect(), o = (flow.nodes.length % 5) * 24; pos = rf.screenToFlowPosition({ x: r.left + r.width / 2 + o, y: r.top + r.height / 2 + o }); pos.x -= 120; }
    const { flow: next, id } = addNode(flow, type, pos);
    if (!id) return;
    edit(next); setSel([id]); setSelEdges([]);
  };
  const focus = (id: string) => { setSel([id]); setSelEdges([]); rf.fitView({ nodes: [{ id }], duration: 300, maxZoom: 1 }); };
  const node = sel.length === 1 ? flow.nodes.find((n) => n.id === sel[0]) : undefined;
  const del = (nodes: { id: string }[], edges: { id: string }[]) => edit(edges.reduce((f, e) => removeEdge(f, e.id), nodes.reduce((f, n) => removeNode(f, n.id), flow)));
  const hasTrigger = flow.nodes.some((n) => n.type === 'trigger.chat');
  // Show the whole flow when it fits at 60% or more; otherwise stay at 60% with the trigger at the left edge, so text stays readable.
  const fit = (duration = 0) => {
    const r = box.current?.getBoundingClientRect(), all = rf.getNodes();
    if (!r || !all.length) return;
    const b = rf.getNodesBounds(all);
    if (Math.min((r.width - 80) / b.width, (r.height - 80) / b.height) >= MIN_ZOOM) { rf.fitView({ minZoom: MIN_ZOOM, maxZoom: 1, padding: 0.1, duration }); return; }
    const t = all.find((n) => n.id === flow.nodes.find((x) => x.type === 'trigger.chat')?.id) ?? all[0]!;
    rf.setViewport({ zoom: MIN_ZOOM, x: 40 - t.position.x * MIN_ZOOM, y: r.height / 2 - (t.position.y + 40) * MIN_ZOOM }, { duration });
  };
  const auto = () => { edit(layout(flow)); requestAnimationFrame(() => requestAnimationFrame(() => fit(300))); };
  const [palette, setPalette] = useFlag('palette'), [panel, setPanel] = useFlag('panel');
  const showPanel = panel && (!!node || errors.length > 0);

  // ---- right-click menus and shortcuts: every change goes through edit(), so undo covers it ----
  const pick = (ids: string[]) => { setSel(ids); setSelEdges([]); };
  const later = (f: () => void) => setTimeout(f, 80); // after the menu has given focus back
  const reveal = (part: string) => later(() => { const el = document.querySelector<HTMLElement>(`[data-part="${part}"]`); el?.scrollIntoView({ block: 'nearest' }); el?.querySelector<HTMLElement>('textarea, input, button')?.focus(); });
  const copy = () => {
    if (!sel.length) return;
    clip.current = copyNodes(flow, sel);
    navigator.clipboard?.writeText(JSON.stringify(clip.current)).catch(() => { /* in-app copy still works */ });
  };
  const paste = async (at?: { x: number; y: number }) => {
    if (readOnly) return;
    const sys = await navigator.clipboard?.readText().then(parseClip).catch(() => null);
    const c = sys ?? clip.current;
    if (!c) return;
    const r = pasteClip(flow, c, at);
    if (r.ids.length) { edit(r.flow); pick(r.ids); }
  };
  const duplicate = () => { if (readOnly || !sel.length) return; const r = duplicateNodes(flow, sel); if (r.ids.length) { edit(r.flow); pick(r.ids); } };
  const remove = () => { if (readOnly || !sel.length) return; del(flow.nodes.filter((n) => sel.includes(n.id)), []); pick([]); };
  const act: MenuActions = {
    add: (t, at) => add(t, { x: at.x - 120, y: at.y - 20 }),
    addAfter: (id, t, port) => { const r = addAfter(flow, id, t, port); if (r.id) { edit(r.flow); pick([r.id]); } },
    insertOnEdge: (id, t, at) => { const r = insertOnEdge(flow, id, t, { x: at.x - 144, y: at.y - 38 }); if (r.id) { edit(r.flow); pick([r.id]); } },
    paste, selectAll: () => pick(flow.nodes.map((n) => n.id)), tidy: auto, fit: () => fit(300),
    zoom: (d) => { d > 0 ? rf.zoomIn({ duration: 150 }) : rf.zoomOut({ duration: 150 }); },
    open: (id) => { pick([id]); setPanel(true); },
    rename: (id) => { pick([id]); later(() => setRenaming(id)); },
    test: (id) => { pick([id]); setPanel(true); reveal('test'); },
    helpers: (id) => { pick([id]); setPanel(true); reveal('helpers'); },
    duplicate, copy, cut: () => { copy(); remove(); }, remove,
    disconnect: (id) => edit(disconnectNode(flow, id)), removeEdge: (id) => edit(removeEdge(flow, id)),
    align: (e) => edit(align(flow, sel, e)), distribute: (a) => edit(distribute(flow, sel, a)),
  };
  const at = (e: { clientX: number; clientY: number }) => rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
  const openMenu = (e: { preventDefault: () => void; clientX: number; clientY: number }, t: MenuTarget extends infer T ? (T extends MenuTarget ? Omit<T, 'x' | 'y'> : never) : never) => { e.preventDefault(); (e as Partial<Event>).stopPropagation?.(); setMenu({ ...t, x: e.clientX, y: e.clientY } as MenuTarget); };
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return; // a text field keeps its own shortcuts
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey, k = e.key.toLowerCase();
    if (mod && k === 'c') { if (sel.length) { e.preventDefault(); copy(); } }
    else if (mod && k === 'x') { if (sel.length && !readOnly) { e.preventDefault(); copy(); remove(); } }
    else if (mod && k === 'v') { e.preventDefault(); paste(); }
    else if (mod && k === 'd') { e.preventDefault(); duplicate(); }
    else if (mod && k === 'a') { e.preventDefault(); act.selectAll(); }
    else if (e.key === 'F2' && sel.length === 1 && !readOnly) { e.preventDefault(); setRenaming(sel[0]); }
  };
  const testPane = (n: FlowNode) => canTest(n)
    ? (wide: boolean) => <TestPane flow={flow} node={n} wide={wide} state={tests[n.id] ?? {}} onState={(p) => setTests((s) => ({ ...s, [n.id]: { ...s[n.id], ...p } }))} />
    : undefined;

  return (
    <div className="flex min-h-0 grow">
      {palette && <nav aria-label="Add a step" className="hidden w-56 shrink-0 overflow-y-auto border-r border-border bg-surface p-3 md:block">
        {GROUPS.map((g) => (
          <section key={g} className="mb-4">
            <h2 className="mb-1 px-1 text-xs font-medium text-muted-foreground">{g}</h2>
            {Object.keys(META).filter((t) => metaOf(t).group === g && (!options.nodeTypes?.length || options.nodeTypes.some((n) => n.type === t))).map((t) => {
              const m = metaOf(t), Icon = iconOf(t), off = readOnly || (t === 'trigger.chat' && hasTrigger);
              return (
                <button key={t} type="button" disabled={off} draggable={!off} title={m.hint} onClick={() => add(t)}
                  onDragStart={(e) => { e.dataTransfer.setData('application/hefyn-step', t); e.dataTransfer.effectAllowed = 'move'; }}
                  className="mb-1 flex w-full items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-left hover:border-border hover:bg-muted disabled:opacity-50 disabled:hover:border-transparent disabled:hover:bg-transparent">
                  <Icon size={15} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0"><span className="block text-[13px] font-medium">{m.label}</span><span className="block text-xs leading-4 text-muted-foreground">{m.hint}</span></span>
                </button>
              );
            })}
          </section>
        ))}
      </nav>}
      <div ref={box} data-own-context-menu tabIndex={-1} onContextMenu={(e) => { if (!e.defaultPrevented && e.target === e.currentTarget) openMenu(e, { kind: 'pane', at: at(e) }); }} onKeyDown={onKey} className="relative min-w-0 grow outline-none" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
        onDrop={(e) => { const t = e.dataTransfer.getData('application/hefyn-step'); if (!t) return; e.preventDefault(); const q = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }); add(t, { x: q.x - 120, y: q.y - 20 }); }}>
        <div className="absolute inset-0"><ReactFlow<Step, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode={getTheme()} onInit={() => requestAnimationFrame(() => fit())} minZoom={0.2} maxZoom={1.5}
          aria-label="Flow canvas" deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']} nodesConnectable={!readOnly} nodesDraggable={!readOnly}
          onNodesChange={onNodesChange} onEdgesChange={(cs) => { for (const c of cs) if (c.type === 'select') setSelEdges((s) => (c.selected ? [...s, c.id] : s.filter((x) => x !== c.id))); }}
          onNodeDragStart={() => checkpoint()} onDelete={({ nodes, edges }) => del(nodes, edges)}
          isValidConnection={(c) => canConnect(flow, c.source, c.sourceHandle ?? undefined, c.target)}
          onConnect={(c) => edit(connect(flow, c.source, c.sourceHandle ?? undefined, c.target))}
          multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          onPaneContextMenu={(e) => openMenu(e, { kind: 'pane', at: at(e) })}
          onNodeContextMenu={(e, n) => {
            if (sel.length > 1 && sel.includes(n.id)) return openMenu(e, { kind: 'selection' });
            pick([n.id]); openMenu(e, { kind: 'node', id: n.id });
          }}
          onSelectionContextMenu={(e) => openMenu(e, { kind: 'selection' })}
          onEdgeContextMenu={(e, edge) => { setSel([]); setSelEdges([edge.id]); openMenu(e, { kind: 'edge', id: edge.id, at: at(e) }); }}
          onPaneClick={() => { setSel([]); setSelEdges([]); }} proOptions={{ hideAttribution: true }}>
          <Background gap={20} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable position="bottom-right" ariaLabel="Overview of the flow" style={{ width: 150, height: 96, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}
            nodeColor={() => (dark ? '#d4d4d8' : '#52525b')} nodeStrokeColor={() => (dark ? '#d4d4d8' : '#52525b')} nodeStrokeWidth={3} nodeBorderRadius={4} maskColor={dark ? 'rgba(9,9,11,0.35)' : 'rgba(244,244,245,0.35)'} />
        </ReactFlow></div>
        <div className="absolute top-3 left-3 z-10 flex gap-2">
          <Button variant="outline" size="sm" className="bg-background" aria-pressed={palette} onClick={() => setPalette(!palette)}><PanelLeft size={14} aria-hidden />Steps</Button>
          <Button variant="outline" size="sm" className="bg-background" disabled={readOnly || !flow.nodes.length} onClick={auto}><Wand2 size={14} aria-hidden />Tidy up</Button>
        </div>
        <Button variant="outline" size="sm" className="absolute top-3 right-3 z-10 bg-background" aria-pressed={panel} onClick={() => setPanel(!panel)}><PanelRight size={14} aria-hidden />Settings</Button>
      </div>
      {menu && <CanvasMenu key={`${menu.x},${menu.y}`} target={menu} flow={flow} selected={sel} options={options} readOnly={readOnly} canPaste={!!clip.current} onClose={() => setMenu(null)} a={act}
        testable={(id) => { const n = flow.nodes.find((x) => x.id === id); return !!n && canTest(n); }} />}
      {showPanel && <aside aria-label="Step settings" style={{ width }} className="relative shrink-0 overflow-x-hidden overflow-y-auto border-l border-border bg-surface">
        <div role="separator" aria-orientation="vertical" aria-label="Resize the settings panel" aria-valuenow={width} aria-valuemin={280} aria-valuemax={720} tabIndex={0} title="Drag to resize"
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-ring/40 focus-visible:bg-ring/40"
          onPointerDown={(e) => {
            e.preventDefault();
            const x0 = e.clientX, w0 = width;
            const move = (m: PointerEvent) => setWidth(clampW(w0 + x0 - m.clientX));
            const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); setWidth((w) => { localStorage.setItem('hefyn-assistant-panel-width', String(w)); return w; }); };
            addEventListener('pointermove', move); addEventListener('pointerup', up);
          }}
          onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const w = clampW(width + (e.key === 'ArrowLeft' ? 24 : -24)); setWidth(w); localStorage.setItem('hefyn-assistant-panel-width', String(w)); } }} />
        {errors.length > 0 && (
          <div role="alert" className="border-b border-border p-3">
            <h2 className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-danger-ink"><TriangleAlert size={14} aria-hidden />{errors.length === 1 ? 'One thing to fix' : `${errors.length} things to fix`}</h2>
            <ul className="grid gap-1">
              {errors.map((e, i) => {
                const target = e.node ?? flow.edges.find((x) => x.id === e.edge)?.from;
                return <li key={i}>{target
                  ? <button type="button" className="w-full rounded px-1.5 py-1 text-left text-[13px] hover:bg-muted" onClick={() => focus(target)}><span className="font-medium">{flow.nodes.find((n) => n.id === target)?.label || metaOf(flow.nodes.find((n) => n.id === target)?.type ?? '').label}: </span>{e.message}</button>
                  : <span className="block px-1.5 py-1 text-[13px]">{e.message}</span>}</li>;
              })}
            </ul>
          </div>
        )}
        {node
          ? <fieldset disabled={readOnly} className="min-w-0"><Config key={node.id} node={node} refs={upstream(flow, node.id)} options={options} test={testPane(node)}
              onConfig={(patch) => edit(setConfig(flow, node.id, patch), `${node.id}:${Object.keys(patch).join()}`)} onLabel={(l) => edit(setLabel(flow, node.id, l), `${node.id}:label`)}
              onDelete={() => { del([node], []); setSel([]); }} /></fieldset>
          : <p className="p-4 text-[13px] text-muted-foreground">{flow.nodes.length ? 'Select a step to set it up. Drag from the dot on a step’s right edge to the next step to connect them.' : 'Add a step from the list on the left to begin.'}</p>}
      </aside>}
    </div>
  );
}
