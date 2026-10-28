import { ADMIN_ROLE, db } from './appdb.ts';
import { dropPasskeyWraps } from './unlock-wraps.ts';

export type TwoFactorPolicy = 'off' | 'admins' | 'everyone';
export const POLICIES: TwoFactorPolicy[] = ['off', 'admins', 'everyone'];

export function twoFactorPolicy(): TwoFactorPolicy {
  const v = (db.prepare("SELECT value FROM instance_settings WHERE key = 'require_2fa'").get() as { value: string } | undefined)?.value;
  return POLICIES.includes(v as TwoFactorPolicy) ? (v as TwoFactorPolicy) : 'off';
}
export function setTwoFactorPolicy(p: TwoFactorPolicy) {
  db.prepare("INSERT INTO instance_settings (key, value) VALUES ('require_2fa', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(p);
}

// True when the policy demands TOTP for this user and they have not enabled it yet.
export function needsTwoFactorSetup(userId: string, roleId: string): boolean {
  const p = twoFactorPolicy();
  if (p === 'off' || (p === 'admins' && roleId !== ADMIN_ROLE)) return false;
  const u = db.prepare('SELECT twoFactorEnabled AS on_ FROM user WHERE id = ?').get(userId) as { on_: number | null } | undefined;
  return !u?.on_;
}

// Admin reset: TOTP off, backup codes and passkeys gone (the user signs in with their password and sets 2FA up again).
export function resetTwoFactor(userId: string) {
  db.prepare('DELETE FROM twoFactor WHERE userId = ?').run(userId);
  db.prepare('DELETE FROM passkey WHERE userId = ?').run(userId);
  dropPasskeyWraps(userId); // raw SQL bypasses Better Auth's delete hook
  db.prepare('UPDATE user SET twoFactorEnabled = 0 WHERE id = ?').run(userId);
}
