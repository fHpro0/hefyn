import { Info, TriangleAlert, XCircle } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { flatIssues, screenSchema, type Block, type Screen } from '../../../src/modules/screen-schema';
import { trpc } from '@/lib/trpc';
import { useQuery } from './api';
import Shell from './Shell';
import { Alert, AlertDescription } from '@/ui/alert';
import { Button, buttonVariants } from '@/ui/button';
import { Spinner } from '@/ui/spinner';
import { Table } from './data';
import { FieldInput, toArgs, type FieldValue } from './module-fields';
import { toast } from './toast';
import { Empty, Err, Page } from './ui';

// Declarative module screens (docs/MODULES.md). The screen JSON and every tool result are untrusted: all strings render as React text,
// links are https: or the module's own /m/<id>/ paths, nested values are read with an own-property getter.
const MAX_ROWS = 500;
const BAD = new Set(['__proto__', 'constructor', 'prototype']);

/** Own, non-prototype lookup along a dotted path; undefined when anything on the way is missing. */
export function pick(x: unknown, path?: string): unknown {
  for (const k of path ? path.split('.') : []) {
    if (BAD.has(k) || !x || typeof x !== 'object' || !Object.hasOwn(x, k)) return undefined;
    x = (x as Record<string, unknown>)[k];
  }
  return x;
}
/** Any value as display text: primitives stringified, objects as JSON. */
export function show(x: unknown): string {
  if (x === undefined || x === null) return '';
  if (typeof x === 'object') { try { return JSON.stringify(x).slice(0, 2000); } catch { return ''; } }
  return String(x).slice(0, 2000);
}
// Same rule as the server (screen-schema.ts): https, or a path that still resolves under /m/<id>/ and has no escapes.
const inside = (id: string, h: string) => { try { const r = new URL(h, 'http://x'); const own = `/m/${id}/`; return r.origin === 'http://x' && r.pathname.startsWith(own) && r.pathname.length > own.length; } catch { return false; } };
export const safeHref = (id: string, h: string) => (/^https:\/\/[^\s]+$/.test(h) ? 'external' : h.startsWith(`/m/${id}/`) && !/[%\s\\]/.test(h) && inside(id, h) ? 'own' : undefined);

const call = (id: string, tool: string, args?: object) => trpc.modules.callTool.mutate({ id, tool, args: args ?? {} }).then((r) => r.result);

function useTool(id: string, tool: string, args: object | undefined, rev: number) {
  const [s, setS] = useState<{ data?: unknown; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    setS((p) => ({ ...p, loading: true }));
    call(id, tool, args).then((data) => live && setS({ data, loading: false }), (e) => live && setS({ error: (e as Error).message, loading: false }));
    return () => { live = false; };
  }, [id, tool, JSON.stringify(args), rev]);
  return s;
}

const Loading = () => <Spinner className="text-muted-foreground" />;
const rowsOf = (x: unknown): unknown[] => (Array.isArray(x) ? x : (['rows', 'items'].map((k) => pick(x, k)).find(Array.isArray) as unknown[] | undefined) ?? []);
const primitives = (row: unknown) => Object.fromEntries(Object.entries(row && typeof row === 'object' ? row : {}).filter(([k, x]) => !BAD.has(k) && (typeof x === 'number' || typeof x === 'boolean' || (typeof x === 'string' && x.length <= 500))));

function Rows({ id, tool, args, rev, children }: { id: string; tool: string; args?: object; rev: number; children: (rows: unknown[]) => ReactNode }) {
  const s = useTool(id, tool, args, rev);
  if (s.loading && s.data === undefined) return <Loading />;
  if (s.error) return <Err>{s.error}</Err>;
  const rows = rowsOf(s.data);
  return <>{children(rows.slice(0, MAX_ROWS))}{rows.length > MAX_ROWS && <p className="mt-2 text-xs text-muted-foreground">Showing first {MAX_ROWS} of {rows.length} rows.</p>}</>;
}

function Run({ id, tool, label, args, variant = 'default', done }: { id: string; tool: string; label: string; args?: object; variant?: 'default' | 'outline'; done: () => void }) {
  const [busy, setBusy] = useState(false);
  return <Button variant={variant} disabled={busy} onClick={async () => {
    setBusy(true);
    try { toast(show(await call(id, tool, args)) || 'Done'); done(); } catch (x) { toast((x as Error).message, true); }
    setBusy(false);
  }}>{busy && <Spinner />}{label}</Button>;
}

