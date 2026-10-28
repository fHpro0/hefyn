import { CalendarClock, MoreHorizontal, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { api, useLoad } from '@/components/api';
import { ConfirmDialog, Dialog } from '@/components/dialogs';
import Shell from '@/components/Shell';
import { toast } from '@/components/toast';
import { Chip, Empty, Err, Field, Input, Page, Section, Select, Switch, Textarea, type Tone } from '@/components/ui';

// Scheduled tasks (docs/SCHEDULES.md): at a time, hefyn starts a new chat and sends it the prompt.
const ago = (iso?: string) => iso ? new Date(iso.includes('T') || iso.includes('Z') ? iso : `${iso.replace(' ', 'T')}Z`).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
interface Rule { kind: 'once' | 'daily' | 'weekly' | 'monthly' | 'every'; at?: string; time?: string; days?: number[]; day?: number; minutes?: number }
interface Schedule {
  id: string; title: string; target: { prompt: string }; rule: Rule; ruleText: string; timezone: string; enabled: boolean;
  nextRunAt: string | null; lastRunAt: string | null; lastStatus: string | null; lastDetail: string | null; lastConversationId: string | null;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const tone = (s: string | null): Tone => (!s ? 'neutral' : s === 'ok' ? 'ok' : s === 'failed' ? 'alarm' : s === 'running' ? 'blue' : 'caution');

export default function Schedules() {
  return <Shell title="Schedules">{() => <Content />}</Shell>;
}

function Content() {
  const list = useLoad<Schedule[]>('/api/schedules');
  const [edit, setEdit] = useState<Schedule | 'new'>();
  const [del, setDel] = useState<Schedule>();
  useEffect(() => { const t = setInterval(() => list.data?.some((s) => s.lastStatus === 'running') && list.reload(), 3000); return () => clearInterval(t); }, [list.data]);
  const act = async (f: () => Promise<unknown>, ok?: string) => { try { await f(); ok && toast(ok); } catch (e) { toast((e as Error).message, true); } list.reload(); };
  return (
    <Page wide title="Schedules" hint="Let hefyn start a chat for you at a set time, for example a weekly report. Each run opens a new chat."
      actions={<Button onClick={() => setEdit('new')}><Plus size={14} aria-hidden />New schedule</Button>}>
      <Err>{list.error}</Err>
      {list.data && !list.data.length ? <Empty icon={<CalendarClock size={28} />} action={<Button onClick={() => setEdit('new')}><Plus size={14} aria-hidden />New schedule</Button>}>No schedules yet. You can also ask the assistant in a chat, such as “remind me every Friday at 17:00 to write the weekly report”.</Empty>
        : list.data && <Section><ul>{list.data.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border py-3.5 last:border-b-0">
            <div className="min-w-0 grow basis-64">
              <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{s.title}</span></div>
              <p className="mt-0.5 text-[13px] text-muted-foreground">{s.ruleText}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{s.enabled && s.nextRunAt ? `Next run: ${ago(s.nextRunAt)}` : s.enabled ? 'Finished' : 'Paused'}</p>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {s.lastStatus && <span title={s.lastDetail ?? undefined}><Chip tone={tone(s.lastStatus)}>{s.lastStatus}</Chip></span>}
              {s.lastRunAt && <span>{ago(s.lastRunAt)}</span>}
              {s.lastConversationId && <a className="underline underline-offset-2" href={`/#${s.lastConversationId}`}>Open chat</a>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Switch checked={s.enabled} label={`${s.enabled ? 'Pause' : 'Enable'} ${s.title}`} onChange={(v) => act(() => api(`/api/schedules/${s.id}`, 'PATCH', { enabled: v }))} />
              <Button variant="outline" disabled={s.lastStatus === 'running'} onClick={() => act(() => api(`/api/schedules/${s.id}/run-now`, 'POST'), 'Started')}><Play size={14} aria-hidden />Run now</Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`More for ${s.title}`} />}><MoreHorizontal size={16} aria-hidden /></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem className="text-[13px]" onClick={() => setEdit(s)}><Pencil size={14} aria-hidden />Edit</DropdownMenuItem>
                  <DropdownMenuItem className="text-[13px]" onClick={() => setDel(s)}><Trash2 size={14} aria-hidden />Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </li>))}</ul></Section>}
      {edit && <Editor s={edit === 'new' ? undefined : edit} onClose={() => setEdit(undefined)} onSaved={() => { setEdit(undefined); list.reload(); }} />}
      {del && <ConfirmDialog title="Delete schedule" body={`“${del.title}” will not run again. Chats it already started stay.`} action="Delete" onClose={() => setDel(undefined)} onConfirm={() => act(() => api(`/api/schedules/${del.id}`, 'DELETE'), 'Deleted')} />}
    </Page>
  );
}

