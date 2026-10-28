import { Users as UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { api, useLoad, useMe, useQuery } from './api';
import { trpc } from '@/lib/trpc';
import Shell from './Shell';
import { Button } from '@/ui/button';
import { Table } from './data';
import { ConfirmDialog } from './dialogs';
import { toast } from './toast';
import { Empty, Err, Field, Input, Loading, Page, Reveal, Row, Section, Select } from './ui';

interface User { id: string; email: string; name: string; roleId: string }

export default function Users() {
  return <Shell>{() => <Content />}</Shell>;
}

function Content() {
  const users = useQuery(() => trpc.users.list.query());
  const roles = useQuery(() => trpc.roles.list.query());
  const me = useMe();
  const status = useQuery(() => trpc.setup.status.query());
  const policy = useQuery(() => trpc.users.twoFactorPolicy.query());
  const team = useLoad<{ teamUnlocked: boolean; pending: { id: string; email: string; name: string }[] }>('/api/security/team-pending');
  const [err, setErr] = useState('');
  const [invite, setInvite] = useState(true);
  const [reset, setReset] = useState<User>();
  const mail = !!status.data?.mailConfigured;
  const roleOptions = roles.data?.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>);
  return (
    <Page title="Users" hint="Signups are closed. You create accounts and decide what each person can do.">
      <Section>
        <Row title="Require two-factor authentication" hint="People who are required must set up an authenticator app before they can use hefyn. Passkeys do not count.">
          <Select aria-label="Require two-factor authentication" value={policy.data?.policy ?? 'off'} disabled={!policy.data} onChange={async (e) => {
            try { await trpc.users.setTwoFactorPolicy.mutate({ policy: e.target.value as 'off' | 'admins' | 'everyone' }); toast('Policy saved'); } catch (x) { toast((x as Error).message, true); }
            policy.reload();
          }}><option value="off">Off</option><option value="admins">Admins only</option><option value="everyone">Everyone</option></Select>
        </Row>
        <Row title="Add a person" hint={mail ? 'Create the account and email them a link to set their own password.' : 'Create the account with a temporary password and share it with them directly.'}>
          <form className="grid gap-3" onSubmit={async (e) => {
            e.preventDefault(); setErr('');
            const form = e.currentTarget;
            try { await trpc.users.create.mutate({ ...Object.fromEntries(new FormData(form) as any) as { name: string; email: string; password?: string; roleId?: string }, invite: mail && invite }); toast(mail && invite ? 'Invite sent' : 'User added'); form.reset(); users.reload(); } catch (x) { setErr((x as Error).message); }
          }}>
            <Field label="Name"><Input name="name" required /></Field>
            <Field label="Email"><Input name="email" type="email" required /></Field>
            {mail && <label className="flex items-center gap-2 text-[13px] font-medium"><input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} />Send invite email</label>}
            {!(mail && invite) && <Field label="Temporary password"><Input name="password" type="text" required minLength={8} autoComplete="off" /></Field>}
            <Field label="Role"><Select key={roles.data ? "loaded" : "loading"} name="roleId" defaultValue={roles.data?.defaultRole ?? 'worker'}>{roleOptions}</Select></Field>
            <Err>{err}</Err>
            <div><Button type="submit">Add user</Button></div>
          </form>
        </Row>
      </Section>
      <Section title="People">
        <Reveal loading={!users.data && !users.error} fallback={<Loading shape="rows" />}>{users.data && !users.data.length ? <Empty icon={<UsersIcon size={26} />}>No one else has an account yet.</Empty> : (
          <Table head={['Name', 'Email', 'Role', '']}>
            {users.data?.map((u) => (
              <tr key={u.id}><td className="font-medium">{u.name}</td><td className="text-muted-foreground">{u.email}</td>
                <td className="w-52"><Select aria-label={`Role of ${u.email}`} value={u.roleId} onChange={async (e) => {
                  try { await trpc.users.setRole.mutate({ id: u.id, roleId: e.target.value }); toast('Role updated'); } catch (x) { toast((x as Error).message, true); }
                  users.reload();
                }}>{roleOptions}</Select></td>
                <td className="text-right">{u.id !== me?.id && <Button variant="outline" onClick={() => setReset(u)}>Reset two-factor</Button>}</td></tr>
            ))}
          </Table>
        )}</Reveal>
      </Section>
      {!!team.data?.pending.length && (
        <Section title="Grant access to team secrets">
          <Row title="Admins waiting for access" hint={team.data.teamUnlocked ? 'A new admin cannot open model keys, connectors and mail settings until another admin confirms them here.' : 'Team secrets are locked: unlock them first (an admin signs in, or use the team recovery key).'}>
            <ul className="grid gap-2">{team.data.pending.map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-[13px]"><span className="grow break-all">{p.name} ({p.email})</span>
                <Button variant="outline" disabled={!team.data?.teamUnlocked} onClick={async () => { try { await api('/api/security/team-grant', 'POST', { userId: p.id }); toast('Access granted'); team.reload(); } catch (x) { toast((x as Error).message, true); } }}>Grant access</Button></li>))}
            </ul>
          </Row>
        </Section>
      )}
      {reset && <ConfirmDialog title="Reset two-factor?" body={`${reset.email} loses their authenticator app, backup codes and passkeys. They sign in with their password and set up again.`} action="Reset"
        onClose={() => setReset(undefined)} onConfirm={async () => { try { await trpc.users.resetTwoFactor.mutate({ id: reset.id }); toast('Two-factor reset'); } catch (x) { toast((x as Error).message, true); } }} />}
    </Page>
  );
}