function FormBlock({ id, b, done }: { id: string; b: Extract<Block, { type: 'form' }>; done: () => void }) {
  const [vals, setVals] = useState<Record<string, FieldValue>>(() => Object.fromEntries(b.fields.flatMap((f) => (f.default === undefined ? [] : [[f.key, f.default]]))));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <form className="grid max-w-md gap-3" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr('');
      try { toast(show(await call(id, b.submit.tool, toArgs(b.fields, vals))) || 'Done'); done(); } catch (x) { setErr((x as Error).message); }
      setBusy(false);
    }}>
      {b.fields.map((f) => <FieldInput key={f.key} f={f} value={vals[f.key]} onChange={(x) => setVals({ ...vals, [f.key]: x })} />)}
      <Err>{err}</Err>
      <Button type="submit" className="justify-self-start" disabled={busy}>{busy && <Spinner />}{b.submit.label}</Button>
    </form>
  );
}

const TONE = { info: [Info, 'default', ''], warning: [TriangleAlert, 'default', 'text-warning-ink'], danger: [XCircle, 'destructive', ''] } as const;

function BlockView({ id, b, rev, done }: { id: string; b: Block; rev: number; done: () => void }) {
  switch (b.type) {
    case 'text': return <p className="max-w-2xl text-sm leading-6 whitespace-pre-wrap">{b.text}</p>;
    case 'alert': { const [Icon, variant, cls] = TONE[b.tone]; return <Alert variant={variant} className={cls}><Icon aria-hidden /><AlertDescription className="whitespace-pre-wrap">{b.text}</AlertDescription></Alert>; }
    case 'stat': return <StatBlock id={id} b={b} rev={rev} />;
    case 'table': return (
      <Rows id={id} tool={b.tool} args={b.args} rev={rev}>{(rows) => rows.length === 0 ? <p className="text-sm text-muted-foreground">No rows.</p> : (
        <Table head={[...b.columns.map((c) => c.label), ...(b.rowAction ? [''] : [])]}>
          {rows.map((r, i) => <tr key={i}>
            {b.columns.map((c) => <td key={c.key} className="break-words">{show(pick(r, c.key))}</td>)}
            {b.rowAction && <td className="text-right"><Run id={id} tool={b.rowAction.tool} label={b.rowAction.label} args={primitives(r)} variant="outline" done={done} /></td>}
          </tr>)}
        </Table>)}</Rows>);
    case 'list': return (
      <Rows id={id} tool={b.tool} args={b.args} rev={rev}>{(rows) => rows.length === 0 ? <p className="text-sm text-muted-foreground">Nothing here.</p> : (
        <ul className="divide-y rounded-lg border">{rows.map((r, i) => <li key={i} className="px-3 py-2 text-sm"><div className="font-medium break-words">{show(pick(r, b.primary))}</div>{b.secondary && <div className="text-muted-foreground break-words">{show(pick(r, b.secondary))}</div>}</li>)}</ul>)}</Rows>);
    case 'form': return <FormBlock id={id} b={b} done={done} />;
    case 'button': {
      if (b.tool) return <div><Run id={id} tool={b.tool} label={b.label} done={done} /></div>;
      const kind = safeHref(id, b.href ?? '');
      if (!kind) return <span className="text-sm">{b.label}</span>;
      return <div><a href={b.href} className={buttonVariants({ variant: 'outline' })} {...(kind === 'external' ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{b.label}</a></div>;
    }
  }
}

function StatBlock({ id, b, rev }: { id: string; b: Extract<Block, { type: 'stat' }>; rev: number }) {
  const s = useTool(id, b.tool, b.args, rev);
  return (
    <div className="rounded-lg border px-4 py-3">
      <div className="text-xs text-muted-foreground">{b.label}</div>
      <div className="mt-1 text-2xl font-semibold break-words">{s.error ? <Err>{s.error}</Err> : s.loading && s.data === undefined ? <Loading /> : show(pick(s.data, b.path))}</div>
    </div>
  );
}

function Blocks({ id, screen }: { id: string; screen: unknown }) {
  const [rev, setRev] = useState(0);
  const r = screenSchema(id).safeParse(screen);
  if (!r.success) { const i = flatIssues(r.error)[0]!; return <Err>{`This screen is invalid and was not shown. ${i.path}: ${i.message}`}</Err>; }
  const s: Screen = r.data;
  return <div className="grid gap-5">{s.blocks.length === 0 && <Empty icon={<Info size={20} aria-hidden />}>This screen is empty.</Empty>}{s.blocks.map((b, i) => <BlockView key={i} id={id} b={b} rev={rev} done={() => setRev((x) => x + 1)} />)}</div>;
}

export default function ModuleScreen() {
  const [id = '', name = ''] = location.pathname.split('/').slice(2); // /m/<id>/<screen>
  const { data, error } = useQuery(() => trpc.modules.screen.query({ id, screen: name }) as Promise<{ title: string; hint?: string }>, [id, name]);
  return (
    <Shell title={data?.title}>{() => (
      <Page title={data?.title ?? ''} hint={data?.hint} wide>
        {error ? <Err>{error}</Err> : data ? <Blocks id={id} screen={data} /> : <Loading />}
      </Page>
    )}</Shell>
  );
}
