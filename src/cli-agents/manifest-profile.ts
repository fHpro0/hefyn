import { SHIM_DIR, type AgentSpec } from '../modules/agent-manifest.ts';
import { PROVIDER_ID, defaultProvider, wireFor } from './providers.ts';
import type { AgentProfile, Seed } from './profiles.ts';

// Turns the agent section of a module manifest (validated by src/modules/agent-manifest.ts) into an AgentProfile: fills the placeholders, nothing else. No I/O.

export const DUMMY_KEY = 'hefyn-gateway'; // the gateway ignores it; the real key never enters the sandbox
const SESSION = { uuid: /^[0-9a-f-]{36}$/, opencode: /^ses_[A-Za-z0-9]+$/ } as const; // the shell only ever sees an id of the declared shape

interface Ctx { gatewayBase?: string; installDir: string; theme?: string; model?: string | null; sessionId?: string; provider?: string; server?: { name: string; url: string }; script?: string }
const value = (name: string, c: Ctx): string | undefined => {
  if (name === 'server.name') return c.server?.name;
  if (name === 'server.url') return c.server?.url;
  if (name === 'helper.script') return c.script;
  if (name === 'gatewayBase') return c.gatewayBase;
  if (name === 'dummyKey') return DUMMY_KEY;
  if (name === 'installDir') return c.installDir;
  if (name === 'theme') return c.theme || undefined;
  if (name === 'assistant.model') return c.model || undefined;
  if (name === 'sessionId') return c.sessionId;
  if (name === 'provider.id') return c.provider;
  if (name.startsWith('shim.')) return `${SHIM_DIR}/${name.slice(5)}`;
  return undefined;
};
/** The string with its placeholders filled; undefined if one of them has no value (the caller then leaves the key or line out). */
function fill(s: string, c: Ctx): string | undefined {
  let missing = false;
  const out = s.replace(/\{\{([^{}|]*)(\|json)?\}\}/g, (_m, name: string, json?: string) => {
    const v = value(name, c);
    if (v === undefined) { missing = true; return ''; }
    return json ? JSON.stringify(v) : v;
  });
  return missing ? undefined : out;
}
const unmet = (x: unknown, c: Ctx) => !!x && typeof x === 'object' && !Array.isArray(x) && '$when' in x && value(String((x as { $when: unknown }).$when), c) === undefined;
function fillJson(x: unknown, c: Ctx): unknown {
  if (typeof x === 'string') return fill(x, c);
  if (Array.isArray(x)) return x.flatMap((v) => { const r = fillJson(v, c); return r === undefined || unmet(v, c) ? [] : [r]; }); // an object whose $when is unmet leaves a list, as it leaves a key
  if (!x || typeof x !== 'object') return x;
  const o = x as Record<string, unknown>;
  if (unmet(o, c)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === '$when') continue;
    const key = k.includes('{{') ? fill(k, c) : k; // keys may be templates; one without a value is left out
    if (key === undefined) continue;
    const r = k === '$schema' && typeof v === 'string' ? v : fillJson(v, c);
    if (r !== undefined) out[key] = r;
  }
  return out;
}

/** A seed after the others: a text file at the path of an earlier text seed is appended to it (Codex: [mcp_servers.x] in config.toml), anything else is added. */
export function addSeed(seeds: Seed[], m: Seed) {
  const same = 'text' in m ? seeds.find((s): s is { path: string; text: string } => s.path === m.path && 'text' in s) : undefined;
  if (same && 'text' in m) same.text += `\n${m.text}`; else seeds.push(m);
}