const localNow = () => { const d = new Date(Date.now() + 3600_000); d.setMinutes(0, 0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

function Editor({ s, onClose, onSaved }: { s?: Schedule; onClose: () => void; onSaved: () => void }) {
  const r = s?.rule;
  const [title, setTitle] = useState(s?.title ?? '');
  const [prompt, setPrompt] = useState(s?.target.prompt ?? '');
  const [tz, setTz] = useState(s?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [kind, setKind] = useState<Rule['kind']>(r?.kind ?? 'weekly');
  const [time, setTime] = useState(r?.time ?? '09:00');
  const [days, setDays] = useState<number[]>(r?.days ?? [1]);
  const [day, setDay] = useState(r?.day ?? 1);
  const [at, setAt] = useState(r?.at ?? localNow());
  const [n, setN] = useState(r?.minutes ? (r.minutes % 60 === 0 ? r.minutes / 60 : r.minutes) : 1);
  const [unit, setUnit] = useState<'minutes' | 'hours'>(r?.minutes && r.minutes % 60 !== 0 ? 'minutes' : 'hours');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [prev, setPrev] = useState<string[]>([]);
  const rule: Rule = kind === 'once' ? { kind, at } : kind === 'daily' ? { kind, time } : kind === 'weekly' ? { kind, days, time } : kind === 'monthly' ? { kind, day, time } : { kind, minutes: n * (unit === 'hours' ? 60 : 1) };
  const key = JSON.stringify([rule, tz]);
  useEffect(() => {
    const t = setTimeout(() => api('/api/schedules/preview', 'POST', { rule, timezone: tz }).then((p) => { setPrev(p.next); setErr(''); }).catch((e) => { setPrev([]); setErr(e.message); }), 250);
    return () => clearTimeout(t);
  }, [key]);
  const zones = (Intl as any).supportedValuesOf?.('timeZone') as string[] | undefined;
  const save = async () => {
    setBusy(true);
    try { const body = { title, prompt, rule, timezone: tz }; await (s ? api(`/api/schedules/${s.id}`, 'PATCH', body) : api('/api/schedules', 'POST', body)); onSaved(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog wide title={s ? 'Edit schedule' : 'New schedule'} onClose={onClose} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !title.trim() || !prompt.trim()} onClick={save}>{s ? 'Save' : 'Create'}</Button></>}>
      <Field label="Title"><Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly report" /></Field>
      <Field label="Prompt"><Textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should the chat do each time?" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Repeat"><Select value={kind} onChange={(e) => setKind(e.target.value as Rule['kind'])}>
          <option value="once">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="every">Every N minutes or hours</option></Select></Field>
        {kind === 'once' ? <Field label="Date and time"><Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
          : kind === 'every' ? <Field label="Every"><div className="flex gap-2"><Input type="number" min={1} value={n} onChange={(e) => setN(Number(e.target.value))} /><Select value={unit} onChange={(e) => setUnit(e.target.value as 'minutes' | 'hours')}><option value="minutes">minutes</option><option value="hours">hours</option></Select></div></Field>
          : <Field label="Time"><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>}
      </div>
      {kind === 'weekly' && <div role="group" aria-label="Weekdays" className="flex flex-wrap gap-1.5">{DAYS.map((d, i) => {
        const on = days.includes(i);
        return <button key={d} type="button" aria-pressed={on} onClick={() => setDays(on ? days.filter((x) => x !== i) : [...days, i])} className={`rounded-full border px-3 py-1 text-[13px] ${on ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'}`}>{d}</button>;
      })}</div>}
      {kind === 'monthly' && <Field label="Day of the month"><Input type="number" min={1} max={31} value={day} onChange={(e) => setDay(Number(e.target.value))} /></Field>}
      <Field label="Time zone">
        {zones ? <Select value={tz} onChange={(e) => setTz(e.target.value)}>{(zones.includes(tz) ? zones : [tz, ...zones]).map((z) => <option key={z}>{z}</option>)}</Select> : <Input value={tz} onChange={(e) => setTz(e.target.value)} />}
      </Field>
      <div className="text-[13px] text-muted-foreground" aria-live="polite">
        {prev.length ? <>Next runs: {prev.map((p) => new Date(p).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', timeZone: tz })).join(' · ')}</> : !err && 'No upcoming run.'}
      </div>
      <Err>{err}</Err>
    </Dialog>
  );
}
