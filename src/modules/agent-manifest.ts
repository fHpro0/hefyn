import { z } from 'zod';
import { assertPublicUrl } from '../server/mcp.ts';

// The agent section of a module manifest (docs/MODULES.md "Agent modules"): a CLI coding agent hefyn can host, described as data. Nothing in it is executed
// by hefyn; it is interpreted by src/cli-agents/manifest-profile.ts. Strict: unknown keys, unknown placeholders, paths outside /tmp and anything that could
// send model traffic elsewhere than to {{gatewayBase}} are errors. (The sandbox has no network, so this is the second wall, not the first.)

export class AgentSpecError extends Error {
  path: string; reason: string;
  constructor(path: string, reason: string) { super(`${path ? path + ': ' : ''}${reason}`); this.path = path; this.reason = reason; }
}
const bad = (path: string, reason: string): never => { throw new AgentSpecError(path, reason); };

/** Files shipped in the sandbox image (services/sandbox-image) that a manifest may point to, as {{shim.<name>}}. */
export const SHIMS = ['codex-shim.mjs'] as const;
export const SHIM_DIR = '/opt/hefyn';
/** `{{theme}}` and `{{assistant.model}}` are empty when the browser sent no theme / the conversation has no Assistant model: the key or line they sit in is left out. */
const COMMON = ['gatewayBase', 'dummyKey', 'installDir', ...SHIMS.map((s) => `shim.${s}`)];
/** `{{provider.id}}`: the provider the session runs on (`anthropic` / `openai` unless a model provider was chosen); always has a value. */
const FILE = [...COMMON.filter((v) => v !== 'installDir'), 'theme', 'assistant.model', 'provider.id'];
/** `{{server.name}}` / `{{server.url}}`: one MCP server of the session (its name, and its address on the model bridge: the real address and credentials never enter the sandbox). `{{helper.script}}`: the wrapper script of a helper (see `helperAllow`). */
export const VARS = { env: COMMON, file: FILE, server: [...FILE, 'server.name', 'server.url'], helper: ['helper.script'], headless: ['installDir'],
  terminal: ['installDir'], resume: ['installDir', 'sessionId'], wrapper: ['installDir', 'sessionId'] } as const;
type Where = keyof typeof VARS;

const text = (max: number) => z.string().min(1).max(max);
const ID = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'must be 2-32 characters: lowercase letters, digits and -');
const NPM_NAME = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const NPM_PIN = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/; // the runner's rule (services/runner/src/logic.ts)
const REL = z.string().max(200).regex(/^[\w.@-]+(\/[\w.@-]+)*$/, 'must be a relative path').refine((p) => !p.split('/').some((s) => s === '..' || s === '.'), 'must stay inside the install');
const PLATFORM = /^linux-(x86_64|aarch64)$/;

const file = z.strictObject({
  path: z.string().max(200),
  format: z.enum(['json-merge', 'json', 'text']), // json-merge: into what is there (`force`: ours wins, else what is there wins); json: replaced; text: replaced
  force: z.boolean().optional(), indent: z.number().int().min(0).max(8).optional(),
  when: z.literal('assistant').optional(), // only when the conversation runs an Assistant
  content: z.union([z.record(z.string(), z.unknown()), z.array(z.string().max(2000)).max(200)]), // an object for json*, lines for text
});

/** The wire APIs of hefyn's gateway: Anthropic Messages, OpenAI Responses and OpenAI chat completions (what OpenRouter, Mistral, Groq, DeepSeek, xAI and custom endpoints speak). */
export const WIRE_APIS = ['anthropic', 'openai-responses', 'openai-chat'] as const;