export const supportsMcp = (spec: AgentSpec) => !!spec.mcpServers && !('unsupported' in spec.mcpServers);
const file = (f: Extract<NonNullable<AgentSpec['mcpServers']>, { path: string }>, c: Ctx): Seed => {
  if (f.format === 'text') return { path: f.path, text: (f.content as string[]).map((line) => fill(line, c)).filter((line) => line !== undefined).join('\n') };
  const json = fillJson(f.content, c) as Record<string, unknown>;
  return f.format === 'json-merge' ? { path: f.path, json, force: f.force ?? true } : { path: f.path, text: JSON.stringify(json, null, f.indent) };
};
/** The MCP servers of a session written the way the agent reads them. `url`: where the server is on the model bridge (the real address and credentials stay in hefyn). [] when the agent has no MCP support. */
export function mcpServerSeeds(spec: AgentSpec, servers: { name: string; url: string }[]): Seed[] {
  const f = spec.mcpServers;
  if (!f || 'unsupported' in f) return [];
  const at = f.format === 'json-merge' ? serverContainer(f.content) : undefined;
  if (at) { // one seed that also says where hefyn's entries live: seed.mjs removes the ones written earlier and no longer chosen, never the user's own
    const json: Record<string, unknown> = at.reduceRight<Record<string, unknown>>((inner, k) => ({ [k]: inner }), {});
    for (const server of servers) deepAssign(json, (file(f, { installDir: '', server }) as { json: Record<string, unknown> }).json);
    return [{ path: f.path, json, force: f.force ?? true, owns: at }];
  }
  const seeds: Seed[] = [];
  for (const server of servers) addSeed(seeds, file(f, { installDir: '', server }));
  return seeds;
}
/** The key path to the object whose keys are `{{server.name}}`s in a json file's template, or undefined. */
function serverContainer(x: unknown): string[] | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return;
  for (const [k, v] of Object.entries(x)) { if (k.includes('{{server.name}}')) return []; const r = serverContainer(v); if (r) return [k, ...r]; }
}
function deepAssign(a: Record<string, unknown>, b: Record<string, unknown>) {
  for (const [k, v] of Object.entries(b)) {
    if (k === '__proto__') continue;
    const cur = a[k];
    if (cur && v && typeof cur === 'object' && typeof v === 'object' && !Array.isArray(cur) && !Array.isArray(v)) deepAssign(cur as Record<string, unknown>, v as Record<string, unknown>); else a[k] = v;
  }
}
/** The shell snippet that runs the agent headless (`edit`: may change files without asking; else read-only), or undefined (the agent cannot be a helper in that mode). */
export const headlessSnippet = (spec: AgentSpec, installDir: string, edit = false) => {
  const c = edit ? spec.headless?.command : spec.headless?.readOnly;
  return c ? fill(c, { installDir }) : undefined;
};
/** The permission the agent needs to run the helper scripts unasked. */
export function helperAllowSeeds(spec: AgentSpec, scripts: string[]): Seed[] {
  const h = spec.helperAllow;
  if (!h || !scripts.length) return [];
  const rules = scripts.map((script) => fill(h.rule, { installDir: '', script })!);
  if (h.format === 'text') return [{ path: h.path, text: rules.join('\n') }];
  const json = (h.at ?? []).reduceRight<unknown>((inner, key) => ({ [key]: inner }), rules) as Record<string, unknown>;
  return [{ path: h.path, json, force: true }];
}

export function profileFromSpec(id: string, name: string, description: string, spec: AgentSpec): AgentProfile {
  const l = spec.launch, term = spec.terminal;
  return {
    registryId: id, name, description, api: spec.api, spec,
    ...(spec.asksBeforeActing ? {} : { actsWithoutAsking: true }),
    ...('npm' in l ? { npm: { package: l.npm.package, bin: l.npm.bin, ...(l.npm.extra ? { extra: l.npm.extra } : {}), ...(l.npm.check ? { check: l.npm.check } : {}) } }
      : 'wrapper' in l ? { wrapper: l.wrapper.adapter, npm: { package: l.wrapper.npm.package, bin: 'claude', ...(l.wrapper.npm.extra ? { extra: l.wrapper.npm.extra } : {}), ...(l.wrapper.npm.check ? { check: l.wrapper.npm.check } : {}) } }
      : { binary: { cmd: l.binary.cmd, args: l.binary.args } }),
    configDir: spec.config.dir, instructionsFile: spec.config.instructionsFile, skillsDir: spec.config.skillsDir, mcpConfig: spec.config.mcpConfig,
    ...(spec.config.commandsDir ? { commandsDir: spec.config.commandsDir } : {}),    terminalScript: (dir, sid) => {
      const r = term.resume;
      if ('wrapper' in l) return fill(term.command, { installDir: dir, sessionId: sid ?? '' })!;
      return r && sid && SESSION[r.sessionId].test(sid) ? fill(r.command, { installDir: dir, sessionId: sid })! : fill(term.command, { installDir: dir })!;
    },
    env: (dir, base) => Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, fill(v, { installDir: dir, gatewayBase: base })!])),
    seed: (base, theme, assistant) => {
      const hasAssistant = !!assistant && 'model' in assistant; // a launch config with only `launchSeeds` (a chat without an Assistant) is not an Assistant
      const provider = assistant?.provider || defaultProvider(spec.api), api = wireFor(spec, provider);
      if (!api || !PROVIDER_ID.test(provider)) throw new Error(`${name} cannot run on the provider "${provider}".`);
      const c: Ctx = { gatewayBase: base, installDir: '', theme, model: assistant?.model, provider };
      const one = (f: AgentSpec['files'][number]): Seed[] => {
        if (f.when === 'assistant' && !hasAssistant) return [];
        if (f.format === 'text') return [{ path: f.path, text: (f.content as string[]).map((line) => fill(line, c)).filter((line) => line !== undefined).join('\n') }];
        const json = fillJson(f.content, c) as Record<string, unknown>;
        if (f.format === 'json-merge' && !Object.keys(json).length && f.content && '$when' in f.content) return []; // a conditional seed whose condition is not met: nothing to merge
        return [f.format === 'json-merge' ? { path: f.path, json, force: f.force ?? true } : { path: f.path, text: JSON.stringify(json, null, f.indent) }];
      };
      const seeds = [...spec.files, ...(spec.providers?.find((p) => p.api === api)?.files ?? [])].flatMap(one);
      for (const m of assistant?.launchSeeds ?? []) addSeed(seeds, m); // the session's MCP servers and helpers (session-config.ts), after everything the manifest writes
      return seeds;
    },
  };
}
