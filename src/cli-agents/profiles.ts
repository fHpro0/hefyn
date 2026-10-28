// The agents hefyn can host, keyed by id. An agent is available only if it has a module (src/modules/agents/*.json for the built-in ones, or an agent module an
// admin added: docs/MODULES.md "Agent modules"). A module routes ALL of the agent's model traffic through hefyn's gateway (a base URL on the sandbox's model
// bridge, a dummy key) and switches off what would leave the sandbox otherwise (telemetry, auto-update, web tools); manifest-profile.ts turns it into the
// AgentProfile below, agent-modules.ts finds the added ones. Config keys were checked against the versions named in the manifests (docs/SANDBOX.md).

import type { AgentSpec } from '../modules/agent-manifest.ts';
import { BUILTIN_AGENTS } from '../modules/agents/index.ts';
import { moduleProfile } from './agent-modules.ts';
import { profileFromSpec } from './manifest-profile.ts';

export const AGENTS_ROOT = '/opt/agents'; // the hefyn-agents volume, read-only in every sandbox
export const BRIDGE_PORT = 47000;

/** A file the generic run-agent.sh writes before it execs the agent (seed.mjs). path: under /tmp (persisted per conversation). json: deep-merged into the
 *  existing file (force: the seed wins, else the existing value wins); text: written as is (always overwritten: hefyn owns that file). */
export type Seed = { path: string; json: Record<string, unknown>; force: boolean; /** key path to an object whose entries hefyn owns: the ones it wrote earlier and the seed no longer has are removed (seed.mjs) */ owns?: string[] } | { path: string; text: string } | { path: string; sweep: true; files?: true };
/** What an Assistant sets on an agent (src/server/assistants.ts): model = the agent API's bare model id, null = the agent's own choice. */
export interface AssistantConfig { model: string | null; /** the model provider (a connected provider id) the agent runs on; unset = the agent's own API's provider (anthropic / openai) */ provider?: string | null; instructions: string; skills: { name: string; files: Record<string, string> }[] }

/** What a launch needs besides the manifest: the Assistant's (or the admin's default) model and provider, and `launchSeeds`, the session's MCP servers and helper setup (session-config.ts), written after the manifest's files. */
export type LaunchCfg = Partial<Pick<AssistantConfig, 'model' | 'provider'>> & { launchSeeds?: Seed[] };
export type Api = 'anthropic' | 'openai-responses';
export interface AgentProfile {
  /** The agent's id (an ACP Registry id for the built-in ones); names its directory in the agents volume. */
  registryId: string;
  name: string;
  /** hefyn's own plain one-line description (the registry's is jargon). */
  description: string;
  /** Which gateway front the agent speaks to. */
  api: Api;
  /** The module's agent section: distribution, icon and licence come from there. */
  spec: AgentSpec;
  /** The agent has no permission mechanism: it edits files and runs commands in the sandbox without asking. Shown to admins and users. */
  actsWithoutAsking?: boolean;
  /** Launch from the distribution: npm = package (without version) and the bin the ACP server is started with; binary = cmd and args, as the registry lists them. */
  npm?: { package: string; bin: string; /** pinned packages installed next to it, which the agent needs but the registry entry does not name */ extra?: string[]; /** files that must exist after the install, besides the bin */ check?: string[] };
  binary?: { cmd: string; args: string[] };
  /** The agent's own CLI runs in a PTY and the chat is built from its hooks and transcript (claude-wrapper.ts, docs/WRAPPER.md) instead of ACP. */
  wrapper?: 'claude-code';
  /** Where the agent keeps its config, and where hefyn puts instructions, skills and MCP servers (for the Assistants that come next). All under /tmp. */
  configDir: string;
  instructionsFile: string;
  skillsDir: string;
  mcpConfig: string;
  /** Slash commands (markdown files) of the agent, if it has them; else the user's Assistants-as-tools are written as skills. */
  commandsDir?: string;
  /** The shell script that starts the terminal UI (`sid`: the conversation's ACP session id, to resume it). `dir`: the installed version's directory. */
  terminalScript(dir: string, sid: string | null): string;
  env(dir: string, base: string): Record<string, string>;
  /** `assistant`: the conversation's Assistant, if any (its model goes into the agent's own settings; instructions and skills are files, see assistantSeeds). */
  seed(base: string, theme?: 'light' | 'dark', assistant?: LaunchCfg): Seed[];
}

