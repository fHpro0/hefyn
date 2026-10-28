import { Database, LockKeyhole, Plus, Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { can, type Me } from './api';
import { NewCollection } from './dataset/NewCollection';
import { Records } from './dataset/Records';
import { SettingsDialog } from './dataset/Settings';
import { trpc } from '@/lib/trpc';
import { TEMPLATES, type Collection } from './dataset/types';
import { iconFor } from './icons';
import Shell, { navRow } from './Shell';
import { Chip, Empty, Select } from './ui';

// Data (docs/DATA.md): your own collections and records, PocketBase-style. Collections on the left, records on the right;
// the address is /data#<slug>. (Not data.tsx: that is the table helper, and the file system ignores case.)
export default function DataPage() {
  return <Shell title="Data">{(me) => <Content me={me} />}</Shell>;
}

const hashSlug = () => decodeURIComponent(location.hash.slice(1));

function Content({ me }: { me: Me }) {
  const [list, setList] = useState<{ items: Collection[]; teamLocked: boolean }>();
  const [err, setErr] = useState('');
  const [slug, setSlug] = useState(hashSlug());
  const [creating, setCreating] = useState<string | true>();
  const [settings, setSettings] = useState(false);
  const load = () => trpc.data.collections.list.query().then((r) => { setList(r); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const h = () => setSlug(hashSlug()); addEventListener('hashchange', h); return () => removeEventListener('hashchange', h); }, []);

  const items = list?.items ?? [];
  const col = items.find((c) => c.slug === slug) ?? (slug ? undefined : items[0]);
  const go = (s: string) => { location.hash = s; setSlug(s); };
  const group = (scope: 'personal' | 'team') => items.filter((c) => c.scope === scope);
  const canTeam = can(me, 'data.manage');

  const row = (c: Collection) => { const Icon = iconFor(c.icon), on = col?.id === c.id; return (
    <li key={c.id}><a href={`#${c.slug}`} aria-current={on ? 'page' : undefined} className={navRow(on)} onClick={() => setSlug(c.slug)}>
      <Icon size={15} aria-hidden className="shrink-0 text-muted-foreground" /><span className="truncate">{c.name}</span><span className="ml-auto text-xs tabular-nums text-muted-foreground">{c.records}</span></a></li>); };
  const section = (title: string, scope: 'personal' | 'team') => (group(scope).length > 0 &&
    <div><h2 className="mb-1 px-2 text-xs font-medium text-muted-foreground">{title}</h2><ul className="grid gap-0.5">{group(scope).map(row)}</ul></div>);

  const newButton = <Button onClick={() => setCreating(true)}><Plus aria-hidden />New collection</Button>;
  return (
    <div className="mx-auto flex w-full max-w-[1400px] grow flex-col gap-4 px-4 py-5 md:flex-row md:gap-6 md:px-6">
      <nav aria-label="Collections" className="shrink-0 md:w-56">
        <div className="flex items-center gap-2 md:hidden">
          <Select aria-label="Collection" value={col?.slug ?? ''} onChange={(e) => go(e.target.value)}>
            {!col && <option value="">Choose a collection</option>}
            {items.map((c) => <option key={c.id} value={c.slug}>{c.name}{c.scope === 'team' ? ' (team)' : ''}</option>)}
          </Select>
          <Button variant="outline" size="icon" aria-label="New collection" onClick={() => setCreating(true)}><Plus aria-hidden /></Button>
        </div>
        <div className="sticky top-4 hidden gap-4 md:grid">
          {newButton}
          {section('Personal', 'personal')}
          {section('Team', 'team')}
          {list?.teamLocked && <p className="flex items-start gap-1.5 px-2 text-xs text-muted-foreground"><LockKeyhole size={13} aria-hidden className="mt-0.5 shrink-0" />Team collections are locked until an admin signs in.</p>}
        </div>
      </nav>

      <section aria-label={col?.name ?? 'Records'} className="min-w-0 grow">
        {err ? <p role="alert" className="text-[13px] text-danger-ink">{err}</p>
          : !list ? <p className="py-8 text-center text-[13px] text-muted-foreground" role="status">Loading…</p>
          : col ? (
            <div className="grid gap-4">
              <header className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h1 className="flex items-center gap-2 text-xl leading-7 font-semibold">{(() => { const Icon = iconFor(col.icon); return <Icon size={20} aria-hidden className="shrink-0 text-muted-foreground" />; })()}<span className="truncate">{col.name}</span>
                    {col.scope === 'team' && <Chip tone="blue">Team</Chip>}{!col.canEdit && <Chip>Read only</Chip>}</h1>
                  {col.description && <p className="mt-0.5 max-w-xl text-sm text-muted-foreground">{col.description}</p>}
                </div>
                <Button variant="outline" onClick={() => setSettings(true)}><Settings2 aria-hidden />{col.canManage ? 'Schema & settings' : 'Schema'}</Button>
              </header>
              <Records col={col} me={me.id} onChanged={load} />
            </div>)
          : slug ? <Empty icon={<Database size={26} />} action={newButton}>There is no collection called “{slug}” that you can open.</Empty>
          : (
            <Empty icon={<Database size={26} />} action={<div className="flex flex-wrap justify-center gap-2">{TEMPLATES.map((t) => <Button key={t.key} variant="outline" onClick={() => setCreating(t.key)}>{t.name}</Button>)}{newButton}</div>}>
              Keep what you need to track: tasks, projects, time bookings. Start from a template or build your own, and ask the assistant about it in a chat.
            </Empty>)}
      </section>

      {creating && <NewCollection collections={items} canTeam={canTeam} initial={creating === true ? undefined : creating} onClose={() => setCreating(undefined)} onCreated={(s) => { load(); go(s); }} />}
      {settings && col && <SettingsDialog col={col} collections={items} onClose={() => setSettings(false)} onSaved={(s) => { load(); if (s !== col.slug) go(s); }} onDeleted={() => { location.hash = ''; setSlug(''); load(); }} />}
    </div>
  );
}
