import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { skip, startStack } from './cli-agent-stack.ts';

// Integration (real Docker): agents installed from the ACP Registry by the runner's installer container into the hefyn-agents volume, and each one's first
// model request reaching the model socket. The socket's handler is a recording stand-in (not the gateway: that is test/cli-agent-wrapper.test.ts for
// Claude Code and test/cli-gateway*.test.ts); what is proved here is the profile: base URL, dummy key, no other way out.
const TOKEN = 'cli-inst-token-cli-inst-token-cli-inst-token-0123456789';
const run = Math.random().toString(36).slice(2, 8);
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-cliinst-'));
process.env.HEFYN_SECRET = 'cli-inst-secret-cli-inst-secret-1234567890';
process.env.HEFYN_INTERNAL_TOKEN = TOKEN;

test('integration: install from the registry (checksums, scripts off, read-only in the sandbox) and first model request per agent', { skip, timeout: 1_800_000 }, async (t) => {
  let host: { closeAll(): Promise<void> } | undefined;
  t.after(async () => { await host?.closeAll().catch(() => {}); });
  const stack = await startStack(t, { run, token: TOKEN });
  const { docker, IMAGE, AGENTS, runner, install } = stack;

  const { registry } = await import('../src/cli-agents/registry.ts');
  const { installRequest } = await import('../src/cli-agents/installed.ts');
  const { profileOf } = await import('../src/cli-agents/profiles.ts');
  const entries = (await registry()).agents;
  const entry = (id: string) => structuredClone(entries.find((a) => a.id === id)!);
  const request = (id: string, tweak?: (e: ReturnType<typeof entry>) => void) => { const e = entry(id); tweak?.(e); return installRequest(e, profileOf(id)!); };
  const inVolume = (cmd: string) => docker('run', '--rm', '-v', `${AGENTS}:/a:ro`, IMAGE, 'sh', '-c', cmd).trim();

  await t.test('a checksum that does not match is refused, and nothing is installed', async () => {
    const bad = request('opencode', (e) => { for (const p of Object.values(e.distribution.binary!)) p.sha256 = '0'.repeat(64); });
    const r = await install(bad);
    assert.equal(r.state, 'failed'); assert.match(r.error!, /checksum/, JSON.stringify(r));
    assert.equal(inVolume('ls /a; ls /a/opencode 2>&1 || true').includes('1.19'), false);
    assert.equal((await runner('GET', `/agents/opencode/${entry('opencode').version}`)).json.state, 'failed');
  });

  await t.test('the runner refuses what the installer must not fetch', async () => {
    for (const body of [
      { id: 'x', version: '1', distribution: { npx: { package: 'left-pad' } } },
      { id: 'x', version: '1', distribution: { npx: { package: 'left-pad@latest' } } },
      { id: 'x', version: '1', distribution: { binary: { 'linux-x86_64': { archive: 'http://example.com/a.tar.gz', sha256: 'a'.repeat(64), cmd: './a' } } } },
      { id: 'x', version: '1', distribution: { binary: { 'linux-x86_64': { archive: 'https://example.com/a.tar.gz', cmd: './a' } } } },
      { id: '../x', version: '1', distribution: { npx: { package: 'a@1.0.0' } } },
    ]) assert.equal((await runner('POST', '/agents/install', body)).status, 400, JSON.stringify(body));
    assert.equal((await fetch(`${stack.runnerUrl}/agents/install`, { method: 'POST', body: '{}' })).status, 401, 'token required');
  });

  const versions: Record<string, string> = {};
  await t.test('installs: opencode (binary, sha256 verified), pi-acp (npm + pi), codex-acp (npm), claude-acp (npm)', async () => {
    const all = await Promise.all(['opencode', 'pi-acp', 'codex-acp', 'claude-acp'].map(async (id) => [id, await install(request(id))] as const));
    for (const [id, r] of all) { assert.deepEqual(r, { state: 'ready' }, `${id}: ${JSON.stringify(r)}`); versions[id] = entry(id).version; }
    assert.match(inVolume(`/a/opencode/${versions.opencode}/opencode --version`), /^1\.\d+\.\d+/);
    assert.match(inVolume(`/a/pi-acp/${versions['pi-acp']}/node_modules/.bin/pi --version`), /\d+\.\d+\.\d+/);
    assert.match(inVolume(`/a/codex-acp/${versions['codex-acp']}/node_modules/.bin/codex --version`), /^codex-cli \d+/);
    assert.equal(inVolume(`test -f /a/claude-acp/${versions['claude-acp']}/.hefyn-installed && echo marked`), 'marked');
    assert.equal(inVolume('ls -A /a | grep -c "^\\.tmp" || true'), '0', 'no temp dirs left behind');
    assert.equal(inVolume(`test -d /a/pi-acp/${versions['pi-acp']}/node_modules/@earendil-works/pi-coding-agent && echo there`), 'there');
    assert.equal(inVolume(`stat -c %U /a/opencode/${versions.opencode}/opencode`), 'root', 'owned by root: a sandbox (uid 1000) cannot change it');
  });

  await t.test('the installer container: no capabilities, read-only root, its own network, only the agents volume', () => {
    const ids = docker('ps', '-aq', '--filter', 'label=hefyn.installer', '--filter', `ancestor=${IMAGE}`).split('\n').filter(Boolean);
    assert.ok(ids.length >= 4);
    for (const id of ids) {
      const c = JSON.parse(docker('inspect', id))[0];
      assert.deepEqual(c.HostConfig.CapDrop, ['ALL']); assert.deepEqual(c.HostConfig.SecurityOpt, ['no-new-privileges:true']);
      assert.equal(c.HostConfig.ReadonlyRootfs, true); assert.equal(c.HostConfig.Privileged, false);
      assert.equal(c.HostConfig.NetworkMode, `hefyn-cli-inst-${run}`);
      assert.deepEqual(c.Mounts.map((m: any) => [m.Destination, m.RW, m.Type === 'volume' ? m.Name : m.Type]), [['/agents', true, AGENTS]]);
      assert.ok(!JSON.stringify(c.Config.Env).includes(TOKEN), 'no internal token in the installer');
    }
    const net = JSON.parse(docker('network', 'inspect', `hefyn-cli-inst-${run}`))[0];
    assert.equal(net.Internal, false); assert.equal(net.Options['com.docker.network.bridge.enable_icc'], 'false');
  });

  // ---- the first model request of each agent reaches the model socket, on the path of its front, with the dummy key ----
  const seen: { agent: string; path: string; key: string | null; auth: string | null }[] = [];
  let current = '';
  const sse = (events: [string, object][]) => events.map(([type, d]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`).join('');
  const standIn = async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname, raw = await req.text();
    seen.push({ agent: current, path, key: req.headers.get('x-api-key'), auth: req.headers.get('authorization') });
    if (path === '/v1/responses') return Response.json({ error: { message: 'stand-in: no model here', type: 'invalid_request_error', code: 'stand_in' } }, { status: 400 });
    if (path.endsWith('/count_tokens')) return Response.json({ input_tokens: 7 });
    let j: any = {}; try { j = JSON.parse(raw); } catch { /* not ours */ }
    const text = 'ok then';
    if (!j.stream) return Response.json({ id: 'm', type: 'message', role: 'assistant', model: j.model ?? 'x', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } });
    return new Response(sse([
      ['message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: j.model ?? 'x', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
      ['message_stop', {}],
    ]), { headers: { 'content-type': 'text/event-stream' } });
  };

  const vault = await import('../src/server/vault.ts');
  const { db } = await import('../src/server/appdb.ts');
  const { CliHost } = await import('../src/cli-agents/host.ts');
  const { runnerAttach } = await import('../src/cli-agents/attach.ts');
  vault.setTeamKey(vault.newKey()); vault.rememberUserKey('alice', vault.newKey());
  for (const [id, v] of Object.entries(versions)) db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES (?, ?, 'ready', 1, '[]', ?)").run(id, v, new Date().toISOString());
  // the socket's handler is the stand-in, not the gateway
  const listenModel = async (u: string, c: string) => stack.listenModel(u, c, standIn);
  const h = new CliHost({ attach: runnerAttach({ url: stack.runnerUrl, token: TOKEN }), listenModel });
  host = h;

  for (const [id, path, answers] of [['opencode', '/v1/messages', true], ['pi-acp', '/v1/messages', true], ['codex-acp', '/v1/responses', false]] as const) {
    await t.test(`${id}: its first model request goes through the socket to ${path}, with the dummy key`, async () => {
      const conv = `u_alice_01INST${id.replace(/\W/g, '')}${run}`;
      db.prepare("INSERT INTO conversations (id, user_id, title, created_at, agent, view) VALUES (?, 'alice', 'x', ?, ?, 'chat')").run(conv, new Date().toISOString(), id);
      const s = h.session('alice', conv), events: any[] = [];
      s.subscribe(0, (e) => events.push(e));
      current = id;
      s.prompt('Say ok.');
      const until = async (f: () => boolean, ms: number) => { for (let i = 0; i < ms / 100 && !f(); i++) await new Promise((r) => setTimeout(r, 100)); };
      await until(() => events.some((e) => e.update.hefyn === 'turn_end'), 180_000); // (/mcp requests are filtered below: the agent connects to hefyn's MCP server too)
      const mine = seen.filter((x) => x.agent === id && x.path !== '/mcp'), summary = JSON.stringify(events.map((e) => e.update.hefyn ? [e.update.hefyn, e.update.state ?? e.update.message ?? e.update.stopReason] : e.update.sessionUpdate));
      assert.ok(mine.length > 0, `no model request arrived; events: ${summary}`);
      assert.ok(mine.every((x) => x.path === path), `paths: ${JSON.stringify(mine.map((x) => x.path))}`);
      if (path === '/v1/messages') assert.ok(mine.every((x) => x.key === 'hefyn-gateway'), `the dummy key: ${JSON.stringify(mine)}`);
      else assert.ok(mine.every((x) => x.auth === 'Bearer hefyn-gateway'), `the dummy key: ${JSON.stringify(mine)}`);
      if (answers) {
        assert.equal(events.find((e) => e.update.hefyn === 'turn_end')?.update.stopReason, 'end_turn', summary);
        assert.ok(events.some((e) => e.update.sessionUpdate === 'agent_message_chunk' && /ok then/.test(e.update.content?.text ?? '')), `it answered: ${summary}`);
      }
      // no way around the socket: the sandbox has no network
      const sbx = docker('ps', '-q', '--filter', `label=hefyn.conversation=${conv}`).trim().split('\n')[0];
      const probe = docker('exec', sbx, 'sh', '-c', 'node -e "require(\'net\').connect(443,\'1.1.1.1\').on(\'connect\',()=>console.log(\'OPEN\')).on(\'error\',e=>console.log(\'closed\'))"; true').trim();
      assert.equal(probe, 'closed');
      await s.close();
    });
  }
  console.log('model requests per agent:', JSON.stringify(Object.fromEntries(['opencode', 'pi-acp', 'codex-acp'].map((a) => [a, seen.filter((x) => x.agent === a).map((x) => x.path)]))));
});