const spec = {
  icon: z.string().max(500).optional(),
  license: text(60).optional(), licenseUrl: z.string().max(500).optional(),
  distribution: z.union([
    z.strictObject({ registry: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'not an ACP Registry id') }),
    z.strictObject({ version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/), npm: text(214) }),
    z.strictObject({ version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/), binary: z.record(z.string(), z.strictObject({ archive: z.string().max(1000), sha256: z.string() })) }),
  ]),
  // Where the agent's own version is, when the registry's version is that of an adapter: a JSON file in the install (path relative to it) and the field to read.
  // Without it the registry's version is shown as the agent's. (A `command` form, running `--version` in the sandbox, is not supported.)
  cliVersion: z.strictObject({ packageJson: REL, field: z.string().regex(/^[A-Za-z]\w{0,40}$/).default('version') }).optional(),
  api: z.enum(['anthropic', 'openai-responses']),
  asksBeforeActing: z.boolean(),
  launch: z.union([
    z.strictObject({ npm: z.strictObject({ package: z.string().max(214), bin: z.string().regex(/^[\w.-]{1,100}$/), extra: z.array(z.string().max(214)).max(4).optional(), check: z.array(REL).max(8).optional() }) }),
    z.strictObject({ binary: z.strictObject({ cmd: z.string().regex(/^\.\/[\w.-]+(\/[\w.-]+)*$/, 'must look like ./name'), args: z.array(text(200)).max(10).default([]) }) }),
    // The agent's own, unmodified CLI in a PTY: the chat is built from its hooks and transcript (docs/WRAPPER.md), not from ACP. `terminal.command` is the launch
    // script and may use {{sessionId}}; hefyn always has one (`--session-id` first, `--resume` after: the script decides). Only Claude Code has an adapter for this today.
    z.strictObject({ wrapper: z.strictObject({ adapter: z.literal('claude-code'), npm: z.strictObject({ package: z.string().max(214), extra: z.array(z.string().max(214)).max(4).optional(), check: z.array(REL).max(8).optional() }) }) }),
  ]),
  terminal: z.strictObject({
    command: text(2000), // the shell script of the terminal view for a new session
    resume: z.strictObject({ sessionId: z.enum(['uuid', 'opencode']), command: text(2000) }).optional(), // used instead when the conversation has a session id of that shape
  }),
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'must be upper case letters, digits and _'), z.string().max(1000)).default({}),
  // commandsDir: where the agent reads slash commands (markdown files); without it the Assistants-as-tools are written as skills in skillsDir
  config: z.strictObject({ dir: z.string().max(200), instructionsFile: z.string().regex(/^[\w.-]{1,64}$/), skillsDir: z.string().max(200), commandsDir: z.string().max(200).optional(), mcpConfig: text(200) }),
  files: z.array(file).max(10).default([]),
  // Where the agent takes the session's MCP servers (an Assistant's, or the user's own and team's that are switched on): the file is written once per server, with
  // {{server.name}} and {{server.url}} (a text file: appended to the file at that path). `{ unsupported: true }`: the agent has no MCP support (the console says so).
  mcpServers: z.union([z.strictObject({ unsupported: z.literal(true) }), file]).optional(),
  // How another agent runs this one headless in the same sandbox and folder (a "helper"): a shell snippet that execs the CLI; the task arrives as "$@". hefyn wraps it in a script
  // with the agent's `env` and its model routing. Without it the agent cannot be a helper.
  // `command` is the form that may edit files without asking; `readOnly` the form that cannot (the default for a helper); without `readOnly` the agent is only used where edits are allowed.
  headless: z.strictObject({ command: text(2000), readOnly: text(2000).optional() }).optional(),
  // What this agent needs so it may run a helper's script unasked: `rule` is written once per helper into `path` (json-merge: into the array at `at`; text: a line appended).
  helperAllow: z.strictObject({ path: z.string().max(200), format: z.enum(['json-merge', 'text']), at: z.array(z.string().regex(/^\w{1,40}$/)).max(4).optional(), rule: text(300) }).optional(),
  // Which model providers the agent can run on, by the API it speaks to them, and how to seed each: `files` are written after the common `files` when the session's
  // provider is served by that API. Must list `api` (the default). Without it the agent runs on `api` only (Claude Code: anthropic; Codex: openai-responses).
  providers: z.array(z.strictObject({ api: z.enum(WIRE_APIS), files: z.array(file).max(10).default([]) })).min(1).max(3).optional(),
};

// How a person signs in to the agent with their own account (Settings, Agent accounts; src/cli-agents/agent-login.ts). hefyn runs `command` in the user's sandbox, shows the
// sign-in address (and device code) it prints, and asks `status` whether it worked. It never reads what the login writes into the account home.
const SHELL = z.string().min(1).max(1000);
const PATTERN = z.string().max(200).refine((p) => { try { new RegExp(p); return true; } catch { return false; } }, 'not a valid regular expression');
const loginSchema = z.strictObject({
  // code: the CLI prints an address and then asks for a code the page shows (pasted back into its prompt); device: it prints an address and a code to type on that page;
  // terminal: no scriptable flow (menus), the user gets the CLI's own terminal.
  flow: z.enum(['code', 'device', 'terminal']),
  command: SHELL,
  // The account home: the agent's config/data dir env var, and where it is in the sandbox (default /accounts/<id>; a per-user directory on the data volume).
  home: z.strictObject({ env: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), dir: z.string().regex(/^\/(accounts|[a-z]+-home)(\/[\w.-]+)?$/).optional(), subdir: z.string().regex(/^[\w.-]+(\/[\w.-]+)*$/).optional() }),
  // How to tell whether someone is signed in: json = stdout is JSON, `signedIn` is the field that is true (`account`: fields that make the label); text = `signedIn` is a regex
  // on stdout; exit = exit code 0; file = the file (relative to the home) exists and is not empty (checked in the sandbox with `test -s`).
  status: z.strictObject({ format: z.enum(['json', 'text', 'exit', 'file']), command: SHELL.optional(), signedIn: z.string().max(200).optional(), account: z.array(z.string().regex(/^\w{1,40}$/)).max(3).optional() }),
  logout: SHELL.optional(),
  urlPattern: PATTERN.optional(), codePattern: PATTERN.optional(),
  // The hosts (host:443) the sign-in and the model traffic on that account may reach through hefyn's egress proxy. verified: checked against the installed CLI.
  hosts: z.array(z.string().regex(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}:443$/)).min(1).max(8),
  verified: z.boolean().default(false),
});
export type LoginSpec = z.output<typeof loginSchema>;

