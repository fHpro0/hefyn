import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { can, useQuery, type Me } from './api';
import { ConfirmDialog } from './dialogs';
import Shell from './Shell';
import { SignInDialog } from './SignInDialog';
import { toast } from './toast';
import { Chip, Err, Loading, Page, Reveal, Row, Section, Switch } from './ui';

export default function AgentAccounts() {
  return <Shell>{(me) => <Content me={me} />}</Shell>;
}

type Account = Awaited<ReturnType<typeof trpc.cliAgents.accounts.query>>[number];
type Team = Awaited<ReturnType<typeof trpc.cliAgents.teamAccounts.query>>[number];
type Signing = { a: Account; scope: 'personal' | 'team' };

function Content({ me }: { me: Me }) {
  const { data, error, reload } = useQuery(() => trpc.cliAgents.accounts.query());
  const [signing, setSigning] = useState<Signing>();
  const [out, setOut] = useState<Signing>();
  const [err, setErr] = useState('');
  const signOut = async () => {
    if (!out) return;
    try { await trpc.cliAgents.signOut.mutate({ agentId: out.a.agentId, scope: out.scope }); toast(`Signed out of ${out.a.name}.`); setOut(undefined); void reload(); } catch (e) { setErr((e as Error).message); setOut(undefined); }
  };
  return (
    <Page title="Agent accounts" hint="Use each coding agent with your own account or subscription instead of the company’s. You sign in once, here; your chats with that agent then use your account. hefyn never sees or stores your sign-in: it stays in your own space in the sandbox, and nobody else can use it. Chats that run without you watching (schedules, flows) always use the company’s API key.">
      <Section title="Your accounts">
        <Reveal loading={!data && !error} fallback={<Loading shape="rows" n={3} />}>{data?.map((a) => {
          const team = a.team.login && a.team.loginSignedIn ? 'The team’s shared login is available to you.' : a.team.key ? 'The team’s API key is available to you.' : 'No team account is available to you for this agent.';
          return (
            <Row key={a.agentId} title={<span className="flex flex-wrap items-center gap-2">{a.name}{a.flow && !a.verified && <Chip tone="caution">Sign-in steps not verified</Chip>}</span>}
              hint={a.flow ? <>{a.status === 'signed_in' ? (a.account ? `Signed in as ${a.account}.` : 'Signed in.') : 'Not signed in.'} {team}</> : team}>
              {a.flow && (
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={a.status === 'signed_in' ? 'ok' : 'neutral'}>{a.status === 'signed_in' ? 'Signed in' : 'Not signed in'}</Chip>
                  <Button type="button" size="sm" variant={a.status === 'signed_in' ? 'outline' : 'default'} onClick={() => setSigning({ a, scope: 'personal' })}>
                    {a.status === 'signed_in' ? 'Renew' : a.flow === 'terminal' ? 'Sign in in the terminal' : 'Sign in'}
                  </Button>
                  {a.status === 'signed_in' && a.canSignOut && <Button type="button" size="sm" variant="ghost" onClick={() => setOut({ a, scope: 'personal' })}>Sign out</Button>}
                </div>
              )}
            </Row>
          );
        })}</Reveal>
        {data && !data.length && <p className="py-6 text-[13px] text-muted-foreground">No coding agent is available to you here, so there is nothing to sign in to.</p>}
      </Section>
      {can(me, 'accounts.team') && <TeamSection accounts={data ?? []} onSign={(a) => setSigning({ a, scope: 'team' })} onOut={(a) => setOut({ a, scope: 'team' })} />}
      <Err>{error || err}</Err>
      {signing && <SignInDialog agentId={signing.a.agentId} name={signing.a.name} terminal={signing.a.terminal} flow={signing.a.flow!} scope={signing.scope} onClose={() => { setSigning(undefined); void reload(); }} />}
      {out && <ConfirmDialog title={out.scope === 'team' ? `Sign the team out of ${out.a.name}?` : `Sign out of ${out.a.name}?`} body={out.scope === 'team' ? 'Everyone using the team’s login goes back to the team API key, if there is one.' : `${out.a.name} signs out of your account. Your chats go back to the team’s account, if there is one.`} action="Sign out" onConfirm={signOut} onClose={() => setOut(undefined)} />}
    </Page>
  );
}

