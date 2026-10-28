import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trpcCall } from './trpc.ts';

// Agent -> Provider -> Model: the manifest's `providers` and {{provider.id}}, what OpenCode and Pi are seeded with on two providers, what assistants.options offers per agent,
// the agent step's validation, and the admin's default model per agent. The gateway front is in cli-gateway-chat.test.ts; the agents themselves in cli-agent-providers.test.ts (Docker).
process.env.HEFYN_DATA_DIR = mkdtempSync(join(tmpdir(), 'hefyn-agentprov-'));
process.env.HEFYN_SECRET = 'agent-providers-secret-agent-providers-12';
process.env.HEFYN_RUNNER_URL = 'http://127.0.0.1:1'; // configured, never called
process.env.HEFYN_INTERNAL_TOKEN = 'agent-providers-token-agent-providers-0123456789';

const { Hono } = await import('hono');
const { db } = await import('../src/server/appdb.ts');
const { auth } = await import('../src/server/auth.ts');
const { api } = await import('../src/server/api.ts');
const vault = await import('../src/server/vault.ts');
const { connect } = await import('../src/server/providers.ts');
const { parseManifest, ManifestError } = await import('../src/modules/manifest.ts');
const { acpLaunch, profileOf, terminalLaunch } = await import('../src/cli-agents/profiles.ts');
const { defaultProvider, providerApis, wireFor } = await import('../src/cli-agents/providers.ts');
const { simpleFlow } = await import('../src/assistants/flow.ts');
await import('../src/server/hub.ts');
vault.setTeamKey(vault.newKey());

const app = new Hono().route('/api', api);
async function mk(email: string, role: string) {
  const r = await auth.api.signUpEmail({ body: { name: email, email, password: 'password-12345' } });
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.user.id, role);
  const cookie = (await auth.api.signInEmail({ body: { email, password: 'password-12345' }, returnHeaders: true })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  vault.rememberUserKey(r.user.id, vault.newKey());
  return { id: r.user.id, trpc: (proc: string, input?: unknown, mutate = false) => trpcCall((p, i) => app.request(p, i), cookie, proc, input, mutate) };
}

/** What the sandbox ends up with at `path`: seed.mjs semantics (text replaces, json merges, objects deep, arrays replaced). */
function applied(seeds: any[], path: string) {
  const merge = (a: any, b: any): any => (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b) ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, k in b ? (k in a ? merge(a[k], b[k]) : b[k]) : a[k]])) : b);
  let cur: any = {};
  for (const s of seeds.filter((x) => x.path === path)) cur = 'text' in s ? JSON.parse(s.text) : merge(cur, s.json);
  return cur;
}
const seeds = (id: string, sel: { model: string | null; provider?: string | null } | undefined, terminal = false) => {
  const p = profileOf(id)!;
  return JSON.parse((terminal ? terminalLaunch(p, '1.0.0', null, undefined, undefined, sel) : acpLaunch(p, '1.0.0', undefined, sel)).env.HEFYN_SEED) as any[];
};

test('providers: which API serves which provider, and which agent speaks which API', () => {
  assert.deepEqual([providerApis('anthropic'), providerApis('openai'), providerApis('openrouter'), providerApis('mistral'), providerApis('custom'), providerApis('google')], [['anthropic'], ['openai-responses', 'openai-chat'], ['openai-chat'], ['openai-chat'], ['openai-chat'], []]);
  assert.deepEqual([defaultProvider('anthropic'), defaultProvider('openai-responses')], ['anthropic', 'openai']);
  const w = (id: string, prov: string) => wireFor(profileOf(id)!.spec, prov);
  assert.deepEqual(['claude-acp', 'codex-acp', 'opencode', 'pi-acp'].map((a) => ['anthropic', 'openai', 'openrouter', 'google'].map((p) => w(a, p))), [
    ['anthropic', undefined, undefined, undefined], // Claude Code: Anthropic only
    [undefined, 'openai-responses', undefined, undefined], // Codex: OpenAI (Responses) only
    ['anthropic', 'openai-chat', 'openai-chat', undefined],
    ['anthropic', 'openai-chat', 'openai-chat', undefined],
  ]);
});

