import { keyPolicy, providerProblem } from '../cli-agents/access.ts';
import { defaultProvider, wireFor } from '../cli-agents/providers.ts';
import { rowOf, usableAgents } from '../cli-agents/installed.ts';
import { homeOf } from '../cli-agents/agent-login.ts';
import { accountConversation, signedIn, signedInCached } from '../cli-agents/own-account.ts';
import { resolveMode, teamKeyAllowed, teamLoginAllowed } from '../cli-agents/team-accounts.ts';
import { canonicalAgent, profileOf } from '../cli-agents/profiles.ts';
import { type Assistant, roleMay, roleOf } from './assistants.ts';
import { runnerConfigured, shellEnabled } from './runner.ts';

type Availability = { available: true } | { available: false; reason: string };

/** May this user start a chat on the Assistant right now? `reason` is in plain words for the person who cannot. Role and archive state are the caller's business.
 *  `private`: the Assistant is the user's own, so it grants no sandbox and they need it themselves. */
export async function assistantAvailability(userId: string, a: Assistant): Promise<Availability> {
  const no = (reason: string) => ({ available: false as const, reason });
  if (!a.simple) return no('This assistant used the retired flow builder and can not start new chats.');
  if (!a.agent) return no('This assistant has no agent. Ask your administrator.');
  const priv = a.scope === 'private';
  const p = profileOf(canonicalAgent(a.agent)), row = rowOf(canonicalAgent(a.agent));
  if (!p || !row || row.status !== 'ready' || !row.enabled) return no('This assistant is not available right now. Ask your administrator.');
  if (!runnerConfigured()) return no('This hefyn has no sandbox set up yet. Ask your administrator.');
  if (priv && (!shellEnabled(userId) || !usableAgents(roleOf(userId)).some((r) => r.id === row.id))) return no('You do not have access to this agent or the sandbox. Ask your administrator.');
  // the key is judged as the gateway will use it: the one the admin picked for the agent
  const on = a.provider || defaultProvider(p.api);
  if (!wireFor(p.spec, on)) return no(`${p.name} cannot run on ${on}. Ask your administrator.`);
  // same rule as the host's chooseMode (team-accounts.ts resolveMode): the user's own login, else the team's login or key their role may use
  const roleId = roleOf(userId), id = row.id;
  const personalSignedIn = !!p.wrapper && await signedInCached(userId);
  const tl = !personalSignedIn && !!p.wrapper && teamLoginAllowed(id, roleId), teamLoginSignedIn = tl && await signedIn(userId, accountConversation(userId), homeOf(p, 'team')).catch(() => false);
  const keyAllowed = teamKeyAllowed(id, roleId);
  const problem = personalSignedIn || teamLoginSignedIn ? undefined : !keyAllowed ? `Your role may not use the team API key for ${p.name}.`
    : await keyPolicy.run({ provider: row.key_provider }, () => providerProblem(userId, on));
  if (resolveMode({ unattended: false, personalSignedIn, teamLoginAllowed: tl, teamLoginSignedIn, teamKeyAllowed: keyAllowed, teamKeyUsable: !problem }) !== 'none') return { available: true };
  return no(p.wrapper ? `${problem} Or sign in with your own account: Settings, Agent accounts.` : problem!);
}

export const mayUse = (a: Assistant, roleId: string | undefined) => !a.archived && roleMay(a, roleId);
