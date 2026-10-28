import { BarChart3 } from 'lucide-react';
import { useState } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import { trpc } from '@/lib/trpc';
import type { UsageRow } from '../../../src/server/usage.ts'; // type only
import { can, money, useQuery } from './api';
import Shell from './Shell';
import { Table } from './data';
import { Empty, Loading, Page, Reveal, Section, Select } from './ui';


export default function Usage() {
  return <Shell>{(me) => <Content all={can(me, 'usage.view_all')} />}</Shell>;
}

const n = (v: number) => v.toLocaleString('en');
const day = (k: string) => new Date(`${k}T00:00:00`).toLocaleDateString('en', { month: 'short', day: 'numeric' });

function Content({ all }: { all: boolean }) {
  const [scope, setScope] = useState<'me' | 'all'>(all ? 'all' : 'me');
  const { data } = useQuery(() => trpc.usage[scope].query(), [scope]);
  const sum = (k: 'calls' | 'input' | 'output' | 'cost') => data?.perModel.reduce((a, r) => a + r[k], 0) ?? 0;
  // Always 30 slots ending today (UTC, matching the server's day keys); days without usage stay empty.
  const slots = Array.from({ length: 30 }, (_, i) => new Date(Date.now() - (29 - i) * 864e5).toISOString().slice(0, 10))
    .map((key) => data?.perDay.find((d) => d.key === key) ?? { key, calls: 0, input: 0, output: 0, cost: 0 });
  const max = Math.max(...slots.map((d) => d.cost), 1e-9);
  const figures = [['Cost', money(sum('cost'))], ['Requests', n(sum('calls'))], ['Input tokens', n(sum('input'))], ['Output tokens', n(sum('output'))]];
  return (
    <Page wide title="Usage" hint="What your team used in the last 30 days."
      actions={all && <label className="flex items-center gap-2 text-sm"><span className="text-muted-foreground">Show</span><Select className="w-auto" value={scope} onChange={(e) => setScope(e.target.value as 'me' | 'all')}><option value="all">Everyone</option><option value="me">Only me</option></Select></label>}>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
        {figures.map(([l, v]) => <div key={l}><dd className="tnum text-xl leading-7 font-semibold">{v}</dd><dt className="text-sm text-muted-foreground">{l}</dt></div>)}
      </dl>
      <section className="mt-10" aria-label="Cost per day">
        <Reveal loading={!data} fallback={<Loading n={6} />}>{data?.perDay.length ? <>
          <TooltipProvider><div className="flex h-44 items-end border-b" role="group" aria-label="Cost per day, last 30 days">
            {slots.map((d) => (
              <Tooltip key={d.key}>
                <TooltipTrigger render={<div tabIndex={0} aria-label={`${day(d.key)}: ${money(d.cost)}, ${d.calls} requests`} className="group relative flex h-full min-w-0 flex-1 items-end justify-center rounded-t hover:bg-foreground/5 focus-visible:bg-foreground/5" />}>
                  <div className={`w-full max-w-5 rounded-t-md ${d.cost ? 'bg-foreground group-hover:opacity-80' : 'bg-border'}`} style={{ height: d.cost ? `max(${(d.cost / max) * 100}%, 3px)` : '2px' }} />
                </TooltipTrigger>
                <TooltipContent side="top" className="flex-col items-start gap-0 whitespace-nowrap">
                  <div>{day(d.key)}</div><div className="tnum font-medium">{money(d.cost)}, {d.calls} {d.calls === 1 ? 'request' : 'requests'}</div>
                </TooltipContent>
              </Tooltip>
            ))}
          </div></TooltipProvider>
          <div className="flex text-xs text-muted-foreground" aria-hidden>{slots.map((d, i) => <span key={d.key} className="relative min-w-0 flex-1 pt-1.5">{i % 7 === 1 && <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap">{day(d.key)}</span>}</span>)}</div>
        </> : <Empty icon={<BarChart3 size={26} />}>No usage yet. It will show up here after the first conversation.</Empty>}</Reveal>
      </section>
      <div className="mt-10"><UsageTable title="By model" first="Model" rows={data?.perModel} />
        {scope === 'all' && <UsageTable title="By person" first="Person" rows={data?.perUser} label />}
        <UsageTable title="By day" first="Day" rows={data?.perDay.slice().reverse()} fmt={day} /></div>
    </Page>
  );
}

function UsageTable({ title, first, rows, label, fmt }: { title: string; first: string; rows?: UsageRow[]; label?: boolean; fmt?: (k: string) => string }) {
  return (
    <Section title={title}>
      <Reveal loading={!rows} fallback={<Loading shape="rows" n={2} />}>
        <Table head={[first, 'Requests', 'Input', 'Output', 'Cost']} num={[1, 2, 3, 4]}>
          {rows?.map((r) => <tr key={r.key}><td>{label ? r.label : fmt ? fmt(r.key) : r.key}</td>{[n(r.calls), n(r.input), n(r.output), money(r.cost)].map((v, i) => <td key={i} className="tnum text-right">{v}</td>)}</tr>)}
          {rows && !rows.length && <tr><td colSpan={5} className="text-center text-muted-foreground">Nothing here yet.</td></tr>}
        </Table>
      </Reveal>
    </Section>
  );
}
