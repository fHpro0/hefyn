import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Tiny MCP server over streamable HTTP (JSON responses) with one tool, `lookup`, that returns an email address.
// Auth: `Bearer bearer-ok` always works; OAuth (discovery, dynamic client registration, PKCE) issues at-N / rt-N tokens.
export const seen: { auth: string; method: string }[] = [];
export const oauth = { registered: 0, codes: new Map<string, { challenge: string; used: boolean }>(), refreshes: 0, valid: new Set<string>(), expiresIn: 3600 };

export function startFakeMcp(): Promise<{ url: string; close: () => void }> {
  let base = '';
  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = new URL(req.url!, base);
      const form = () => Object.fromEntries(new URLSearchParams(raw));
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource') return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server') || url.pathname.startsWith('/.well-known/openid-configuration')) {
        return json(res, 200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
      }
      if (url.pathname === '/register') { oauth.registered++; return json(res, 201, { ...JSON.parse(raw), client_id: 'fake-client' }); }
      if (url.pathname === '/authorize') {
        const code = 'code-' + randomUUID();
        oauth.codes.set(code, { challenge: url.searchParams.get('code_challenge')!, used: false });
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state')!);
        return void res.writeHead(302, { location: back.toString() }).end();
      }
      if (url.pathname === '/token') {
        const f = form();
        if (f.grant_type === 'authorization_code') {
          const c = oauth.codes.get(f.code);
          const ok = c && !c.used && createHash('sha256').update(f.code_verifier ?? '').digest('base64url') === c.challenge;
          if (!ok) return json(res, 400, { error: 'invalid_grant' });
          c.used = true;
          oauth.valid.add('at-1');
          return json(res, 200, { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: oauth.expiresIn });
        }
        if (f.grant_type === 'refresh_token' && f.refresh_token === 'rt-1') {
          oauth.refreshes++;
          const at = `at-${oauth.refreshes + 1}`;
          oauth.valid.add(at);
          return json(res, 200, { access_token: at, refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600 });
        }
        return json(res, 400, { error: 'invalid_grant' });
      }
      if (url.pathname !== '/mcp') return json(res, 404, {});
      const auth = req.headers.authorization ?? '';
      seen.push({ auth, method: req.method! });
      if (auth !== 'Bearer bearer-ok' && !oauth.valid.has(auth.replace('Bearer ', ''))) {
        return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
      }
      if (req.method !== 'POST') return void res.writeHead(405).end();
      const m = JSON.parse(raw);
      if (m.id === undefined) return void res.writeHead(202).end(); // notification
      const result =
        m.method === 'initialize' ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
        : m.method === 'tools/list' ? { tools: [{ name: 'lookup', description: 'Look up a contact', inputSchema: { type: 'object', properties: {} } }] }
        : m.method === 'tools/call' ? { content: [{ type: 'text', text: 'Contact: mcp-person@acme-corp.example' }] }
        : {};
      json(res, 200, { jsonrpc: '2.0', id: m.id, result });
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; ok({ url: base, close: () => server.close() }); }));
}
