import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OAuthAuth } from '@earendil-works/pi-ai';

// A fake OAuth server: authorization code + PKCE (S256), single-use codes, refresh tokens.
export function fakeServer() {
  const codes = new Map<string, { challenge: string; used: boolean }>();
  let refreshes = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/authorize') { codes.set('code-1', { challenge: url.searchParams.get('code_challenge')!, used: false }); return void res.end('{}'); }
      const f = Object.fromEntries(new URLSearchParams(raw));
      if (f.grant_type === 'authorization_code') {
        const c = codes.get(f.code);
        if (!c || c.used || createHash('sha256').update(f.code_verifier ?? '').digest('base64url') !== c.challenge) return void res.writeHead(400).end('{"error":"invalid_grant"}');
        c.used = true;
        return void res.end(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }));
      }
      if (f.grant_type === 'refresh_token' && f.refresh_token === 'refresh-1') return void res.end(JSON.stringify({ access_token: `access-${++refreshes + 1}`, refresh_token: 'refresh-1', expires_in: 3600 }));
      res.writeHead(400).end('{"error":"invalid_grant"}');
    });
  });
  return new Promise<{ url: string; close: () => void; refreshes: () => number }>((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), refreshes: () => refreshes })));
}

export const fakeOAuth = (base: string): OAuthAuth => ({
  name: 'Fake',
  async login(interaction) {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(8).toString('hex');
    const url = new URL('/authorize', base);
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('state', state);
    await fetch(url); // the real authorization server would show a consent page; here it just records the challenge
    interaction.notify({ type: 'auth_url', url: url.toString() });
    const pasted = await interaction.prompt({ type: 'manual_code', message: 'paste' });
    const code = pasted.includes('code=') ? new URL(pasted).searchParams.get('code')! : pasted;
    const r = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier }) });
    if (!r.ok) throw new Error('token exchange failed');
    const t: any = await r.json();
    return { type: 'oauth', access: t.access_token, refresh: t.refresh_token, expires: Date.now() + t.expires_in * 1000 };
  },
  async refresh(c) {
    const r = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh }) });
    if (!r.ok) throw new Error('invalid_grant');
    const t: any = await r.json();
    return { type: 'oauth', access: t.access_token, refresh: t.refresh_token, expires: Date.now() + t.expires_in * 1000 };
  },
  toAuth: async (c) => ({ apiKey: c.access }),
});