// sharedLogin: the provider's terms allow one login to be shared by a team (default no; Claude Code and Codex: no). An admin can still switch it on after a warning (team-accounts.ts).
const accountFields = { sharedLogin: z.boolean().default(false), login: loginSchema.optional() };
export const specSchema = z.strictObject({ ...spec, ...accountFields });
export type AgentSpec = z.output<typeof specSchema>;
/** The standalone form: what an admin pastes on the Agents page, and what the built-in agents are written in. `kind: "agent"` is what tells it from a module manifest. */
export const agentSchema = z.strictObject({ kind: z.literal('agent'), id: ID, name: text(60), version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/, 'invalid version').optional(), description: text(500), ...spec, ...accountFields });
export type AgentManifest = z.output<typeof agentSchema>;

// ---- placeholders ----
const PH = /\{\{([^{}]*)\}\}/g;
/** Every `{{...}}` of s, checked against the vocabulary of `where`. Returns [name, json filter] pairs. */
function placeholders(s: string, where: Where, path: string): [string, boolean][] {
  const out: [string, boolean][] = [];
  for (const m of s.matchAll(PH)) {
    const [name, filter, ...rest] = m[1]!.split('|');
    if (rest.length || (filter !== undefined && filter !== 'json')) bad(path, `unknown filter in {{${m[1]}}} (only |json exists)`);
    if (!(VARS[where] as readonly string[]).includes(name!)) bad(path, `unknown placeholder {{${name}}}. Allowed here: ${VARS[where].map((v) => `{{${v}}}`).join(', ')}`);
    out.push([name!, filter === 'json']);
  }
  if (s.replace(PH, '').includes('{{') || s.replace(PH, '').includes('}}')) bad(path, 'a stray {{ or }}');
  return out;
}
const NET = /:\/\/|(^|[^\w.])www\./i;
const noNetwork = (s: string, path: string) => { if (NET.test(s.replace(PH, ''))) bad(path, 'network addresses are not allowed: model traffic goes to {{gatewayBase}} only'); };

const under = (p: string, dir: string, path: string) => { if (!p.startsWith(dir + '/')) bad(path, `must be a path under ${dir}`); }; // after tmpPath: no .. in either
const tmpPath = (p: string, path: string) => {
  if (!/^\/tmp\/[^\0]+$/.test(p) || p.split('/').slice(1).some((s) => s === '..' || s === '.' || s === '')) bad(path, 'must be a path under /tmp (without .. or empty parts)');
};

