import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { allowed, authOk, createProxy, keyOf } from '../services/egress/src/server.ts';

const TOKEN = 'egress-test-token-0123456789abcdef0123456789';
const basic = (t: string) => 'Basic ' + Buffer.from('hefyn:' + t).toString('base64');
const listen = (s: http.Server | net.Server) => new Promise<number>((ok) => s.listen(0, '127.0.0.1', () => ok((s.address() as AddressInfo).port)));

async function stack() {
  const upstream = http.createServer((_q, r) => r.end('from-upstream'));
  const echo = net.createServer((s) => s.on('data', (d) => s.write(d)));
  const [up, ec] = [await listen(upstream), await listen(echo)];
  const list = { hosts: [keyOf('127.0.0.1', up), keyOf('127.0.0.1', ec)] };
  const listing = http.createServer((_q, r) => r.end(JSON.stringify(list)));
  const lp = await listen(listing);
  const { server, refresh } = createProxy({ port: 0, token: TOKEN, allowlistUrl: `http://127.0.0.1:${lp}/`, refreshMs: 1000 }, () => {});
  await refresh();
  const port = await listen(server);
  return { up, ec, port, close: () => [upstream, echo, listing, server].forEach((s) => s.close()) };
}
const viaProxy = (port: number, url: string, auth?: string) => new Promise<{ status: number; body: string }>((ok, fail) => {
  const u = new URL(url);
  const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url, headers: { host: u.host, ...(auth ? { 'proxy-authorization': auth } : {}) } }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => ok({ status: r.statusCode!, body: b })); });
  req.on('error', fail); req.end();
});
const connect = (port: number, target: string, auth?: string) => new Promise<{ status: number; socket: net.Socket }>((ok, fail) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: target, headers: auth ? { 'proxy-authorization': auth } : {} });
  req.on('connect', (res, socket) => ok({ status: res.statusCode!, socket }));
  req.on('response', (res) => { res.resume(); ok({ status: res.statusCode!, socket: res.socket }); });
  req.on('error', fail); req.end();
});

test('egress: token required, allowlist enforced for plain HTTP and CONNECT', async () => {
  const s = await stack();
  try {
    assert.equal((await viaProxy(s.port, `http://127.0.0.1:${s.up}/`)).status, 407);
    assert.equal((await viaProxy(s.port, `http://127.0.0.1:${s.up}/`, basic('wrong'))).status, 407);
    const ok = await viaProxy(s.port, `http://127.0.0.1:${s.up}/x`, basic(TOKEN));
    assert.deepEqual([ok.status, ok.body], [200, 'from-upstream']);
    assert.equal((await viaProxy(s.port, 'http://127.0.0.1:9/', basic(TOKEN))).status, 403); // not allowlisted
    assert.equal((await connect(s.port, `127.0.0.1:${s.ec}`)).status, 407);
    assert.equal((await connect(s.port, 'example.com:443', basic(TOKEN))).status, 403);
    const t = await connect(s.port, `127.0.0.1:${s.ec}`, basic(TOKEN));
    assert.equal(t.status, 200);
    const echoed = await new Promise<string>((ok2) => { t.socket.once('data', (d) => ok2(String(d))); t.socket.write('ping'); });
    assert.equal(echoed, 'ping');
    t.socket.destroy();
  } finally { s.close(); }
});

test('egress: helpers, and Node fetch honours NODE_USE_ENV_PROXY (the way the agent container uses it)', async () => {
  assert.ok(authOk(basic(TOKEN), TOKEN) && !authOk(basic('x'), TOKEN) && !authOk(undefined, TOKEN) && !authOk('Bearer abc', TOKEN));
  const set = new Set(['api.anthropic.com:443']);
  assert.ok(allowed(set, 'api.anthropic.com', 443) && !allowed(set, 'api.anthropic.com', 80) && !allowed(set, 'evil.example', 443));
  assert.ok(allowed(set, 'hefyn-pw-0123456789abcdef', 8931) && !allowed(set, 'hefyn-pw-0123456789abcdef', 22) && !allowed(set, 'hefyn-pw-xyz', 8931));

  const s = await stack();
  try {
    // async spawn: the proxy lives in this process and must keep serving
    const run = (url: string) => new Promise<string>((ok) => execFile(process.execPath, ['-e', `fetch(${JSON.stringify(url)}).then(async r => console.log(r.status, await r.text()), e => console.log('ERR', e.cause?.code ?? e.message))`], {
      env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: `http://hefyn:${TOKEN}@127.0.0.1:${s.port}`, HTTPS_PROXY: `http://hefyn:${TOKEN}@127.0.0.1:${s.port}` } }, (_e, out) => ok(out.trim())));
    assert.equal(await run(`http://127.0.0.1:${s.up}/`), '200 from-upstream');
    assert.match(await run('http://blocked.invalid/'), /^403 /);
  } finally { s.close(); }
});

// The proxy cannot tell users apart, so one user's connector must not widen the allowlist beyond what its OAuth flow calls.
test('allowlist: only the OAuth endpoints of a connector are taken from its stored state, https only, never any URL found in it', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  process.env.HEFYN_DATA_DIR ??= mkdtempSync(`${tmpdir()}/hefyn-egl-`);
  const { discoveryUrls } = await import('../src/server/egress-list.ts');
  const secrets = JSON.stringify({
    bearer: 'https://exfil.example/steal', client: { client_id: 'c', redirect_uris: ['https://evil.example/cb'], client_uri: 'https://evil.example/' },
    discovery: { authorizationServerUrl: 'https://auth.example.com', resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
      authorizationServerMetadata: { issuer: 'https://auth.example.com', token_endpoint: 'https://auth.example.com/token', authorization_endpoint: 'https://login.example.com/authorize', registration_endpoint: 'http://plain.example.com/register', service_documentation: 'https://docs.evil.example/', jwks_uri: 'https://keys.evil.example/jwks' },
      resourceMetadata: { authorization_servers: ['https://auth.example.com', 'https://second-as.example.org'], resource_documentation: 'https://docs.evil.example/' } } });
  assert.deepEqual(discoveryUrls(secrets).sort(), ['https://auth.example.com', 'https://auth.example.com', 'https://auth.example.com', 'https://auth.example.com/token', 'https://login.example.com/authorize', 'https://mcp.example.com/.well-known/oauth-protected-resource', 'https://second-as.example.org'].sort());
  assert.deepEqual(discoveryUrls(''), []);
  assert.deepEqual(discoveryUrls('{"bearer":"https://exfil.example/"}'), []);
  assert.deepEqual(discoveryUrls('{"discovery":"https://exfil.example/"}'), []);
});
