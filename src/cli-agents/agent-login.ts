import { containerFs } from '../server/container-fs.ts';
import type { LoginSpec } from '../modules/agent-manifest.ts';
import { accountConversation, proxyEnv } from './own-account.ts';
import { type AgentProfile, versionDir } from './profiles.ts';

// Signing in to an agent's own CLI without a terminal (docs/WRAPPER.md; the manifest `login` block). hefyn runs the CLI's login command in the user's sandbox, reads
// the sign-in address (and device code) off its screen and asks its status command whether it worked. The credentials the CLI writes go into the account home in the
// sandbox: no hefyn code opens, copies or logs them. Whether someone is signed in is asked of the sandbox (the CLI's status command, or a size test of one file).

export type Scope = 'personal' | 'team';
/** Where the CLI keeps its account in the sandbox: the user's own (a directory of the data volume only they get) or the team's (mounted for the allowed roles). */
export const homeOf = (p: AgentProfile, scope: Scope) => (scope === 'team' ? `/team-accounts/${p.registryId}` : p.spec.login!.home.dir ?? `/accounts/${p.registryId}`);

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

const URL_DEFAULT = /https:\/\/[^\s"'<>\x00-\x1f\x7f]+/;
/** The sign-in address and (device flow) the code the CLI printed. The address is the first https one; a trailing . , ) is punctuation, not part of it. */
export function parseLoginOutput(login: Pick<LoginSpec, 'flow' | 'urlPattern' | 'codePattern'>, raw: string): { url?: string; code?: string } {
  const text = stripAnsi(raw), out: { url?: string; code?: string } = {};
  const u = (login.urlPattern ? new RegExp(login.urlPattern) : URL_DEFAULT).exec(text)?.[0].replace(/[.,;)\]]+$/, '');
  if (u && u.length <= 4000) { try { if (new URL(u).protocol === 'https:') out.url = u; } catch { /* not an address */ } }
  if (login.flow === 'device' && login.codePattern) { const m = new RegExp(login.codePattern).exec(text); if (m) out.code = m[1] ?? m[0]; }
  return out;
}

const dig = (j: any, path: string) => path.split('.').reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), j);
/** What the status command printed: signed in or not, plus a label the CLI itself shows (an email, a plan; never a token). */
export function parseLoginStatus(st: LoginSpec['status'], stdout: string, exitCode: number): { signedIn: boolean; account?: string } {
  if (st.format === 'exit' || st.format === 'file') return { signedIn: exitCode === 0 };
  if (st.format === 'text') return { signedIn: exitCode === 0 && new RegExp(st.signedIn!).test(stripAnsi(stdout)) };
  let j: unknown; try { j = JSON.parse(stdout); } catch { return { signedIn: false }; }
  const parts = (st.account ?? []).map((f) => dig(j, f)).filter((v): v is string => typeof v === 'string' && /^[\w.@+ -]{1,200}$/.test(v));
  const [first, ...rest] = parts, label = first && `${first}${rest.length ? ` (${rest.map((r) => r[0]!.toUpperCase() + r.slice(1)).join(', ')})` : ''}`;
  return { signedIn: dig(j, st.signedIn!) === true, ...(label ? { account: label } : {}) };
}

/** The environment the account commands share: the account home as the CLI's config dir, the agent's own switches against updates and telemetry, the egress proxy. */
export function loginEnv(p: AgentProfile, version: string, scope: Scope): Record<string, string> {
  const l = p.spec.login!, quiet = Object.fromEntries(Object.entries(p.env(versionDir(p.registryId, version), '')).filter(([k]) => /DISABLE|TELEMETRY|SKIP_VERSION/.test(k) && !/KEY|BASE|URL/.test(k)));
  return { ...quiet, [l.home.env]: homeOf(p, scope), ...proxyEnv() };
}
const fill = (cmd: string, p: AgentProfile, version: string) => cmd.replaceAll('{{installDir}}', versionDir(p.registryId, version));

/** The login command as the terminal runs it. */
export const loginCommand = (p: AgentProfile, version: string) => fill(p.spec.login!.command, p, version);

async function run(userId: string, argv: string[], env: Record<string, string>) {
  return containerFs({ userId, conversationId: accountConversation(userId) }).run(argv, { cwd: '/tmp', env, timeoutMs: 60_000 });
}
/** Is the user (scope personal) or the team (scope team) signed in to this agent? Asked of the sandbox. A sandbox that cannot be reached counts as not signed in. */
export async function loginStatus(userId: string, p: AgentProfile, version: string, scope: Scope = 'personal'): Promise<{ signedIn: boolean; account?: string }> {
  const l = p.spec.login;
  if (!l) return { signedIn: false };
  try {
    const r = l.status.format === 'file'
      ? await run(userId, ['test', '-s', `${homeOf(p, scope)}/${l.status.signedIn}`], {})
      : await run(userId, ['sh', '-c', fill(l.status.command!, p, version)], loginEnv(p, version, scope));
    return parseLoginStatus(l.status, r.stdout, r.exitCode);
  } catch { return { signedIn: false }; }
}
/** Sign out: the CLI's own logout command, run in the sandbox. False when it failed. */
export async function loginLogout(userId: string, p: AgentProfile, version: string, scope: Scope = 'personal'): Promise<boolean> {
  const l = p.spec.login;
  if (!l?.logout) return false;
  try { return (await run(userId, ['sh', '-c', fill(l.logout, p, version)], loginEnv(p, version, scope))).exitCode === 0; } catch { return false; }
}

/** A short reason for the user from what the login printed when it ended without success: the last line that is not an address, without the address. */
export function failureReason(raw: string): string {
  const lines = stripAnsi(raw).split('\n').filter((l) => !/https?:\/\//.test(l)).map((l) => l.replace(/[^\x20-\x7e]/g, '').trim()).filter((l) => l.length > 3);
  const last = lines.at(-1);
  return last && last.length <= 160 && !/\b[A-Za-z0-9_-]{24,}\b/.test(last) ? `The sign-in did not finish: ${last}` : 'The sign-in did not finish. Try again.'; // a long token-like string is never echoed
}
