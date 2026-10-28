import { ChevronDown, SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { actsWithoutAskingText, agentId } from './agent-catalog';
import { IconView } from './IconPicker';

export const AssistantIcon = ({ name, size = 16, className }: { name?: string; size?: number; className?: string }) => <IconView value={name} size={size} className={className} />;

export interface CliAgent { id: string; name: string; icon?: string; available: boolean; reason?: string; actsWithoutAsking?: boolean }
export type CliView = 'chat' | 'terminal';
export interface AssistantInfo { id: string; name: string; description: string; icon: string; agent: string | null; isDefault: boolean; owner?: 'me' | 'team'; available: boolean; reason?: string; inputs: { images: 'off' | 'on'; maxImageEdge: number; imageQuality: number; documents: boolean; maxUploadMb: number } }

/** The agent's own icon, or the terminal icon when it has none or fails to load. */
export const AgentIcon = ({ src, size = 28 }: { src?: string; size?: number }) => {
  const [failed, setFailed] = useState<string>(); // the src that failed, so a src that arrives later still gets its try
  const bad = !src || failed === src;
  return bad ? <SquareTerminal size={Math.round(size * 0.6)} className="shrink-0 text-muted-foreground" aria-hidden /> : <img src={src} alt="" width={size} height={size} className="shrink-0 rounded-md dark:invert" onError={() => setFailed(src)} />;
};

// One request per page load: the new-chat screen, the chat header and the sidebar all name agents from it.
let list: Promise<CliAgent[]> | undefined;
export const loadAgents = () => (list ??= trpc.cliAgents.list.query().catch(() => (list = undefined, [] as CliAgent[])) as Promise<CliAgent[]>);
let alist: Promise<AssistantInfo[]> | undefined;
export const loadAssistants = () => (alist ??= trpc.assistants.list.query().catch(() => (alist = undefined, [] as AssistantInfo[])) as Promise<AssistantInfo[]>);
/** The agent a conversation ran on (legacy ids mapped), if the list knows it. */
export const findAgent = (agents: CliAgent[] | undefined, id: string) => agents?.find((a) => a.id === agentId(id));

/** Chat | Terminal for a CLI agent conversation (new-chat choice and conversation header). */
export const ViewToggle = ({ view, onChange }: { view: CliView; onChange: (v: CliView) => void }) => (
  <Tabs value={view} onValueChange={(v) => onChange(v as CliView)} className="shrink-0 whitespace-nowrap">
    <TabsList aria-label="How to show the agent"><TabsTrigger value="chat">Chat</TabsTrigger><TabsTrigger value="terminal">Terminal</TabsTrigger></TabsList>
  </Tabs>
);

/** The one picker of the composer, like a model picker: Assistants and plain agents in a searchable list. The trigger shows the current choice.
 *  Never names models or providers; the server's reasons are reworded for people without `models.manage`. */
export function ComposerPicker({ agents, agent, assistants, assistant, onPick, canManage, sandbox }: { agents: CliAgent[]; agent: string; assistants: AssistantInfo[]; assistant: string; onPick: (v: { agent: string; assistant: string }) => void; canManage: boolean; sandbox: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  if (!agents.length && !assistants.length) return null;
  // A missing key is one short status per row; the way out is said once, in the hint on top. Other reasons stay as the server words them.
  const noKey = (r?: string) => /API key|sign in/i.test(r ?? '');
  const reason = (r?: string) => noKey(r) ? 'Needs a key or sign-in' : r ?? 'It is not set up yet.';
  const keyMissing = [...assistants, ...agents].some((a) => !a.available && noKey(a.reason));
  const agentOff = (a: CliAgent) => !sandbox ? 'Your role cannot use the sandbox.' : !a.available ? reason(a.reason) : '';
  const cur = agent ? agents.find((a) => a.id === agent) : assistants.find((a) => a.id === assistant);
  const match = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase());
  const as = assistants.filter((a) => match(`${a.name} ${a.description}`)), ags = agents.filter((a) => match(a.name));
  const pick = (v: { agent: string; assistant: string }) => { onPick(v); setOpen(false); setQ(''); };
  const move = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled)')], i = items.indexOf(document.activeElement as HTMLElement);
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    e.preventDefault();
  };
  const row = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(''); }}>
      <PopoverTrigger render={<Button type="button" variant="ghost" size="sm" className="max-w-[60%] text-muted-foreground" aria-label={`Who works on this chat: ${cur?.name ?? 'choose'}`} />}>
        {agent ? <AgentIcon src={(cur as CliAgent | undefined)?.icon} size={14} /> : <AssistantIcon name={(cur as AssistantInfo | undefined)?.icon} size={14} />}
        <span className="truncate">{cur?.name ?? 'Choose'}</span><ChevronDown size={14} aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-1 p-1" onKeyDown={move}>
        <Input autoFocus type="search" aria-label="Search assistants and agents" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="mb-1" />
        {keyMissing && (
          <p role="status" className="px-2 py-1.5 text-xs leading-5 text-muted-foreground">
            {canManage && <><a className="underline underline-offset-2" href="/settings/providers#connect">Add an API key</a>{' or '}</>}
            <a className="underline underline-offset-2" href="/settings/agent-accounts">{canManage ? 'sign in' : 'Sign in'} with your own account</a>.{!canManage && ' Or ask an admin to add an API key.'}
          </p>
        )}
        <div className="max-h-80 overflow-auto">
          {as.length > 0 && <div className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted-foreground">Assistants</div>}
          {as.map((a) => (
            <button key={a.id} type="button" disabled={!a.available} aria-pressed={!agent && a.id === assistant} className={row} title={a.available ? undefined : reason(a.reason)} onClick={() => pick({ agent: '', assistant: a.id })}>
              <AssistantIcon name={a.icon} size={16} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5 font-medium"><span className="truncate">{a.name}</span>{a.owner === 'me' && <span className="shrink-0 rounded bg-muted px-1 text-[10px] font-normal text-muted-foreground">Private</span>}</span>
                {(a.available ? a.description : reason(a.reason)) && <span className={`block text-xs text-muted-foreground ${a.available ? 'truncate' : ''}`}>{a.available ? a.description : reason(a.reason)}</span>}</span>
            </button>
          ))}
          {ags.length > 0 && <div className="px-2 pt-2 pb-0.5 text-[11px] font-medium text-muted-foreground">Agents</div>}
          {ags.map((a) => (
            <button key={a.id} type="button" disabled={!!agentOff(a)} aria-pressed={a.id === agent} className={row} onClick={() => pick({ agent: a.id, assistant })}>
              <AgentIcon src={a.icon} size={16} />
              <span className="min-w-0 flex-1"><span className="block font-medium">{a.name}</span>{agentOff(a) && <span className="block text-xs text-muted-foreground">{agentOff(a)}</span>}</span>
            </button>
          ))}
          {!as.length && !ags.length && <p className="px-2 py-3 text-xs text-muted-foreground">Nothing matches “{q}”.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Under "What should we work on?": for a plain agent, the Chat/Terminal choice and its notes. The picker itself sits in the composer (it moves here while the terminal view hides the composer). */
export function AgentChoice({ agents, agent, view, onView, onStart, picker }: { agents: CliAgent[]; agent: string; view: CliView; onView: (v: CliView) => void; onStart: () => void; picker?: React.ReactNode }) {
  const chosen = agents.find((a) => a.id === agent);
  if (!chosen && !picker) return null;
  return (
    <div className="grid justify-items-center gap-2 pb-4">
      {picker}
      {chosen && (
        <div className="grid justify-items-center gap-2">
          <ViewToggle view={view} onChange={onView} />
          {chosen.actsWithoutAsking && <p className="max-w-sm text-xs leading-5 text-warning-ink">{actsWithoutAskingText(chosen.name)}</p>}
          <p className="max-w-sm text-xs leading-5 text-muted-foreground">{view === 'chat' ? `You see what ${chosen.name} does as a normal chat.` : `You see ${chosen.name}'s own terminal.`} You can switch any time.</p>
          {view === 'terminal' && <Button type="button" onClick={onStart}>Start {chosen.name}</Button>}
        </div>
      )}
    </div>
  );
}