test('OpenCode on two providers: its own provider block, enabled_providers, model and small_model; Anthropic stays as it was', () => {
  const none = applied(seeds('opencode', undefined), '/tmp/.config/opencode/opencode.json');
  assert.deepEqual([none.enabled_providers, none.model, none.provider.anthropic.options.baseURL, none.permission.bash, none.autoupdate], [['anthropic'], undefined, 'http://127.0.0.1:47000/v1', 'ask', false]);
  assert.equal(applied(seeds('opencode', { model: 'claude-x' }), '/tmp/.config/opencode/opencode.json').model, 'anthropic/claude-x');
  for (const [prov, model] of [['openrouter', 'acme/model-x'], ['mistral', 'mistral-large']] as const) for (const term of [false, true]) {
    const c = applied(seeds('opencode', { model, provider: prov }, term), '/tmp/.config/opencode/opencode.json');
    assert.deepEqual(c.enabled_providers, [prov]);
    assert.equal(c.model, `${prov}/${model}`); assert.equal(c.small_model, `${prov}/${model}`, 'the title request must not pick a model the provider may not have');
    assert.deepEqual(Object.keys(c.provider), [prov], 'only the session\'s provider: nothing else can be called');
    assert.deepEqual(c.provider[prov], { npm: '@ai-sdk/openai-compatible', name: prov, options: { baseURL: 'http://127.0.0.1:47000/v1', apiKey: 'hefyn-gateway' }, models: { [model]: { name: model } } });
    assert.equal(c.permission.edit, 'ask'); assert.equal(c.share, 'disabled');
  }
  assert.throws(() => seeds('opencode', { model: 'm', provider: 'google' }), /cannot run on the provider "google"/);
  assert.throws(() => seeds('opencode', { model: 'm', provider: 'a"b' }), /cannot run on the provider/);
});

test('Pi on two providers: models.json names the provider\'s base URL and API, settings.json the default', () => {
  const p = '/tmp/.pi/agent';
  assert.deepEqual(applied(seeds('pi-acp', undefined), `${p}/models.json`), { providers: { anthropic: { baseUrl: 'http://127.0.0.1:47000' } } });
  assert.deepEqual(applied(seeds('pi-acp', { model: 'claude-x' }), `${p}/settings.json`), { defaultProvider: 'anthropic', defaultModel: 'claude-x' });
  const m = applied(seeds('pi-acp', { model: 'acme/model-x', provider: 'openrouter' }), `${p}/models.json`);
  assert.deepEqual(m, { providers: { openrouter: { baseUrl: 'http://127.0.0.1:47000/v1', api: 'openai-completions', apiKey: 'hefyn-gateway', models: [{ id: 'acme/model-x' }] } } });
  assert.deepEqual(applied(seeds('pi-acp', { model: 'acme/model-x', provider: 'openrouter' }), `${p}/settings.json`), { defaultProvider: 'openrouter', defaultModel: 'acme/model-x' });
  assert.deepEqual(applied(seeds('pi-acp', { model: null, provider: 'mistral' }), `${p}/models.json`).providers.mistral.models, [], 'no model: no empty entry');
});

test('Claude Code and Codex take no other provider', () => {
  assert.throws(() => seeds('claude-acp', { model: 'm', provider: 'openrouter' }), /cannot run on the provider "openrouter"/);
  assert.throws(() => seeds('codex-acp', { model: 'm', provider: 'anthropic' }), /cannot run on the provider "anthropic"/);
  assert.ok(seeds('codex-acp', { model: 'm', provider: 'openai' }).length > 0);
});

const good = (over: Record<string, unknown> = {}): any => ({
  kind: 'agent', id: 'acme-agent', name: 'Acme Agent', description: 'Acme\'s coding agent.', distribution: { version: '1.2.3', npm: 'acme-acp@1.2.3' }, api: 'anthropic', asksBeforeActing: true,
  launch: { npm: { package: 'acme-acp', bin: 'acme-acp' } }, terminal: { command: 'exec {{installDir}}/node_modules/.bin/acme' }, env: { ACME_HOME: '/tmp/.acme' },
  config: { dir: '/tmp/.acme', instructionsFile: 'AGENTS.md', skillsDir: '/tmp/.acme/skills', mcpConfig: 'x' },
  providers: [{ api: 'anthropic' }, { api: 'openai-chat', files: [{ path: '/tmp/.acme/c.json', format: 'json-merge', content: { providers: { '{{provider.id}}': { baseUrl: '{{gatewayBase}}/v1', model: '{{assistant.model}}' } } } }] }],
  ...over,
});
const refused = (m: unknown, re: RegExp) => assert.throws(() => parseManifest(m), (e: any) => e instanceof ManifestError && re.test(e.message), `expected ${re}`);

