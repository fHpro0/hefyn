import { ChevronDown, ChevronRight, Ellipsis, Play, Plus, Search, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { can, useQuery, type Me } from './api';
import { AgentIcon, loadAgents, type CliAgent } from './AgentChoice';
import { IconView } from './IconPicker';
import { ConfirmDialog } from './dialogs';
import { ImportMenu, type Imported } from './assistants/Import';
import { SettingsDialog } from './assistants/Settings';
import Shell from './Shell';
import { toast } from './toast';
import { Chip, Empty, Err, Input, Loading, Page, Reveal } from './ui';

const rpc = trpc;

interface Row { id: string; name: string; description: string; icon: string; agent: string | null; owner: 'me' | 'team'; scope: string; shareStatus: null | 'pending' | 'declined'; isDefault: boolean; archived: boolean; updatedAt?: string; simple: boolean }
type Tab = 'mine' | 'team';

export default function Assistants() {
  return <Shell title="Assistants">{(me) => <Content me={me} />}</Shell>;
}

function Content({ me }: { me: Me }) {
  const list = useQuery(() => rpc.assistants.editable.query() as Promise<Row[]>);
  const [tab, setTab] = useState<Tab>(location.hash === '#team' ? 'team' : 'mine');
  const [q, setQ] = useState('');
  const [old, setOld] = useState(false);
  const [agents, setAgents] = useState<CliAgent[]>([]);
  const [settings, setSettings] = useState<string>();
  const [ask, setAsk] = useState<{ title: string; body: string; action: string; danger?: boolean; go: () => void }>();
  useEffect(() => { void loadAgents().then(setAgents); }, []);
  const create = can(me, 'assistants.create'), manage = can(me, 'assistants.manage'), share = can(me, 'assistants.share');
  const match = (a: Row) => `${a.name} ${a.description}`.toLowerCase().includes(q.trim().toLowerCase());
  const all = (list.data ?? []).filter((a) => a.owner === (tab === 'mine' ? 'me' : 'team') && match(a));
  const retired = all.filter((a) => !a.simple), usable = all.filter((a) => a.simple);
  const live = usable.filter((a) => !a.archived), archived = usable.filter((a) => a.archived);
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); } catch (x) { toast((x as Error).message, true); } list.reload(); };
  const open = (id: string) => (location.href = `/assistants/edit#${id}`);
  const newOne = () => { localStorage.removeItem('hefyn:assistant-draft:new'); location.href = `/assistants/edit${tab === 'team' && manage ? '?scope=team' : ''}#new`; };
  // an import starts a draft; the editor picks it up from here
  const imported = (r: Imported) => {
    localStorage.setItem('hefyn:assistant-draft:new', JSON.stringify({ draftId: r.draftId, agent: r.agent }));
    if (r.ignored.length) sessionStorage.setItem('hefyn:assistant-import-ignored', JSON.stringify(r.ignored));
    location.href = `/assistants/edit${tab === 'team' && manage ? '?scope=team' : ''}#new`;
  };
  const agentOf = (a: Row) => agents.find((x) => x.id === a.agent);
  const duplicate = (a: Row) => run(async () => { const g = await rpc.assistants.get.query({ id: a.id }); await rpc.assistants.save.mutate({ name: `${a.name} (copy)`, description: g.description, icon: g.icon, inputs: g.inputs, roles: [], agent: g.agent, provider: g.provider, model: g.model, thinking: g.thinking, instructions: g.instructions, skills: g.skills, mcp: g.mcp, helpers: g.helpers }); }, 'Copied to Mine');
  const remove = (a: Row) => setAsk({ title: `Delete ${a.name}?`, body: 'It is removed for good. Chats that used it keep their messages.', action: 'Delete', go: () => run(() => rpc.assistants.remove.mutate({ id: a.id }), 'Deleted') });

  const card = (a: Row) => {
    const editable = a.owner === 'me' || manage, ag = agentOf(a);
    return (
      <li key={a.id} className={`group relative grid content-start gap-3 rounded-xl border border-border p-4 transition-colors hover:border-foreground/30 hover:bg-muted/30 ${a.archived ? 'opacity-70' : ''}`}>
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted"><IconView value={a.icon} size={20} /></div>
          <div className="min-w-0 grow">
            <button type="button" className="block max-w-full truncate text-left text-sm font-semibold after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring" onClick={() => open(a.id)}>{a.name}</button>
            <p className="mt-0.5 line-clamp-2 min-h-9 text-[13px] leading-[18px] text-muted-foreground">{a.description || 'No description yet.'}</p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="relative z-10 -mt-1 -mr-2 shrink-0" aria-label={`More for ${a.name}`} />}><Ellipsis size={16} aria-hidden /></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem className="text-[13px]" onClick={() => open(a.id)}>{editable ? 'Edit' : 'View'}</DropdownMenuItem>
              {editable && a.simple && <DropdownMenuItem className="text-[13px]" onClick={() => setSettings(a.id)}>Settings…</DropdownMenuItem>}
              {create && <DropdownMenuItem className="text-[13px]" onClick={() => duplicate(a)}>Duplicate</DropdownMenuItem>}
              {share && a.owner === 'me' && a.shareStatus !== 'pending' && !a.archived && (
                <DropdownMenuItem className="text-[13px]" onClick={() => setAsk({ title: `Share ${a.name} with the team?`, body: 'A copy goes to a reviewer. Yours stays private, and the team only sees it once it is approved.', action: 'Send for review', danger: false,
                  go: () => run(() => rpc.assistants.share.mutate({ id: a.id }), 'Sent for review') })}>{a.shareStatus === 'declined' ? 'Share again' : 'Share with team'}</DropdownMenuItem>)}
              {manage && a.owner === 'team' && !a.isDefault && !a.archived && <DropdownMenuItem className="text-[13px]" onClick={() => run(() => rpc.assistants.setDefault.mutate({ id: a.id }), 'Default assistant changed')}><Star size={14} aria-hidden />Set as default</DropdownMenuItem>}
              {editable && <DropdownMenuItem className="text-[13px]" onClick={() => run(() => rpc.assistants.archive.mutate({ id: a.id, archived: !a.archived }), a.archived ? 'Restored' : 'Archived')}>{a.archived ? 'Restore' : 'Archive'}</DropdownMenuItem>}
              {a.owner === 'me' && <><DropdownMenuSeparator /><DropdownMenuItem className="text-[13px] text-danger-ink" onClick={() => remove(a)}>Delete</DropdownMenuItem></>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {a.owner === 'team' ? <Chip tone="blue">Team</Chip> : <Chip>Private</Chip>}
          {a.isDefault && <Chip tone="seal">Default</Chip>}
          {a.shareStatus === 'pending' && <Chip tone="caution">Waiting for review</Chip>}
          {a.shareStatus === 'declined' && <Chip tone="alarm">Declined</Chip>}
        </div>
        <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
          <AgentIcon src={ag?.icon} size={16} /><span className="min-w-0 truncate">{ag?.name ?? a.agent ?? 'No agent'}</span>
          <span aria-hidden>·</span><span className="shrink-0">{a.owner === 'me' ? 'You' : 'Team'}</span>
          {!a.archived && <Button variant="outline" size="sm" className="relative z-10 ml-auto" onClick={() => (location.href = `/?assistant=${encodeURIComponent(a.id)}`)}><Play size={13} aria-hidden />Try it</Button>}
        </div>
      </li>
    );
  };

  const retiredRow = (a: Row) => {
    const editable = a.owner === 'me' || manage;
    return (
      <li key={a.id} className="flex flex-wrap items-center gap-3 border-b border-border py-2.5 last:border-b-0">
        <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><IconView value={a.icon} /></div>
        <div className="min-w-0 grow"><p className="truncate text-sm">{a.name}</p><p className="truncate text-xs text-muted-foreground">{a.description || 'Built with the retired flow builder'}</p></div>
        {editable && <>
          <Button variant="outline" size="sm" onClick={() => setAsk({ title: `Convert ${a.name} to a simple assistant?`, body: 'It keeps its name and icon, plus the instructions and skills of its main agent step when it has one. The steps of the old flow are dropped. Check the result before you use it.', action: 'Convert', danger: false,
            go: () => run(() => rpc.assistants.convertRetired.mutate({ id: a.id }), 'Converted. Check it before you use it.') })}>Convert to simple assistant</Button>
          {a.owner === 'me' && <Button variant="ghost" size="sm" className="text-danger-ink" onClick={() => remove(a)}>Delete</Button>}
        </>}
      </li>
    );
  };

  const canNew = tab === 'mine' ? create : manage;
  const blank = !!list.data && !q && !live.length && !retired.length && !archived.length; // nothing to search or add to: the empty state carries the button
  return (
    <Page wide title="Assistants" hint="Ready-made ways of working that people pick when they start a chat. They never see models or settings, only the name and what it is for."
      actions={canNew && !blank && <div className="flex items-center gap-2"><ImportMenu onDone={imported} /><Button onClick={newOne}><Plus size={15} aria-hidden />New assistant</Button></div>}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={tab} onValueChange={(v) => { setTab(v as Tab); history.replaceState(null, '', v === 'team' ? '#team' : location.pathname); }}>
          <TabsList aria-label="Whose assistants"><TabsTrigger value="mine">Mine</TabsTrigger><TabsTrigger value="team">Team</TabsTrigger></TabsList>
        </Tabs>
        {!blank && <div className="relative ml-auto w-full sm:w-64">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" aria-label="Search assistants" placeholder="Search" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>}
      </div>
      {tab === 'team' && !manage && <p className="mb-3 text-[13px] text-muted-foreground">These are shared by your admins. You can use them and look at how they work.</p>}
      <Err>{list.error}</Err>
      <Reveal loading={!list.data && !list.error} fallback={<Loading shape="cards" />}>
      {list.data && !live.length && !retired.length && !archived.length && <Empty icon={<Star size={26} />} action={canNew && !q ? <div className="flex items-center gap-2"><ImportMenu onDone={imported} /><Button onClick={newOne}>New assistant</Button></div> : undefined}>
        {q ? `Nothing matches “${q}”.` : tab === 'mine' ? 'You have no assistants yet. Create one and it is ready in your next chat.' : 'The team has no assistants yet.'}</Empty>}
      {live.length > 0 && <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{live.map(card)}</ul>}
      {archived.length > 0 && (
        <div className="mt-6">
          <button type="button" className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground" aria-expanded={old} onClick={() => setOld(!old)}>
            {old ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}Archived ({archived.length})
          </button>
          {old && <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{archived.map(card)}</ul>}
        </div>
      )}
      {retired.length > 0 && (
        <section className="mt-8 rounded-xl border border-dashed border-border bg-muted/20 p-4" aria-label="Retired">
          <h2 className="text-[13px] font-medium text-muted-foreground">Retired ({retired.length})</h2>
          <p className="mt-0.5 mb-2 text-xs leading-5 text-muted-foreground">These were made with the old flow builder. They can not start chats. Convert one to a simple assistant to use it again.</p>
          <ul>{retired.map(retiredRow)}</ul>
        </section>
      )}
      </Reveal>
      {settings && <SettingsDialog id={settings} onClose={() => setSettings(undefined)} onSaved={list.reload} />}
      {ask && <ConfirmDialog title={ask.title} body={ask.body} action={ask.action} danger={ask.danger ?? true} onConfirm={ask.go} onClose={() => setAsk(undefined)} />}
    </Page>
  );
}
