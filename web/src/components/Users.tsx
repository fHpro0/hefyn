import { Users as UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { api, useLoad } from './api';
import Shell from './Shell';
import { buttonPrimary, Empty, Err, Field, Input, Page, Row, Section, Select, Table, toast } from './ui';

interface User { id: string; email: string; name: string; roleId: string }
interface Roles { roles: { id: string; name: string }[] }

export default function Users() {
  return <Shell>{() => <Content />}</Shell>;
}

function Content() {
  const users = useLoad<User[]>('/api/users');
  const roles = useLoad<Roles>('/api/roles');
  const [err, setErr] = useState('');
  const roleOptions = roles.data?.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>);
  return (
    <Page title="Users" hint="Signups are closed. You create accounts and decide what each person can do.">
      <Section>
        <Row title="Add a person" hint="Create the account with a temporary password and share it with them directly.">
          <form className="grid gap-3" onSubmit={async (e) => {
            e.preventDefault(); setErr('');
            const form = e.currentTarget;
            try { await api('/api/users', 'POST', Object.fromEntries(new FormData(form) as any)); toast('User added'); form.reset(); users.reload(); } catch (x) { setErr((x as Error).message); }
          }}>
            <Field label="Name"><Input name="name" required /></Field>
            <Field label="Email"><Input name="email" type="email" required /></Field>
            <Field label="Temporary password"><Input name="password" type="text" required minLength={8} autoComplete="off" /></Field>
            <Field label="Role"><Select key={roles.data ? "loaded" : "loading"} name="roleId" defaultValue="worker">{roleOptions}</Select></Field>
            <Err>{err}</Err>
            <div><button className={buttonPrimary}>Add user</button></div>
          </form>
        </Row>
      </Section>
      <Section title="People">
        {users.data && !users.data.length ? <Empty icon={<UsersIcon size={26} />}>No one else has an account yet.</Empty> : (
          <Table head={['Name', 'Email', 'Role']}>
            {users.data?.map((u) => (
              <tr key={u.id}><td className="font-medium">{u.name}</td><td className="text-soft">{u.email}</td>
                <td className="w-52"><Select aria-label={`Role of ${u.email}`} value={u.roleId} onChange={async (e) => {
                  try { await api(`/api/users/${u.id}/role`, 'PATCH', { roleId: e.target.value }); toast('Role updated'); } catch (x) { toast((x as Error).message, true); }
                  users.reload();
                }}>{roleOptions}</Select></td></tr>
            ))}
          </Table>
        )}
      </Section>
    </Page>
  );
}
