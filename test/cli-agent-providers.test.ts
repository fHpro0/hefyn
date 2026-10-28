import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { skip, startStack } from './cli-agent-stack.ts';

// Integration (real Docker): OpenCode and Pi in the real sandbox on a provider that is not Anthropic or OpenAI. A stand-in "openrouter" (an OpenAI-compatible upstream at a base URL
// registered in this test's own data dir) is the connected provider; the agent's session is configured for it (the admin's default provider and model for the agent), its config is
// seeded with that provider, and a turn goes through hefyn's own gateway handler at /v1/chat/completions, and the agent's own key
// ("hefyn-gateway") never reaches the upstream. A request the sandbox sends to the other fronts is refused.
const TOKEN = 'cli-prov-token-cli-prov-token-cli-prov-0123456789ab';
const run = Math.random().toString(36).slice(2, 8);
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-cliprov-'));
process.env.HEFYN_SECRET = 'cli-prov-secret-cli-prov-secret-1234567890';
process.env.HEFYN_INTERNAL_TOKEN = TOKEN;

const EMAIL = 'ada.lovelace@example.com';
const MODEL = 'acme/model-x';

for (const agent of ['opencode', 'pi-acp'] as const) {
  test(`integration: ${agent} runs a turn on an OpenAI-compatible provider through the chat completions front`, { skip, timeout: 900_000 }, async (t) => {
    let host: { closeAll(): Promise<void> } | undefined, upstream: ReturnType<typeof Bun.serve> | undefined;
    t.after(async () => { await host?.closeAll().catch(() => {}); upstream?.stop(true); });
    const stack = await startStack(t, { run: `${run}-${agent.slice(0, 2)}`, token: TOKEN });
    const { registry } = await import('../src/cli-agents/registry.ts');
    const { installRequest } = await import('../src/cli-agents/installed.ts');
    const { profileOf } = await import('../src/cli-agents/profiles.ts');
    const entry = (await registry()).agents.find((a) => a.id === agent)!;
    assert.deepEqual(await stack.install(installRequest(entry, profileOf(agent)!)), { state: 'ready' });

    // the stand-in provider: records what reaches it and answers with the address it was sent, as a stream
    const seen: { path: string; auth: string; body: any; raw: string }[] = [];
    const sse = (parts: object[]) => new Response(parts.map((p) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: MODEL, ...p })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    upstream = Bun.serve({ port: 0, hostname: '0.0.0.0', async fetch(req: Request) {
      const raw = await req.text(), u = new URL(req.url);
      if (!u.pathname.endsWith('/chat/completions')) return new Response('{}', { status: 404 });
      const body = JSON.parse(raw);
      seen.push({ path: u.pathname, auth: String(req.headers.get('authorization')), body, raw });
      const ph = raw.includes(EMAIL) ? EMAIL : 'nobody';
      const text = `Got ${ph}.`, half = Math.ceil(text.length / 2); // split across two deltas
      return sse([{ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }, { choices: [{ index: 0, delta: { content: text.slice(0, half) }, finish_reason: null }] }, { choices: [{ index: 0, delta: { content: text.slice(half) }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } }]);
    } });

    const vault = await import('../src/server/vault.ts');
    const { db } = await import('../src/server/appdb.ts');
    const { connect } = await import('../src/server/providers.ts');
    const { CliHost } = await import('../src/cli-agents/host.ts');
    const { runnerAttach } = await import('../src/cli-agents/attach.ts');
    vault.setTeamKey(vault.newKey()); vault.rememberUserKey('alice', vault.newKey());
    connect({ id: 'openrouter', baseUrl: `http://127.0.0.1:${upstream.port}/v1` }, 'sk-or-company');
    db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at, default_provider, default_model) VALUES (?, ?, 'ready', 1, '[]', ?, 'openrouter', ?)").run(agent, entry.version, new Date().toISOString(), MODEL);
    const conv = `u_alice_01PV${run}${agent.slice(0, 2)}`;
    db.prepare("INSERT INTO conversations (id, user_id, title, created_at, agent, view) VALUES (?, 'alice', 'x', ?, ?, 'chat')").run(conv, new Date().toISOString(), agent);
    const h = new CliHost({ attach: runnerAttach({ url: stack.runnerUrl, token: TOKEN }), listenModel: (u, c, handler) => stack.listenModel(u, c, handler) }); // hefyn's own front on the socket
    host = h;
    const s = h.session('alice', conv), events: any[] = [];
    s.subscribe(0, (e) => events.push(e));
    const until = async (f: () => boolean, what: string, ms = 120_000) => { for (let i = 0; i < ms / 50 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(f(), `timeout: ${what}; events: ${JSON.stringify(events.slice(-6)).slice(0, 2500)}`); };

    s.prompt(`Please write to ${EMAIL} and say hello.`);
    await until(() => events.some((e) => e.update.hefyn === 'turn_end'), 'turn_end');
    const end = events.find((e) => e.update.hefyn === 'turn_end').update;
    assert.equal(end.stopReason, 'end_turn', JSON.stringify(events.filter((e) => e.update.hefyn === 'error')));
    const said = events.filter((e) => e.update.sessionUpdate === 'agent_message_chunk').map((e) => e.update.content.text).join('');
    assert.ok(said.includes(`Got ${EMAIL}.`), `the answer arrives in one piece: ${said}`);

    const main = seen.find((r) => r.body.tools?.length) ?? seen.at(-1)!;
    assert.equal(main.path, '/v1/chat/completions');
    assert.equal(main.auth, 'Bearer sk-or-company', 'the connected key, not the agent\'s');
    assert.equal(main.body.model, MODEL, 'the session\'s model');
    assert.ok(seen.every((r) => r.body.model === MODEL), `every request (the title one too) names the chosen model: ${seen.map((r) => r.body.model)}`);
    const u = db.prepare('SELECT provider, model FROM usage WHERE conversation_id = ?').get(conv) as any;
    assert.deepEqual([u.provider, u.model], ['openrouter', MODEL]);

    // the sandbox cannot reach another provider by choosing another front: the session decides
    const sbx = stack.docker('ps', '-q', '--filter', `label=hefyn.conversation=${conv}`).trim().split('\n')[0];
    // asynchronous: the socket's handler lives in this process, a blocking exec would starve it
    const probe = async (path: string) => (await promisify(execFile)('docker', ['exec', sbx, 'node', '-e', `fetch('http://127.0.0.1:47000${path}',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log(r.status))`])).stdout.trim();
    assert.equal(await probe('/v1/messages'), '400'); assert.equal(await probe('/v1/responses'), '400');
  });
}
