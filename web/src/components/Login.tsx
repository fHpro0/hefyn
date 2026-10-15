import { api } from './api';
import { AuthCard } from './Setup';
import { useEffect } from 'react';

export default function Login() {
  useEffect(() => { api('/api/setup/status').then((s) => s.needsSetup && (location.href = '/setup')); }, []);
  return <AuthCard title="Sign in" hint="Use the account your admin set up for you." button="Sign in" fields={['email', 'password']}
    onSubmit={async (v) => {
      await api('/api/auth/sign-in/email', 'POST', { email: v.email, password: v.password }).catch(() => { throw new Error('That email or password is not right. Check them and try again.'); });
      location.href = '/';
    }} />;
}
