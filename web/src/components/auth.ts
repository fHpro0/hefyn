import { passkeyClient } from '@better-auth/passkey/client';
import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

// Better Auth client: WebAuthn ceremonies and the 2FA calls. Everything else in the UI goes through api().
export const authClient = createAuthClient({ plugins: [twoFactorClient(), passkeyClient()] });

// Unwraps a Better Auth client result; throws Error(message) on failure.
export async function ok<T>(p: Promise<{ data: T | null; error: { message?: string; status?: number } | null }>, fallback = 'Something went wrong. Try again.'): Promise<T> {
  const r = await p;
  if (r.error || r.data === null) throw new Error(r.error?.message || fallback);
  return r.data;
}
