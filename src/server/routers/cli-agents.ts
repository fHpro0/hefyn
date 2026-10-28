import { keyPolicy, providerProblem } from '../../cli-agents/access.ts';
import { defaultProvider } from '../../cli-agents/providers.ts';
import { allRows, rowOf, usableAgents } from '../../cli-agents/installed.ts';
import { homeOf, loginLogout, loginStatus } from '../../cli-agents/agent-login.ts';
import { accountConversation, forgetSignedIn, signedIn, signedInCached } from '../../cli-agents/own-account.ts';
import { TEAM_ACCOUNTS_PERMISSION, mayManageTeamAccounts, setTeamAccount, sharedLoginPossible, teamAccount, teamKeyAllowed, teamLoginAllowed } from '../../cli-agents/team-accounts.ts';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { profileOf } from '../../cli-agents/profiles.ts';
import { registry } from '../../cli-agents/registry.ts';
import { permissionsOf, runnerConfigured } from '../runner.ts';
import { authed, perm, router } from '../trpc.ts';

// cliAgents.list: which hosted CLI agents (src/cli-agents) this user can start, with the reason in plain words when not.
// Every agent an admin installed and turned on for the user's role is listed; `available` says whether it can run for them right now.
export const cliAgentsRouter = router({
  list: authed.query(async ({ ctx: { me } }) => {
    const rows = usableAgents(me.roleId);
    if (!rows.length) return [];
    const names = new Map((await registry()).agents.map((a) => [a.id, a]));
    let sandbox: string | undefined;
    if (!runnerConfigured()) sandbox = 'This hefyn has no sandbox set up yet. Ask an administrator.';
    else if (!permissionsOf(me.id).includes('sandbox.shell')) sandbox = 'Your role is not allowed to use the sandbox. Ask an administrator to allow it.';
    return Promise.all(rows.map(async (r) => {
      const p = profileOf(r.id)!;
      // judged with the key the admin picked for this agent, as the gateway will use it; Claude Code is also usable on the user's own Claude account (own-account.ts) or the team's shared login
      const own = !sandbox && !!p.wrapper && await signedInCached(me.id);
      const team = !sandbox && !own && !!p.wrapper && teamLoginAllowed(r.id, me.roleId) && await signedIn(me.id, accountConversation(me.id), homeOf(p, 'team')).catch(() => false);
      const keyProblem = sandbox || own || team ? undefined : !teamKeyAllowed(r.id, me.roleId) ? `Your role may not use the team API key for ${p.name}.`
        : await keyPolicy.run({ provider: r.key_provider }, () => providerProblem(me.id, r.default_provider || defaultProvider(p.api)));
      const reason = sandbox ?? (keyProblem && p.wrapper ? `${keyProblem} Or sign in with your own account: Settings, Agent accounts.` : keyProblem);
      return { id: r.id, name: p.name, icon: names.get(r.id)?.icon ?? null, available: !reason, actsWithoutAsking: !!p.actsWithoutAsking, ...(reason ? { reason } : {}) };
    }));
  }),

  // Agent accounts (settings page; account.ts, agent-login.ts): each agent's own sign-in, run in the user's sandbox from the manifest's `login` block. hefyn asks the agent's status
  // command whether someone is signed in and never sees a token. Anyone with the sandbox may sign in with their own account: roles restrict team accounts only.
  accounts: perm('sandbox.shell').query(async ({ ctx: { me } }) => {
    if (!runnerConfigured()) return [];
    return Promise.all(usableAgents(me.roleId).flatMap((r) => {
      const p = profileOf(r.id);
      return p ? [(async () => {
        const login = p.spec.login, st = login ? await loginStatus(me.id, p, r.version) : { signedIn: false } as { signedIn: boolean; account?: string };
        const tl = !!login && teamLoginAllowed(r.id, me.roleId);
        return {
          agentId: r.id, name: p.name, terminal: accountConversation(me.id),
          // flow: null = this agent has no scriptable login here; the user is told to use the agent's own terminal
          flow: login?.flow ?? null, verified: login?.verified ?? false, canSignOut: !!login?.logout,
          status: st.signedIn ? 'signed_in' as const : 'signed_out' as const, ...(st.account ? { account: st.account } : {}),
          team: { key: teamKeyAllowed(r.id, me.roleId), login: tl, loginSignedIn: tl && (await loginStatus(me.id, p, r.version, 'team')).signedIn },
        };
      })()] : [];
    }));
  }),
  signOut: perm('sandbox.shell').input(z.object({ agentId: z.string(), scope: z.enum(['personal', 'team']).default('personal') })).mutation(async ({ ctx: { me }, input }) => {
    const r = usableAgents(me.roleId).find((x) => x.id === input.agentId), p = r && profileOf(r.id);
    if (!r || !p?.spec.login?.logout) throw new TRPCError({ code: 'BAD_REQUEST', message: 'This agent has no account to sign out of here.' });
    if (input.scope === 'team' && !mayManageTeamAccounts(me.id)) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only people who manage team accounts can sign the team out.' });
    const ok = await loginLogout(me.id, p, r.version, input.scope);
    forgetSignedIn(me.id);
    if (!ok) throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Could not sign out. Try again in a moment.' });
    return { ok: true };
  }),

  // Team accounts (admin, `accounts.team`): per agent, the team API key and the shared team login, each with the roles that may use it. The key never enters the sandbox.
  teamAccounts: perm(TEAM_ACCOUNTS_PERMISSION).query(async ({ ctx: { me } }) => Promise.all(allRows().filter((r) => r.status === 'ready' && r.enabled && profileOf(r.id)).map(async (r) => {
    const p = profileOf(r.id)!, t = teamAccount(r.id), possible = sharedLoginPossible(r.id, t);
    return {
      agentId: r.id, name: p.name, hasLogin: !!p.spec.login, sharedLogin: !!p.spec.sharedLogin, loginPossible: possible, ...t,
      keyProvider: r.key_provider, loginSignedIn: t.loginEnabled && possible ? (await loginStatus(me.id, p, r.version, 'team')).signedIn : false,
    };
  }))),
  setTeamAccount: perm(TEAM_ACCOUNTS_PERMISSION).input(z.object({
    agentId: z.string(), keyEnabled: z.boolean().optional(), keyRoles: z.array(z.string().max(64)).max(100).optional(),
    loginEnabled: z.boolean().optional(), loginRoles: z.array(z.string().max(64)).max(100).optional(),
    /** the admin switched on a shared login for an agent whose terms forbid it, after the warning */
    loginOverride: z.boolean().optional(), acceptTermsRisk: z.boolean().optional(),
  })).mutation(({ input: { agentId, ...patch } }) => {
    if (!rowOf(agentId)) throw new TRPCError({ code: 'NOT_FOUND', message: 'This agent is not installed.' });
    return setTeamAccount(agentId, patch);
  }),
});