const REDIRECT = /URL|URI|HOST|ENDPOINT|PROXY|BASE|ORIGIN|SERVER|DOMAIN/;
const SECRET = /KEY|TOKEN|SECRET|PASSWORD|AUTH/;
const FORBIDDEN_ENV = new Set(['HEFYN_SEED', 'HEFYN_ATTACH', 'HEFYN_BRIDGE_PORT', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PATH', 'BASH_ENV', 'ENV', 'SHELLOPTS']);

function checkEnv(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) {
    const path = `env.${k}`;
    if (FORBIDDEN_ENV.has(k)) bad(path, 'this variable cannot be set by an agent module');
    placeholders(v, 'env', path);
    if (v.includes('|json')) bad(path, 'the |json filter is for files only');
    noNetwork(v, path);
    if (REDIRECT.test(k) && !/^\{\{gatewayBase\}\}(\/[\w./-]*)?$/.test(v)) bad(path, 'a variable like this can send model traffic elsewhere: its value must be {{gatewayBase}} (optionally followed by a path)');
    if (SECRET.test(k) && v !== '{{dummyKey}}') bad(path, 'the only key an agent gets is {{dummyKey}}');
    if (v.startsWith('/')) tmpPath(v, path);
  }
}

// JSON content: strings are templates, `$when` makes an object empty unless its variable has a value, `$schema` strings are labels (never fetched).
function checkJson(x: unknown, path: string, where: Where, depth = 0): void {
  if (depth > 8) bad(path, 'nested too deeply');
  if (typeof x === 'string') {
    if (x.length > 2000) bad(path, 'too long');
    placeholders(x, where, path);
    if (x.includes('|json')) bad(path, 'the |json filter is for text files only');
    noNetwork(x, path);
  } else if (Array.isArray(x)) x.forEach((v, i) => checkJson(v, `${path}.${i}`, where, depth + 1));
  else if (x && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') bad(`${path}.${k}`, 'forbidden key');
      if (k === '$when') { if (v !== 'theme' && v !== 'assistant.model') bad(`${path}.$when`, 'must be "theme" or "assistant.model"'); continue; }
      if (k === '$schema' && typeof v === 'string') continue;
      if (k.includes('{') || k.includes('}')) { placeholders(k, where, `${path}.${k}`); noNetwork(k, `${path}.${k}`); } // a key may be a template too (a provider block named {{provider.id}})
      checkJson(v, `${path}.${k}`, where, depth + 1);
    }
  } else if (typeof x === 'number' && !Number.isFinite(x)) bad(path, 'not a number');
}

