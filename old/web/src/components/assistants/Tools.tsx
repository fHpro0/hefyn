import { ChevronDown, ChevronRight, Play, Search } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';
import { Chip, Err, Field, Input, Select, Switch, Textarea, type Tone } from '../ui';
import type { Flow } from './flow';

// The Tools tab: what each agent step of an Assistant can use (assistants.tools), which of it is on (flow.tools.disabled, saved with the Assistant) and a way to try a tool
// (assistants.tryTool). The server's `enabled` is the saved state; what is shown follows the editor's unsaved choice.

export interface ToolItem { id: string; name: string; description: string; source: 'builtin' | 'connector' | 'skill' | 'assistant'; group: string; enabled: boolean; tryable: boolean; readOnly?: boolean; schema?: any }
export interface ToolGroup { name: string; source: ToolItem['source'] | 'agent'; items: ToolItem[]; note?: string }
export interface StepTools { node: string; label: string; agent: string | null; agentName: string; groups: ToolGroup[]; on: number; total: number }
interface Listing { steps: StepTools[]; disabled: string[] }
interface TryResult { ok: boolean; result?: unknown; truncated?: boolean; error?: string; ms: number }

const rpc = trpc as any;
const SOURCE: Record<string, [string, Tone]> = { builtin: ['hefyn', 'neutral'], connector: ['Connector', 'blue'], skill: ['Skill', 'seal'], assistant: ['Assistant', 'caution'] };
const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

/** The editor gives the compact "Tools: 12 on · Manage" link in a step's settings what it needs without passing props through the canvas. */
export interface ToolsContext { disabled: string[]; assistantId?: string; manage: () => void }
export const ToolsCtx = createContext<ToolsContext | null>(null);
const withoutTools = (f: Flow): Flow => { const { tools: _t, ...rest } = f; return rest as Flow; };