/** Admins (accounts.team): per agent, who may use the team API key and the shared team login. */
function TeamSection({ accounts, onSign, onOut }: { accounts: Account[]; onSign: (a: Account) => void; onOut: (a: Account) => void }) {
  const { data, error, reload } = useQuery(() => trpc.cliAgents.teamAccounts.query());
  const [warn, setWarn] = useState<Team>();
  const [err, setErr] = useState('');
  const save = async (agentId: string, patch: Partial<Omit<Parameters<typeof trpc.cliAgents.setTeamAccount.mutate>[0], 'agentId'>>) => {
    setErr('');
    try { await trpc.cliAgents.setTeamAccount.mutate({ agentId, ...patch }); void reload(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Section title="Team accounts">
      <p className="py-3 text-[13px] text-muted-foreground">What the team can use when someone has not signed in with their own account. The team API key is one of the keys under Settings, Agents &amp; keys; it never enters the sandbox. A person’s own sign-in is never restricted by roles.</p>
      {data?.map((t) => {
        const acc = accounts.find((a) => a.agentId === t.agentId);
        return (
          <div key={t.agentId} className="border-t border-border">
            <Row compact title={`${t.name}: team API key`} hint="Chats use the connected key for this agent.">
              <div className="grid gap-2"><Switch label={`Team API key for ${t.name}`} checked={t.keyEnabled} onChange={(keyEnabled) => save(t.agentId, { keyEnabled })} />
                <RolePicker value={t.keyRoles} label="Who may use it" onChange={(keyRoles) => save(t.agentId, { keyRoles })} /></div>
            </Row>
            {t.hasLogin && (
              <Row compact title={`${t.name}: shared team login`} hint={t.sharedLogin ? 'An admin signs in once; the allowed roles use that login.' : `${t.name}’s provider does not allow a subscription to be shared.`}>
                <div className="grid gap-2">
                  {t.loginPossible ? (
                    <>
                      <Switch label={`Shared team login for ${t.name}`} checked={t.loginEnabled} onChange={(loginEnabled) => save(t.agentId, { loginEnabled })} tone={t.sharedLogin ? undefined : 'caution'} />
                      <RolePicker value={t.loginRoles} label="Who may use it" onChange={(loginRoles) => save(t.agentId, { loginRoles })} />
                      {t.loginEnabled && acc?.flow && (
                        <div className="flex flex-wrap items-center gap-2"><Chip tone={t.loginSignedIn ? 'ok' : 'neutral'}>{t.loginSignedIn ? 'Team signed in' : 'Team not signed in'}</Chip>
                          <Button type="button" size="sm" variant={t.loginSignedIn ? 'outline' : 'default'} onClick={() => onSign(acc)}>{t.loginSignedIn ? 'Renew' : 'Sign the team in'}</Button>
                          {t.loginSignedIn && acc.canSignOut && <Button type="button" size="sm" variant="ghost" onClick={() => onOut(acc)}>Sign out</Button>}</div>
                      )}
                      {!t.sharedLogin && <Button type="button" size="sm" variant="ghost" className="justify-self-start text-muted-foreground" onClick={() => save(t.agentId, { loginEnabled: false, loginOverride: false })}>Stop allowing a shared login</Button>}
                    </>
                  ) : <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => setWarn(t)}>Allow anyway…</Button>}
                </div>
              </Row>
            )}
          </div>
        );
      })}
      <Err>{error || err}</Err>
      {warn && <ConfirmDialog title={`Share a ${warn.name} login anyway?`} body={`${warn.name}’s terms do not allow one personal subscription to be shared with a team. Doing it may break the provider’s terms, and the account can be banned. hefyn only mounts the login for the roles you choose; the provider decides what it allows. Use a team API key if you are not sure.`} action="I understand, allow it"
        onConfirm={() => { const t = warn; setWarn(undefined); void save(t.agentId, { loginOverride: true, acceptTermsRisk: true }); }} onClose={() => setWarn(undefined)} />}
    </Section>
  );
}

function RolePicker({ value, onChange, label }: { value: string[]; onChange: (v: string[]) => void; label: string }) {
  const roles = useQuery(() => trpc.roles.list.query());
  const all = roles.data?.roles ?? [];
  const text = !value.length ? 'Everyone with sandbox access' : value.map((id) => all.find((r) => r.id === id)?.name ?? id).join(', ');
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" type="button" aria-label={label} className="w-full justify-between font-normal" />}><span className="truncate">{text}</span><ChevronDown size={14} aria-hidden /></PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-1 p-2">
        {all.map((r) => (
          <label key={r.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-muted">
            <Checkbox checked={value.includes(r.id)} onCheckedChange={(on) => onChange(on ? [...value, r.id] : value.filter((x) => x !== r.id))} />{r.name}
          </label>
        ))}
        {!!value.length && <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={() => onChange([])}>Allow everyone</Button>}
      </PopoverContent>
    </Popover>
  );
}