/** Everything the schema cannot say. Throws AgentSpecError (path relative to the spec). */
export function checkSpec(s: AgentSpec): void {
  for (const [k, p] of [['icon', s.icon], ['licenseUrl', s.licenseUrl]] as const) if (p !== undefined) { try { if (!assertPublicUrl(p).startsWith('https://')) throw 0; } catch { bad(k, 'must be a public https address'); } }
  const npmL = 'npm' in s.launch ? s.launch.npm : 'wrapper' in s.launch ? s.launch.wrapper.npm : undefined, d = s.distribution, pkg = npmL?.package;
  if (pkg !== undefined && !NPM_NAME.test(pkg)) bad('launch.npm.package', 'not an npm package name (without a version)');
  for (const [i, x] of (npmL?.extra ?? []).entries()) if (!NPM_PIN.test(x)) bad(`launch.npm.extra.${i}`, 'must be pinned to an exact version, such as name@1.2.3');
  if ('npm' in d) {
    if (!NPM_PIN.test(d.npm)) bad('distribution.npm', 'must be pinned to an exact version, such as name@1.2.3');
    if (pkg === undefined) bad('launch', 'an npm distribution needs launch.npm');
    else if (d.npm.slice(0, d.npm.lastIndexOf('@')) !== pkg) bad('distribution.npm', `is not the package launch.npm.package names (${pkg})`);
  } else if ('binary' in d) {
    if (!('binary' in s.launch)) bad('launch', 'a binary distribution needs launch.binary');
    const plats = Object.entries(d.binary);
    if (!plats.length) bad('distribution.binary', 'needs at least one platform');
    for (const [plat, e] of plats) {
      const at = `distribution.binary.${plat}`;
      if (!PLATFORM.test(plat)) bad(at, 'only linux-x86_64 and linux-aarch64 are supported');
      if (!/^[0-9a-f]{64}$/.test(e.sha256)) bad(`${at}.sha256`, 'missing or malformed: hefyn installs nothing it cannot verify (64 hex characters)');
      try { const u = new URL(assertPublicUrl(e.archive)); if (u.protocol !== 'https:' || u.username || u.password) throw 0; } catch { bad(`${at}.archive`, 'must be a public https address without credentials'); }
    }
  }
  tmpPath(s.config.dir, 'config.dir'); tmpPath(s.config.skillsDir, 'config.skillsDir');
  under(s.config.skillsDir, s.config.dir, 'config.skillsDir');
  checkEnv(s.env);
  if (s.login) for (const [at, c] of [['login.command', s.login.command], ['login.status.command', s.login.status.command], ['login.logout', s.login.logout]] as const) if (c !== undefined) { placeholders(c, 'terminal', at); noNetwork(c, at); }
  if (s.login) {
    const st = s.login.status;
    if (st.format === 'file' ? !st.signedIn || !/^[\w.-]+(\/[\w.-]+)*$/.test(st.signedIn) || st.signedIn.includes('..') : !st.command) bad('login.status', st.format === 'file' ? 'a file status needs `signedIn`: a relative path in the account home' : 'needs a command');
    if ((st.format === 'json' || st.format === 'text') && !st.signedIn) bad('login.status.signedIn', 'is required');
  }
  placeholders(s.terminal.command, 'wrapper' in s.launch ? 'wrapper' : 'terminal', 'terminal.command');
  if (s.terminal.resume) placeholders(s.terminal.resume.command, 'resume', 'terminal.resume.command');
  for (const [p, c] of [['terminal.command', s.terminal.command], ['terminal.resume.command', s.terminal.resume?.command ?? '']] as const) noNetwork(c, p);
  if (s.config.commandsDir !== undefined) { tmpPath(s.config.commandsDir, 'config.commandsDir'); under(s.config.commandsDir, s.config.dir, 'config.commandsDir'); }
  const checkFile = (f: AgentSpec['files'][number], at: string, where: Where) => {
    tmpPath(f.path, `${at}.path`); under(f.path, s.config.dir, `${at}.path`);
    if (f.format === 'text') {
      if (!Array.isArray(f.content)) bad(`${at}.content`, 'a text file needs a list of lines');
      (f.content as string[]).forEach((line, n) => {
        const ph = placeholders(line, where, `${at}.content.${n}`);
        noNetwork(line, `${at}.content.${n}`);
        for (const [name, json] of ph) if ((name === 'assistant.model' || name === 'provider.id' || name === 'server.url') && !json) bad(`${at}.content.${n}`, `write {{${name}|json}} so the value is quoted safely`);
      });
      if (f.force !== undefined || f.indent !== undefined) bad(at, 'force and indent are for JSON files');
    } else {
      if (Array.isArray(f.content)) bad(`${at}.content`, 'a JSON file needs an object');
      checkJson(f.content, `${at}.content`, where);
      if (f.format === 'json' && f.force !== undefined) bad(`${at}.force`, 'only json-merge has force');
      if (f.format === 'json-merge' && f.indent !== undefined) bad(`${at}.indent`, 'only json has indent');
    }
  };
  s.files.forEach((f, i) => checkFile(f, `files.${i}`, 'file'));
  if (s.providers) {
    if (!s.providers.some((p) => p.api === s.api)) bad('providers', `must list the agent's own api (${s.api})`);
    if (new Set(s.providers.map((p) => p.api)).size !== s.providers.length) bad('providers', 'an api is listed twice');
    s.providers.forEach((p, i) => p.files.forEach((f, j) => checkFile(f, `providers.${i}.files.${j}`, 'file')));
  }
  if (s.mcpServers && !('unsupported' in s.mcpServers)) {
    checkFile(s.mcpServers, 'mcpServers', 'server');
    if (s.mcpServers.when) bad('mcpServers.when', 'the MCP servers are written for every conversation');
  }
  if (s.headless) { placeholders(s.headless.command, 'headless', 'headless.command'); noNetwork(s.headless.command, 'headless.command');
    if (s.headless.readOnly) { placeholders(s.headless.readOnly, 'headless', 'headless.readOnly'); noNetwork(s.headless.readOnly, 'headless.readOnly'); } }
  if (s.helperAllow) {
    tmpPath(s.helperAllow.path, 'helperAllow.path'); under(s.helperAllow.path, s.config.dir, 'helperAllow.path');
    placeholders(s.helperAllow.rule, 'helper', 'helperAllow.rule');
    if (s.helperAllow.format === 'text' && s.helperAllow.at) bad('helperAllow.at', '`at` is for json-merge');
    if (s.helperAllow.format === 'json-merge' && !s.helperAllow.at?.length) bad('helperAllow.at', 'json-merge needs `at`, the path of the list');
  }
}

const issue = (e: z.ZodError) => {
  const i = e.issues[0]!;
  if (i.code === 'unrecognized_keys') return { path: [...i.path, i.keys[0]!].join('.'), message: 'unknown key' };
  return { path: i.path.join('.'), message: i.code === 'invalid_union' ? 'is not one of the allowed forms (see docs/MODULES.md, Agent modules)' : i.message };
};

/** The agent section of a module manifest (already a plain object). */
export function parseSpec(raw: unknown): AgentSpec {
  const r = specSchema.safeParse(raw);
  if (!r.success) { const i = issue(r.error); bad(i.path, i.message); }
  checkSpec(r.data!);
  return r.data!;
}

/** The standalone manifest (`kind: "agent"`). */
export function parseAgentManifest(raw: unknown): AgentManifest {
  const r = agentSchema.safeParse(raw);
  if (!r.success) { const i = issue(r.error); bad(i.path, i.message); }
  const { kind: _k, id: _i, name: _n, version: _v, description: _d, ...rest } = r.data!;
  checkSpec(specSchema.parse(rest));
  return r.data!;
}
