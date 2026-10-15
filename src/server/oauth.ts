import { randomBytes } from 'node:crypto';
import type { OAuthAuth, ProviderAuthInteraction } from '@earendil-works/pi-ai';
import { CompanyCredentialStore, DbCredentialStore, oauthOf } from './connectors.ts';
import { withStamp } from './context.ts';

// Web adaptation of pi-ai's CLI login flows. The flow runs server-side exactly as in the CLI; its prompts and
// notifications are surfaced to the browser: auth URL / device code out, pasted code or redirect URL in.
// Flows are bound to the user who started them, single-use and expire after 10 minutes.

const TTL = 10 * 60_000;
interface Flow {
  id: string; userId: string; provider: string; scope: 'me' | 'company'; startedAt: number; used: boolean;
  state: 'pending' | 'done' | 'error'; error?: string;
  authUrl?: string; device?: { userCode: string; verificationUrl: string; expiresInSeconds?: number };
  paste?: (v: string) => void; abort: AbortController; settled: Promise<void>;
}
const flows = new Map<string, Flow>();

function sweep() {
  for (const [id, f] of flows) if (Date.now() - f.startedAt > TTL) { f.abort.abort(); flows.delete(id); }
}
const find = (userId: string, id: string) => { sweep(); const f = flows.get(id); return f && f.userId === userId ? f : undefined; };
export const flowStatus = (userId: string, id: string) => { const f = find(userId, id); return f && { state: f.state, error: f.error }; };

/** `oauth` is injectable for tests; production uses the provider's own pi-ai flow. */
export async function startFlow(userId: string, provider: string, oauth: OAuthAuth | undefined = oauthOf(provider), scope: 'me' | 'company' = 'me') {
  if (!oauth) throw new Error(`${provider} has no OAuth login`);
  sweep();
  const abort = new AbortController();
  let ready!: () => void;
  const first = new Promise<void>((r) => (ready = r));
  const f = { id: randomBytes(24).toString('base64url'), userId, provider, scope, startedAt: Date.now(), used: false, state: 'pending', abort } as Flow;
  const interaction: ProviderAuthInteraction = {
    signal: abort.signal,
    notify(e) {
      if (e.type === 'auth_url') { f.authUrl = e.url; ready(); }
      else if (e.type === 'device_code') { f.device = { userCode: e.userCode, verificationUrl: e.verificationUri, expiresInSeconds: e.expiresInSeconds }; ready(); }
    },
    async prompt(p) {
      if (p.type === 'select') return (p.options.find((o) => /copy|device|headless|code/i.test(o.id)) ?? p.options[0]).id; // browser-less login methods
      if (p.type !== 'manual_code') return ''; // e.g. enterprise domain: default
      return new Promise<string>((res, rej) => { f.paste = res; p.signal?.addEventListener('abort', () => rej(new Error('cancelled'))); abort.signal.addEventListener('abort', () => rej(new Error('cancelled'))); });
    },
  };
  f.settled = withStamp('auth', () => oauth.login(interaction, { agentName: 'hefyn' })) // login flows talk to token endpoints only
    .then((cred) => (scope === 'company' ? new CompanyCredentialStore() : new DbCredentialStore(userId)).modify(provider, async () => cred)) // company: the provider is then available to everyone
    .then(() => { f.state = 'done'; }, (e) => { f.state = 'error'; f.error = (e as Error).message; })
    .finally(ready);
  flows.set(f.id, f);
  await Promise.race([first, new Promise((r) => setTimeout(r, 8000).unref())]);
  if (f.state === 'error') throw new Error(f.error);
  return { flowId: f.id, authUrl: f.authUrl, device: f.device, needsPaste: !f.device, state: f.state };
}

/** The user pastes the authorization code or the redirect URL (providers with a fixed redirect URI). */
export async function completeFlow(userId: string, id: string, input: string) {
  const f = find(userId, id);
  if (!f) throw Object.assign(new Error('unknown or expired sign-in'), { status: 404 });
  if (f.used || f.state !== 'pending' || !f.paste) throw Object.assign(new Error('this sign-in was already used'), { status: 409 });
  f.used = true; // single use, even when the code turns out to be wrong
  f.paste(input.trim());
  await Promise.race([f.settled, new Promise((r) => setTimeout(r, 30_000).unref())]);
  return { state: f.state as Flow['state'], error: f.error };
}

/** Redirect target for flows whose redirect URI points at hefyn: resolved by the `state` of the auth URL. */
export function callbackFlow(userId: string, state: string, fullUrl: string) {
  sweep();
  const f = [...flows.values()].find((x) => x.userId === userId && x.authUrl && new URL(x.authUrl).searchParams.get('state') === state);
  if (!f) throw Object.assign(new Error('unknown or expired sign-in'), { status: 404 });
  return completeFlow(userId, f.id, fullUrl);
}
