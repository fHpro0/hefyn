import { ChevronDown, ChevronRight, Ellipsis, Plus, Star } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { can, useQuery, type Me } from './api';
import { AssistantIcon } from './AgentChoice';
import { ConfirmDialog } from './dialogs';
import Shell from './Shell';
import { toast } from './toast';
import { Chip, Empty, Err, Page } from './ui';

const rpc = trpc;

interface Row { id: string; name: string; description: string; icon: string; owner: 'me' | 'team'; scope: string; shareStatus: null | 'pending' | 'declined'; isDefault: boolean; archived: boolean; updatedAt?: string; simple: boolean }
type Tab = 'mine' | 'team';

export default function Assistants() {
  return <Shell title="Assistants">{(me) => <Content me={me} />}</Shell>;
}

function Content({ me }: { me: Me }) {
  const list = useQuery(() => rpc.assistants.editable.query() as Promise<Row[]>);
  const [tab, setTab] = useState<Tab>(location.hash === '#team' ? 'team' : 'mine');
  const [old, setOld] = useState(false);
  const [ask, setAsk] = useState<{ title: string; body: string; action: string; danger?: boolean; go: () => void }>();
  const create = can(me, 'assistants.create'), manage = can(me, 'assistants.manage'), share = can(me, 'assistants.share');
  const all = (list.data ?? []).filter((a) => a.owner === (tab === 'mine' ? 'me' : 'team'));
  const live = all.filter((a) => !a.archived), archived = all.filter((a) => a.archived);
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); } catch (x) { toast((x as Error).message, true); } list.reload(); };
  const open = (id: string) => (location.href = `/assistants/edit#${id}`);
  const newOne = () => (location.href = `/assistants/edit${tab === 'team' && manage ? '?scope=team' : ''}#new`);
  const duplicate = (a: Row) => run(async () => { const g = await rpc.assistants.get.query({ id: a.id }); await rpc.assistants.save.mutate({ name: `${a.name} (copy)`, description: g.description, icon: g.icon, inputs: g.inputs, roles: [], flow: g.flow }); }, 'Copied to Mine');

  const row = (a: Row) => {
    const editable = a.owner === 'me' || manage;
    return (
      <div key={a.id} className={`flex items-center gap-3 border-b border-border py-3 ${a.archived ? 'opacity-70' : ''}`}>
        <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted"><AssistantIcon name={a.icon} /></div>
        <button type="button" className="min-w-0 grow text-left" onClick={() => open(a.id)}>
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{a.name}</span>
            {a.isDefault && <Chip tone="seal">Default</Chip>}
            {a.shareStatus === 'pending' && <Chip tone="caution">Waiting for review</Chip>}
            {a.shareStatus === 'declined' && <Chip tone="alarm">Declined</Chip>}
            {!a.simple && <Chip>Flow</Chip>}
          </span>
          <span className="mt-0.5 block truncate text-[13px] text-muted-foreground">{a.description}</span>
        </button>
        {!a.archived && <Button variant="outline" size="sm" onClick={() => (location.href = `/?assistant=${encodeURIComponent(a.id)}`)}>Try it</Button>}
        <Button variant="outline" size="sm" onClick={() => open(a.id)}>{editable ? 'Edit' : 'View'}</Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`More for ${a.name}`} />}><Ellipsis size={16} aria-hidden /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {create && <DropdownMenuItem className="text-[13px]" onClick={() => duplicate(a)}>Duplicate</DropdownMenuItem>}
            {share && a.owner === 'me' && a.shareStatus !== 'pending' && !a.archived && (
              <DropdownMenuItem className="text-[13px]" onClick={() => setAsk({ title: `Share ${a.name} with the team?`, body: 'A copy goes to a reviewer. Yours stays private, and the team only sees it once it is approved.', action: 'Send for review', danger: false,
                go: () => run(() => rpc.assistants.share.mutate({ id: a.id }), 'Sent for review') })}>{a.shareStatus === 'declined' ? 'Share again' : 'Share with team'}</DropdownMenuItem>)}
            {manage && a.owner === 'team' && !a.isDefault && !a.archived && <DropdownMenuItem className="text-[13px]" onClick={() => run(() => rpc.assistants.setDefault.mutate({ id: a.id }), 'Default Assistant changed')}><Star size={14} aria-hidden />Set as default</DropdownMenuItem>}
            {editable && <DropdownMenuItem className="text-[13px]" onClick={() => run(() => rpc.assistants.archive.mutate({ id: a.id, archived: !a.archived }), a.archived ? 'Restored' : 'Archived')}>{a.archived ? 'Restore' : 'Archive'}</DropdownMenuItem>}
            {a.owner === 'me' && <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-[13px] text-danger-ink" onClick={() => setAsk({ title: `Delete ${a.name}?`, body: 'It is removed for good. Chats that used it keep their messages.', action: 'Delete', go: () => run(() => rpc.assistants.remove.mutate({ id: a.id }), 'Deleted') })}>Delete</DropdownMenuItem>
            </>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  const canNew = tab === 'mine' ? create : manage;
  return (
    <Page wide title="Assistants" hint="Ready-made ways of working that people pick when they start a chat. They never see models or settings, only the name and what it is for."
      actions={canNew && <Button onClick={newOne}><Plus size={15} aria-hidden />New assistant</Button>}>
      <Tabs value={tab} onValueChange={(v) => { setTab(v as Tab); history.replaceState(null, '', v === 'team' ? '#team' : location.pathname); }} className="mb-3">
        <TabsList aria-label="Whose Assistants"><TabsTrigger value="mine">Mine</TabsTrigger><TabsTrigger value="team">Team</TabsTrigger></TabsList>
      </Tabs>
      {tab === 'team' && !manage && <p className="mb-2 text-[13px] text-muted-foreground">These are shared by your admins. You can use them and look at how they work.</p>}
      <Err>{list.error}</Err>
      <div className="border-t border-border">
        {list.data && !live.length && <Empty icon={<Star size={26} />} action={canNew ? <Button onClick={newOne}>New assistant</Button> : undefined}>
          {tab === 'mine' ? 'You have no Assistants yet. Create one and it is ready in your next chat.' : 'The team has no Assistants yet.'}</Empty>}
        {live.map(row)}
      </div>
      {archived.length > 0 && (
        <div className="mt-5">
          <button type="button" className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground" aria-expanded={old} onClick={() => setOld(!old)}>
            {old ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}Archived ({archived.length})
          </button>
          {old && <div className="mt-2 border-t border-border">{archived.map(row)}</div>}
        </div>
      )}
      {ask && <ConfirmDialog title={ask.title} body={ask.body} action={ask.action} danger={ask.danger ?? true} onConfirm={ask.go} onClose={() => setAsk(undefined)} />}
    </Page>
  );
}
