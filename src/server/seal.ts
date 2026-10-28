import { db } from './appdb.ts';
import { decrypt } from './crypto.ts';
import { isSealed, openForTeam, openForUser } from './vault.ts';

// Secrets written before per-user/team encryption are encrypted with the server secret (crypto.ts); they stay readable here
// and are re-sealed on the owner's next unlock (keys.ts). Light module: the agent process imports it too.
// Once the owner's data is migrated (strict mode, vault.ts) an unsealed value is a downgrade: the open* call below throws for it.
export const openUserSecret = (userId: string, v: string, aad: string) => { if (isSealed(v)) return openForUser(userId, v, aad); openForUser(userId, v, aad); return decrypt(v); };
export const openTeamSecret = (v: string, aad: string) => { if (isSealed(v)) return openForTeam(v, aad); openForTeam(v, aad); return decrypt(v); };

// A company provider's secret is bound to its endpoint: editing base_url in the database makes it unreadable instead of redirecting it.
export const providerAad = (id: string, baseUrl: string | null) => `provider:${id}:${baseUrl ?? ''}`;
/** Opens providers.enc_key. Values sealed before the endpoint was bound (`provider:<id>`) still open until the team is strict. */
export function openProviderSecret(r: { id: string; base_url: string | null; enc_key: string }) {
  try { return openTeamSecret(r.enc_key, providerAad(r.id, r.base_url)); } catch (e) {
    if ((e as Error).name === 'DowngradeError' || (e as any).code === 'locked' || db.prepare("SELECT 1 FROM instance_settings WHERE key = 'team_strict'").get()) throw e;
    return openTeamSecret(r.enc_key, `provider:${r.id}`);
  }
}
