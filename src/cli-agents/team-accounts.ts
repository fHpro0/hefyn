import { db } from '../server/appdb.ts';
import { setTeamHomes } from '../server/container-fs.ts';
import { profileOf } from './profiles.ts';

// Team accounts per agent (Settings, Agent accounts; docs/WRAPPER.md): what the company offers its staff for an agent, each with the roles that may use it.
//  - the team API key: the provider key an admin connected (cli_agents.key_provider); it never enters the sandbox, the gateway uses it.
//  - the shared team login: an admin signs in once into a team account home (<data>/team-accounts/<agent>), mounted into the sandboxes of the allowed roles.
//    Offered only where the agent's manifest says `sharedLogin: true`. An admin may switch it on for an agent whose terms forbid sharing (Claude Code, Codex)
//    only with an explicit acknowledgement, which is stored (login_override).
// Personal sign-in is not restricted by any of this: roles control team accounts only.

db.exec("CREATE TABLE IF NOT EXISTS team_accounts (agent_id TEXT PRIMARY KEY, key_enabled INTEGER NOT NULL DEFAULT 1, key_roles TEXT NOT NULL DEFAULT '[]', login_enabled INTEGER NOT NULL DEFAULT 0, login_roles TEXT NOT NULL DEFAULT '[]', login_override INTEGER NOT NULL DEFAULT 0)");

export const TEAM_ACCOUNTS_PERMISSION = 'accounts.team';
export class TeamAccountError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

interface Row { agent_id: string; key_enabled: number; key_roles: string; login_enabled: number; login_roles: string; login_override: number }
export interface TeamAccount { keyEnabled: boolean; keyRoles: string[]; loginEnabled: boolean; loginRoles: string[]; loginOverride: boolean }

const rolesOf = (s: string): string[] => { try { const j = JSON.parse(s); return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : ['!']; } catch { return ['!']; } }; // unreadable: no role matches
/** [] = every role (as everywhere else in hefyn); otherwise the role must be listed. */
export const roleListed = (roles: string[], roleId: string | undefined) => roles.length === 0 || (!!roleId && roles.includes(roleId));

export function teamAccount(agentId: string): TeamAccount {
  const r = db.prepare('SELECT * FROM team_accounts WHERE agent_id = ?').get(agentId) as Row | undefined;
  return r ? { keyEnabled: !!r.key_enabled, keyRoles: rolesOf(r.key_roles), loginEnabled: !!r.login_enabled, loginRoles: rolesOf(r.login_roles), loginOverride: !!r.login_override }
    : { keyEnabled: true, keyRoles: [], loginEnabled: false, loginRoles: [], loginOverride: false }; // the key keeps working for everyone who may use the agent, as before this existed
}

/** Is a shared login possible for this agent: the manifest allows it, or an admin took the explicit override. */
export const sharedLoginPossible = (agentId: string, t = teamAccount(agentId)) => !!profileOf(agentId)?.spec.login && (!!profileOf(agentId)?.spec.sharedLogin || t.loginOverride);

export interface TeamPatch { keyEnabled?: boolean; keyRoles?: string[]; loginEnabled?: boolean; loginRoles?: string[]; /** true = the admin read the warning and accepts it */ acceptTermsRisk?: boolean; loginOverride?: boolean }
export function setTeamAccount(agentId: string, p: TeamPatch): TeamAccount {
  const profile = profileOf(agentId);
  if (!profile) throw new TeamAccountError(404, 'This agent is not available.');
  const cur = teamAccount(agentId);
  let override = cur.loginOverride;
  if (p.loginOverride !== undefined) {
    if (p.loginOverride && !profile.spec.sharedLogin && !p.acceptTermsRisk) throw new TeamAccountError(400, `${profile.name}'s provider does not allow a subscription to be shared. Confirm the warning to enable it anyway.`);
    override = p.loginOverride;
  }
  const next: TeamAccount = { keyEnabled: p.keyEnabled ?? cur.keyEnabled, keyRoles: p.keyRoles ?? cur.keyRoles, loginEnabled: p.loginEnabled ?? cur.loginEnabled, loginRoles: p.loginRoles ?? cur.loginRoles, loginOverride: override };
  if (next.loginEnabled && !sharedLoginPossible(agentId, next)) throw new TeamAccountError(400, `${profile.name} has no shared team login. Use a team API key, or confirm the warning to enable one anyway.`);
  db.prepare('INSERT INTO team_accounts (agent_id, key_enabled, key_roles, login_enabled, login_roles, login_override) VALUES (?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET key_enabled = excluded.key_enabled, key_roles = excluded.key_roles, login_enabled = excluded.login_enabled, login_roles = excluded.login_roles, login_override = excluded.login_override')
    .run(agentId, +next.keyEnabled, JSON.stringify(next.keyRoles), +next.loginEnabled, JSON.stringify(next.loginRoles), +next.loginOverride);
  return next;
}

export const teamKeyAllowed = (agentId: string, roleId: string | undefined) => { const t = teamAccount(agentId); return t.keyEnabled && roleListed(t.keyRoles, roleId); };
export const teamLoginAllowed = (agentId: string, roleId: string | undefined) => { const t = teamAccount(agentId); return t.loginEnabled && sharedLoginPossible(agentId, t) && roleListed(t.loginRoles, roleId); };

const roleOfUser = (userId: string) => (db.prepare('SELECT role_id FROM user_roles WHERE user_id = ?').get(userId) as { role_id: string } | undefined)?.role_id;
const holds = (userId: string, perm: string) => {
  const r = db.prepare('SELECT r.permissions FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?').get(userId) as { permissions: string } | undefined;
  try { return !!r && (JSON.parse(r.permissions) as string[]).includes(perm); } catch { return false; }
};
export const mayManageTeamAccounts = (userId: string) => holds(userId, TEAM_ACCOUNTS_PERMISSION);

/** The agents whose team home is mounted into this user's sandboxes: their role may use the team login, or they are the admin who signs it in. (The runner mounts <data>/team-accounts/<id>.) */
export function teamHomes(userId: string): string[] {
  const rows = db.prepare('SELECT agent_id FROM team_accounts WHERE login_enabled = 1').all() as { agent_id: string }[];
  if (!rows.length) return [];
  const role = roleOfUser(userId), admin = mayManageTeamAccounts(userId);
  return rows.map((r) => r.agent_id).filter((id) => /^[a-z][a-z0-9-]{1,31}$/.test(id) && sharedLoginPossible(id) && (admin || teamLoginAllowed(id, role))).sort();
}

setTeamHomes(teamHomes);

export type Mode = 'personal' | 'team-login' | 'team-key' | 'none';
/** Which account a session uses: personal login if the user is signed in, else the team login (allowed for their role and signed in), else the team API key (allowed and usable), else none.
 *  Unattended runs (schedules, flows) use the key only. Roles never restrict the personal login. */
export function resolveMode(i: { unattended: boolean; personalSignedIn: boolean; teamLoginAllowed: boolean; teamLoginSignedIn: boolean; teamKeyAllowed: boolean; teamKeyUsable: boolean }): Mode {
  if (!i.unattended) {
    if (i.personalSignedIn) return 'personal';
    if (i.teamLoginAllowed && i.teamLoginSignedIn) return 'team-login';
  }
  return i.teamKeyAllowed && i.teamKeyUsable ? 'team-key' : 'none';
}