// A short-lived cache, so the links in many step settings and the tab itself do not each wait for the connectors.
const cache = new Map<string, { at: number; p: Promise<Listing> }>();
function listing(id: string | undefined, flow: Flow): Promise<Listing> {
  const key = `${id ?? ''}|${JSON.stringify(withoutTools(flow))}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p: Promise<Listing> = rpc.assistants.tools.query({ ...(id && { id }), flow: withoutTools(flow) });
  cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}
const countOn = (s: StepTools, off: Set<string>) => { const all = s.groups.flatMap((g) => g.items); return { on: all.filter((t) => !off.has(t.id)).length, total: all.length }; };

/** "Tools: 12 on · Manage" for one agent step; opens the Tools tab. */
export function ToolsLink({ node, flow }: { node: { id: string; type: string; config: Record<string, any> }; /** the whole flow, when it is the Simple one (its agent is offered Assistants as tools) */ flow?: Flow }) {
  const ctx = useContext(ToolsCtx);
  const [steps, setSteps] = useState<StepTools[]>();
  const key = JSON.stringify([node.config.agent ?? null, node.config.skills ?? []]); // only what decides the tools: not every keystroke of the instructions
  useEffect(() => {
    if (!ctx) return;
    let live = true;
    listing(ctx.assistantId, flow ?? { version: 1, nodes: [{ ...node, position: { x: 0, y: 0 } }], edges: [] } as Flow).then((l) => live && setSteps(l.steps), () => {});
    return () => { live = false; };
  }, [key, ctx?.assistantId]);
  if (!ctx) return null;
  const s = steps?.find((x) => x.node === node.id) ?? steps?.[0], c = s && countOn(s, new Set(ctx.disabled));
  return (
    <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground" data-part="tools-link">
      {c ? <span>Tools: {c.on} on{c.total > c.on ? ` · ${c.total - c.on} off` : ''}</span> : <span>Tools</span>}
      <span aria-hidden>·</span>
      <Button variant="link" size="sm" className="h-auto p-0 text-[13px]" onClick={ctx.manage}>Manage</Button>
    </p>
  );
}

// ---- schema as plain fields ----
interface FieldInfo { name: string; kind: 'text' | 'number' | 'integer' | 'yes/no' | 'choice' | 'json'; label: string; required: boolean; description?: string; options?: string[] }
const KINDS: Record<string, string> = { string: 'text', integer: 'whole number', number: 'number', boolean: 'yes or no', object: 'object', array: 'list' };
function labelOf(p: any): string {
  if (Array.isArray(p?.enum)) return `one of ${p.enum.join(', ')}`;
  if (Array.isArray(p?.type)) return p.type.map((t: string) => KINDS[t] ?? t).join(' or ');
  if (p?.type === 'array') return `list of ${KINDS[p.items?.type] ?? 'values'}`;
  if (p?.type) return KINDS[p.type] ?? String(p.type);
  const alt = p?.anyOf ?? p?.oneOf;
  return Array.isArray(alt) ? [...new Set(alt.map(labelOf))].join(' or ') : 'any value';
}
export function fieldsOf(schema: any): FieldInfo[] {
  const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object' ? schema.properties as Record<string, any> : {};
  const req = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);
  return Object.entries(props).map(([name, p]) => ({
    name, label: labelOf(p), required: req.has(name), description: typeof p?.description === 'string' ? p.description : undefined,
    kind: Array.isArray(p?.enum) && p.enum.every((o: unknown) => typeof o === 'string') ? 'choice' : p?.type === 'string' ? 'text' : p?.type === 'integer' ? 'integer' : p?.type === 'number' ? 'number' : p?.type === 'boolean' ? 'yes/no' : 'json',
    options: Array.isArray(p?.enum) ? p.enum.map(String) : undefined,
  }));
}

function Details({ item }: { item: ToolItem }) {
  const fields = fieldsOf(item.schema);
  return (
    <div className="grid gap-2 rounded-md bg-muted/50 p-3 text-[13px]">
      {item.description && <p>{item.description}</p>}
      {fields.length === 0 ? <p className="text-muted-foreground">It needs no input.</p> : (
        <dl className="grid gap-1.5">
          {fields.map((f) => (
            <div key={f.name} className="grid gap-0.5"><dt><code className="text-xs">{f.name}</code> <span className="text-muted-foreground">{f.label}{f.required ? ', required' : ', optional'}</span></dt>{f.description && <dd className="text-muted-foreground">{f.description}</dd>}</div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** A form made from the tool's input schema; "Use JSON instead" is the way for anything the form does not cover. */
function Try({ item, assistantId }: { item: ToolItem; assistantId?: string }) {
  const fields = useMemo(() => fieldsOf(item.schema), [item.id]);
  const [vals, setVals] = useState<Record<string, string | boolean>>({});
  const [json, setJson] = useState(fields.length ? '' : '{}');
  const [asJson, setAsJson] = useState(!fields.length);
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState('');
  const [res, setRes] = useState<TryResult>();

  const args = (): Record<string, unknown> => {
    if (asJson) { const v = JSON.parse(json || '{}'); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('The arguments must be a JSON object, like {"name": "value"}.'); return v; }
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = vals[f.name];
      if (f.kind === 'yes/no') { if (v !== undefined) out[f.name] = v === true; continue; }
      const s = typeof v === 'string' ? v.trim() : '';
      if (!s) { if (f.required) throw new Error(`Fill in "${f.name}".`); continue; }
      if (f.kind === 'number' || f.kind === 'integer') { const n = Number(s.replace(',', '.')); if (!Number.isFinite(n)) throw new Error(`"${f.name}" must be a number.`); out[f.name] = n; }
      else if (f.kind === 'json') { try { out[f.name] = JSON.parse(s); } catch { throw new Error(`"${f.name}" must be JSON, for example {"a": 1} or ["x"].`); } }
      else out[f.name] = typeof v === 'string' ? v : s;
    }
    return out;
  };
  const run = async () => {
    let a: Record<string, unknown>;
    try { a = args(); setBad(''); } catch (e) { setBad(e instanceof SyntaxError ? 'The JSON is not valid. Check the commas and quotes.' : (e as Error).message); return; }
    setBusy(true);
    try { setRes(await rpc.assistants.tryTool.mutate({ tool: item.id, args: a, ...(assistantId && { assistantId }) })); }
    catch (e) { setRes({ ok: false, error: (e as Error).message, ms: 0 }); }
    finally { setBusy(false); }
  };

  return (
    <section aria-label={`Try ${item.name}`} className="grid gap-3 rounded-md border border-border p-3">
      <p className="text-[13px] text-muted-foreground">Runs the tool now, as you, with the values below. {item.source === 'connector' && !item.readOnly ? 'It may change things in the connected service. ' : ''}No model is involved.</p>
      {!asJson && fields.map((f) => (
        <Field key={f.name} label={<>{f.name}{f.required && ' *'}{f.description && <span className="text-muted-foreground"> {f.description}</span>}</>}>
          {f.kind === 'yes/no' ? <Select value={vals[f.name] === undefined ? '' : String(vals[f.name])} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value === '' ? '' : e.target.value === 'true' })}><option value="">Not set</option><option value="true">Yes</option><option value="false">No</option></Select>
            : f.kind === 'choice' ? <Select value={String(vals[f.name] ?? '')} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })}><option value="">{f.required ? 'Choose one' : 'Not set'}</option>{f.options!.map((o) => <option key={o} value={o}>{o}</option>)}</Select>
            : f.kind === 'json' ? <Textarea rows={3} spellCheck={false} className="font-mono text-xs" value={String(vals[f.name] ?? '')} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} placeholder="JSON" />
            : <Input inputMode={f.kind === 'text' ? undefined : 'decimal'} value={String(vals[f.name] ?? '')} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} />}
        </Field>
      ))}
      {asJson && <Field label="Arguments (JSON)"><Textarea rows={5} spellCheck={false} className="font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} /></Field>}
      {bad && <p role="alert" className="text-[13px] text-danger-ink">{bad}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={run}>{busy ? <Spinner /> : <Play size={13} aria-hidden />}Try it</Button>
        {!!fields.length && <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => { if (!asJson) setJson(JSON.stringify((() => { try { return args(); } catch { return {}; } })(), null, 2)); setAsJson(!asJson); setBad(''); }}>{asJson ? 'Use the form' : 'Use JSON instead'}</Button>}
      </div>
      {res && (
        <div role="status" className="grid gap-2">
          <div className="flex items-center gap-2 text-[13px]"><Chip tone={res.ok ? 'ok' : 'alarm'}>{res.ok ? 'Worked' : 'Failed'}</Chip><span className="text-muted-foreground">{res.ms} ms</span></div>
          {res.error && <p className="text-[13px] text-danger-ink">{res.error}</p>}
          {res.ok && <pre className="max-h-72 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs whitespace-pre-wrap break-words">{pretty(res.result) || '(empty)'}</pre>}
          {res.truncated && <p className="text-xs text-muted-foreground">The answer was cut at 64 KB.</p>}
        </div>
      )}
    </section>
  );
}

function Row({ item, on, readOnly, onToggle, assistantId }: { item: ToolItem; on: boolean; readOnly: boolean; onToggle: (on: boolean) => void; assistantId?: string }) {
  const [open, setOpen] = useState<'' | 'details' | 'try'>('');
  const [src, tone] = SOURCE[item.source] ?? ['', 'neutral'];
  const toggle = (m: 'details' | 'try') => setOpen(open === m ? '' : m);
  return (
    <li className="grid gap-2 py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-1.5"><span className="text-[13px] font-medium">{item.name}</span><Chip tone={tone}>{src}</Chip>{item.readOnly && <Chip>Only reads</Chip>}</div>
          {item.description && <p className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">{item.description}</p>}
          <div className="mt-1 flex gap-1">
            {item.source !== 'skill' && item.source !== 'assistant' && <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-muted-foreground" aria-expanded={open === 'details'} onClick={() => toggle('details')}>{open === 'details' ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}Details</Button>}
            {item.tryable && <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-muted-foreground" aria-expanded={open === 'try'} onClick={() => toggle('try')}><Play size={11} aria-hidden />Try</Button>}
          </div>
        </div>
        <Switch label={`${on ? 'Turn off' : 'Turn on'} ${item.name}`} checked={on} disabled={readOnly} onChange={onToggle} />
      </div>
      {open === 'details' && <Details item={item} />}
      {open === 'try' && <Try item={item} assistantId={assistantId} />}
    </li>
  );
}

export default function Tools({ flow, assistantId, readOnly, onChange }: { flow: Flow; assistantId?: string; readOnly: boolean; onChange: (disabled: string[]) => void }) {
  const flowKey = JSON.stringify(withoutTools(flow));
  const [data, setData] = useState<Listing>();
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [step, setStep] = useState('');
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => listing(assistantId, flow).then((l) => { if (live) { setData(l); setError(''); } }, (e: Error) => live && setError(e.message)), 300);
    return () => { live = false; clearTimeout(t); };
  }, [flowKey, assistantId]);

  const off = new Set(flow.tools?.disabled ?? []);
  const set = (ids: string[], on: boolean) => {
    const next = new Set(off);
    for (const id of ids) on ? next.delete(id) : next.add(id);
    onChange([...next]);
  };
  if (error && !data) return <div className="p-6"><Err>{error}</Err></div>;
  if (!data) return <div className="flex items-center gap-2 p-6 text-muted-foreground"><Spinner />Looking up the tools…</div>;
  if (!data.steps.length) return <p className="p-6 text-[13px] text-muted-foreground">This Assistant has no agent step, so there are no tools to choose. Add an Agent step in the Flow view.</p>;

  const cur = data.steps.find((s) => s.node === step) ?? data.steps[0]!, needle = q.trim().toLowerCase();
  const { on, total } = countOn(cur, off);
  const shown = cur.groups.map((g) => ({ ...g, items: g.items.filter((i) => !needle || `${i.name} ${i.description} ${g.name}`.toLowerCase().includes(needle)) })).filter((g) => g.items.length || (!needle && g.note));

  return (
    <div className="mx-auto grid w-full max-w-3xl content-start gap-4 px-6 py-5">
      <div className="grid gap-1">
        <h2 className="text-[15px] font-semibold">Tools</h2>
        <p className="text-[13px] text-muted-foreground">What {data.steps.length > 1 ? 'an agent step' : 'the agent'} can use while it works. Everything is on until you turn it off. Changes apply to new chats once you save.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {data.steps.length > 1 && <Field label="Step" className="w-56"><Select value={cur.node} onChange={(e) => setStep(e.target.value)}>{data.steps.map((s) => <option key={s.node} value={s.node}>{s.label} ({s.agentName})</option>)}</Select></Field>}
        <div className="relative min-w-48 grow"><Search size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" /><Input className="pl-8" aria-label="Search tools" placeholder="Search tools" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <span className="pb-2 text-[13px] text-muted-foreground" role="status">{on} of {total} on</span>
      </div>
      {error && <Err>{error}</Err>}
      {!shown.length && <p className="text-[13px] text-muted-foreground">No tool matches "{q}".</p>}
      {shown.map((g) => (
        <section key={g.name} aria-label={g.name} className="grid gap-1">
          <div className="flex items-center justify-between gap-2 border-b border-border pb-1">
            <h3 className="text-[13px] font-medium">{g.name}</h3>
            {!readOnly && g.items.length > 1 && <span className="flex gap-1"><Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-muted-foreground" onClick={() => set(g.items.map((i) => i.id), true)}>All on</Button><Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-muted-foreground" onClick={() => set(g.items.map((i) => i.id), false)}>All off</Button></span>}
          </div>
          {g.note && <p className="py-1 text-[13px] text-muted-foreground">{g.note}</p>}
          <ul className="divide-y divide-border">
            {g.items.map((i) => <Row key={i.id} item={i} on={!off.has(i.id)} readOnly={readOnly} assistantId={assistantId} onToggle={(v) => set([i.id], v)} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}