/** The built-in agents. */
export const PROFILES: Record<string, AgentProfile> = Object.fromEntries(BUILTIN_AGENTS.map(({ id, name, description, kind: _k, version: _v, ...spec }) => [id, profileFromSpec(id, name, description, spec)]));

/** A built-in agent, else an enabled agent module (read from the database on every call, so adding and removing one takes effect at once). */
export const profileOf = (id: string): AgentProfile | undefined => (Object.hasOwn(PROFILES, id) ? PROFILES[id] : moduleProfile(id));
/** Conversations from before the registry used the id `claude-code`. */
export const canonicalAgent = (id: string) => (id === 'claude-code' ? 'claude-acp' : id);

export const versionDir = (id: string, version: string) => `${AGENTS_ROOT}/${id}/${version}`;
const base = (port: number) => `http://127.0.0.1:${port}`;

export interface Launch { cmd: string[]; env: Record<string, string> }
const finish = (p: AgentProfile, dir: string, port: number, theme: 'light' | 'dark' | undefined, argv: string[], assistant?: LaunchCfg): Launch => ({
  cmd: ['/opt/hefyn/run-agent.sh', ...argv],
  env: { ...p.env(dir, base(port)), HEFYN_SEED: JSON.stringify(p.seed(base(port), theme, assistant)) },
});

/** A PTY is rendered by xterm.js, which does truecolor; without COLORTERM the TUIs fall back to inverse video for their colored bars. */
const withTerm = (l: Launch): Launch => ({ ...l, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', ...l.env } });

/** The ACP server of an installed version: the process hefyn speaks ACP to over stdio. */
export function acpLaunch(p: AgentProfile, version: string, port = BRIDGE_PORT, assistant?: LaunchCfg): Launch {
  const dir = versionDir(p.registryId, version);
  return finish(p, dir, port, undefined, p.npm ? [`${dir}/node_modules/.bin/${p.npm.bin}`] : [`${dir}/${p.binary!.cmd.replace(/^\.\//, '')}`, ...p.binary!.args], assistant);
}
/** The agent's own terminal UI. */
export function terminalLaunch(p: AgentProfile, version: string, sid: string | null, theme?: 'light' | 'dark', port = BRIDGE_PORT, assistant?: LaunchCfg): Launch {
  const dir = versionDir(p.registryId, version);
  return withTerm(finish(p, dir, port, theme, ['sh', '-c', p.terminalScript(dir, sid)], assistant));
}

/** The wrapped CLI in a PTY: the one process both views attach to. `sid`: the session id (a uuid): the launch script starts it, or resumes it if its transcript exists. */
export function wrapperLaunch(p: AgentProfile, version: string, sid: string, theme?: 'light' | 'dark', port = BRIDGE_PORT, assistant?: LaunchCfg): Launch {
  if (!/^[0-9a-f-]{36}$/.test(sid)) throw new Error('invalid session id');
  return withTerm(finish(p, versionDir(p.registryId, version), port, theme, ['sh', '-c', p.terminalScript(versionDir(p.registryId, version), sid)], assistant));
}

const MARKER = '.hefyn-managed'; // in every skill directory hefyn wrote: the sweep below removes those (and only those) before the current ones are written
const safeRel = (rel: string) => !rel.startsWith('/') && !rel.includes('\0') && !rel.split('/').includes('..') && rel !== MARKER;

/**
 * The files an Assistant puts into an agent's user-level config: instructions into its instructions file, each skill (SKILL.md and its files) into its skills dir.
 * Too big for the launch environment (32 KB per variable), so they are written in the sandbox beforehand (seed.mjs over stdin), not through HEFYN_SEED.
 */
export const assistantSeeds = (p: AgentProfile, a: AssistantConfig): Seed[] => [{ path: `${p.configDir}/${p.instructionsFile}`, text: a.instructions }, ...skillSeeds(p, a.skills)];
/** The skills dir of an agent: what hefyn wrote before is swept, then each skill is written (a chat without an Assistant has no instructions to write, only these). */
export function skillSeeds(p: AgentProfile, skills: AssistantConfig['skills']): Seed[] {
  const seeds: Seed[] = [{ path: p.skillsDir, sweep: true }];
  for (const s of skills) {
    if (!/^[\w.-]{1,64}$/.test(s.name) || s.name.startsWith('.')) continue;
    seeds.push({ path: `${p.skillsDir}/${s.name}/${MARKER}`, text: '' });
    for (const [rel, text] of Object.entries(s.files)) if (safeRel(rel)) seeds.push({ path: `${p.skillsDir}/${s.name}/${rel}`, text });
  }
  return seeds;
}