test('manifest: providers and {{provider.id}} (also as a key) are validated strictly', () => {
  assert.ok(parseManifest(good()).cliAgent);
  refused(good({ providers: [{ api: 'openai-chat' }] }), /providers: must list the agent's own api/);
  refused(good({ providers: [{ api: 'anthropic' }, { api: 'anthropic' }] }), /listed twice/);
  refused(good({ providers: [{ api: 'gemini' }] }), /providers/);
  refused(good({ providers: [{ api: 'anthropic', files: [{ path: '/etc/x', format: 'json', content: {} }] }] }), /providers\.0\.files\.0\.path/);
  refused(good({ providers: [{ api: 'anthropic', files: [{ path: '/tmp/.acme/x.json', format: 'json', content: { a: { '{{secret}}': 1 } } }] }] }), /unknown placeholder \{\{secret\}\}/);
  refused(good({ providers: [{ api: 'anthropic', files: [{ path: '/tmp/.acme/x.json', format: 'json', content: { 'https://evil.example.com/{{provider.id}}': 1 } }] }] }), /network addresses/);
  refused(good({ providers: [{ api: 'anthropic', files: [{ path: '/tmp/.acme/x.toml', format: 'text', content: ['p = "{{provider.id}}"'] }] }] }), /\{\{provider\.id\|json\}\}/);
  refused(good({ env: { ACME_X: '{{provider.id}}' } }), /unknown placeholder \{\{provider\.id\}\}/); // not in the environment
});

// ---------- options, validation, defaults ----------
db.prepare("INSERT INTO roles (id, name, builtin, permissions) VALUES ('auditor', 'Auditor', 0, ?)").run(JSON.stringify(['models.use']));
const admin = await mk('admin@prov.test', 'admin');
connect({ id: 'anthropic' }, 'sk-ant-company');
connect({ id: 'openrouter' }, 'sk-or-company');
connect({ id: 'custom', baseUrl: 'http://127.0.0.1:9/v1', models: ['local-1', 'local-2'] }, 'sk-custom');
db.prepare("INSERT INTO providers (id, name, enc_key, created_at, kind) VALUES ('mistral', 'Mistral', 'x', 'now', 'oauth')").run(); // a sign-in is no API key
for (const [id, v] of [['claude-acp', '0.96.0'], ['codex-acp', '0.12.0'], ['opencode', '1.19.4'], ['pi-acp', '0.0.34']]) db.prepare("INSERT INTO cli_agents (id, version, status, enabled, roles, installed_at) VALUES (?, ?, 'ready', 1, '[]', 'now')").run(id, v);

test('assistants.options: per agent the connected API-key providers it can use, with models; the Agent -> Provider -> Model lists', async () => {
  const o = (await admin.trpc('assistants.options')).json;
  const by = Object.fromEntries(o.agents.map((a: any) => [a.id, a]));
  assert.equal(by.null, undefined, 'there is no hefyn agent any more: only installed CLI agents');
  assert.deepEqual(by['claude-acp'].providers.map((p: any) => [p.id, p.connected]), [['anthropic', true]]);
  assert.ok(by['claude-acp'].providers[0].models.length > 5 && by['claude-acp'].providers[0].models.every((m: any) => !m.id.includes('/')), 'bare model ids');
  assert.ok('contextWindow' in by['claude-acp'].providers[0].models[0] && 'reasoning' in by['claude-acp'].providers[0].models[0]);
  const codex = by['codex-acp'].providers;
  assert.equal(codex.length, 1); assert.deepEqual([codex[0].id, codex[0].connected, codex[0].models.length], ['openai', false, 0]);
  assert.match(codex[0].reason, /No OpenAI API key is connected/);
  assert.deepEqual(by.opencode.providers.map((p: any) => p.id), ['anthropic', 'custom', 'openrouter'], 'the agent\'s own first; Mistral is a sign-in and Google has no OpenAI-compatible API');
  assert.deepEqual(by.opencode.providers.find((p: any) => p.id === 'custom').models.map((m: any) => m.id), ['local-1', 'local-2']);
  assert.ok(by.opencode.providers.find((p: any) => p.id === 'openrouter').models.length > 20);
  assert.deepEqual(by['pi-acp'].providers.map((p: any) => p.id), ['anthropic', 'custom', 'openrouter']);
});

const base = { name: 'A', description: '', icon: 'FileText', inputs: { images: 'off', maxImageEdge: 1568, imageQuality: 0.8, documents: false, maxUploadMb: 25 }, roles: [] };
const save = (over: Record<string, unknown>) => admin.trpc('assistants.save', { ...base, ...over }, true);

test('an agent step is checked per agent, provider and model, in plain words; the old shape (model without provider) still reads', async () => {
  const models = (await admin.trpc('assistants.options')).json.agents.find((a: any) => a.id === 'opencode').providers;
  const orModel = models.find((p: any) => p.id === 'openrouter').models[0].id, antModel = models.find((p: any) => p.id === 'anthropic').models[0].id;
  assert.equal((await save({ agent: 'opencode', provider: 'openrouter', model: orModel })).status, 200);
  assert.equal((await save({ agent: 'opencode', provider: 'custom', model: 'local-2' })).status, 200);
  assert.equal((await save({ agent: 'opencode', provider: 'anthropic', model: antModel })).status, 200);
  assert.equal((await save({ agent: 'opencode', model: antModel })).status, 200, 'saved before providers existed: Anthropic');
  assert.equal((await save({ agent: 'opencode', provider: 'openrouter' })).status, 200, 'the provider\'s default model');
  const err = async (over: Record<string, unknown>) => { const r = await save(over); assert.equal(r.status, 400, JSON.stringify(over)); return r.error!; };
  assert.match(await err({ agent: 'opencode', provider: 'openrouter', model: 'no/such-model' }), /cannot use the model .* on openrouter/i);
  assert.match(await err({ agent: 'opencode', provider: 'custom', model: orModel }), /cannot use the model/);
  assert.match(await err({ agent: 'opencode', provider: 'mistral', model: 'm' }), /no API key is connected for Mistral|Mistral/);
  assert.match(await err({ agent: 'opencode', provider: 'google', model: 'm' }), /cannot run on that provider/);
  assert.match(await err({ agent: 'claude-acp', provider: 'openrouter', model: orModel }), /Claude Code cannot run on that provider/);
  assert.match(await err({ agent: 'codex-acp', provider: 'openai', model: 'gpt-x' }), /no API key is connected for OpenAI/);
  assert.match(await err({ agent: 'codex-acp', model: 'gpt-x' }), /cannot use the model/);
  assert.match(await err({ agent: null, provider: 'openrouter', model: null }), /Pick an agent/);
  assert.equal((await save({ agent: 'opencode', provider: 7 })).status, 400);
});

test('agents.update: a default provider and model per agent (both or neither, checked), shown in the catalog', async () => {
  const or = (await admin.trpc('assistants.options')).json.agents.find((a: any) => a.id === 'opencode').providers.find((p: any) => p.id === 'openrouter').models[0].id;
  const upd = (input: object) => admin.trpc('agents.update', { id: 'opencode', ...input }, true);
  assert.equal((await upd({ defaultProvider: 'openrouter', defaultModel: or })).status, 200);
  const item = ((await admin.trpc('agents.catalog')).json as any[]).find((a) => a.id === 'opencode');
  assert.deepEqual([item.defaultProvider, item.defaultModel], ['openrouter', or]);
  assert.equal((await upd({ defaultModel: null })).status, 400, 'a provider without a model');
  assert.equal((await upd({ defaultProvider: 'google', defaultModel: 'x' })).status, 400);
  assert.equal((await upd({ defaultProvider: 'openrouter', defaultModel: 'no/such' })).status, 400);
  assert.equal((await upd({ keyProvider: 'openrouter' })).status, 200, 'the key pin may name any provider the agent can use');
  assert.equal((await upd({ keyProvider: 'google' })).status, 400);
  assert.equal((await admin.trpc('agents.update', { id: 'claude-acp', keyProvider: 'openrouter' }, true)).status, 400);
  assert.equal((await upd({ defaultProvider: null, defaultModel: null })).status, 200);
  assert.deepEqual(Object.keys((await admin.trpc('agents.models')).json).sort(), ['claude-acp', 'codex-acp', 'opencode', 'pi-acp']);
});
