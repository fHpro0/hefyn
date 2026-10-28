import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { avatarError } from './avatar.ts';
import { twoFactor } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { db } from './appdb.ts';
import { CLIENT_IP_HEADER } from './clientip.ts';
import { SECRET } from './crypto.ts';
import { sendSystemMail, systemMailConfigured } from './channels.ts';
import { onPasswordReset, vaultAfter, vaultBefore } from './keys.ts';

export const baseURL = process.env.HEFYN_URL ?? 'http://localhost:3000';

const options = {
  database: db,
  secret: SECRET,
  baseURL,
  // dev: Astro (4321) and Flue/Vite (5173) dev servers; HEFYN_EXTRA_ORIGINS (comma-separated) keeps e.g. http://localhost:4422 working next to https://hefyn.local
  trustedOrigins: [baseURL, 'http://localhost:4321', 'http://localhost:5173', ...(process.env.HEFYN_EXTRA_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? [])],
  // The web service resolves the client IP itself (clientip.ts: socket peer, or X-Forwarded-For behind HEFYN_TRUSTED_PROXIES) and
  // hands it over in this header; forwarding headers sent by clients never reach Better Auth.
  advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
  // Off by default outside production; the 2FA endpoints add their own tighter rules (3 per 10 s). In-memory: web is one process.
  rateLimit: { enabled: true },
  // Per-user encryption keys follow the sign-in / sign-out / password events (keys.ts, docs/ENCRYPTION.md).
  hooks: { before: vaultBefore, after: vaultAfter },
  // updateUser is Better Auth's own endpoint: this is where hefyn can hold the avatar to its rules.
  databaseHooks: { user: { update: { before: async (u: { image?: unknown }) => { const m = avatarError(u.image); if (m) throw new APIError('BAD_REQUEST', { message: m }); } } } },
  plugins: [
    twoFactor({ issuer: 'hefyn' }),
    // WebAuthn is bound to the exact browser origin: HEFYN_URL must match it (https, or localhost).
    passkey({ rpID: new URL(baseURL).hostname, rpName: 'hefyn', origin: baseURL }),
  ],
  emailAndPassword: {
    enabled: true, autoSignIn: false, minPasswordLength: 8, resetPasswordTokenExpiresIn: 3600, onPasswordReset,
    // Never throws and answers the same for known and unknown emails, so the response leaks nothing.
    sendResetPassword: async ({ user, token }: { user: { email: string }; token: string }) => {
      if (!systemMailConfigured()) return;
      const invite = invites.has(user.email.toLowerCase());
      const link = `${baseURL}/reset-password?token=${token}`;
      if (invite) db.prepare('UPDATE verification SET expiresAt = ? WHERE identifier = ?').run(new Date(Date.now() + INVITE_TTL_MS).toISOString(), `reset-password:${token}`);
      const text = invite
        ? `You have been invited to hefyn (${baseURL}).\n\nSet your password here (the link works for 3 days):\n${link}\n`
        : `Someone asked to reset the password for your hefyn account (${baseURL}).\n\nSet a new password here (the link works for 1 hour):\n${link}\n\nIf this was not you, ignore this mail.\n`;
      // Not awaited: the answer must not be slower for a known address than for an unknown one (timing).
      void sendSystemMail({ to: user.email, subject: invite ? 'You are invited to hefyn' : 'Reset your hefyn password', text }).catch((e) => console.error('[hefyn] reset mail failed:', (e as Error).message.slice(0, 120)));
    },
  },
};

const INVITE_TTL_MS = 72 * 3600_000;
const invites = new Set<string>(); // emails whose reset token is an invite (longer lifetime, different text)

// Tables must exist before betterAuth() is created: it checks the schema once at init.
await (await getMigrations(options)).runMigrations();
export const auth = betterAuth(options);

// "Set your password" mail for a new account (same reset-token mechanism, 72 h).
export async function sendInvite(email: string) {
  invites.add(email.toLowerCase());
  try { await auth.api.requestPasswordReset({ body: { email } }); } finally { invites.delete(email.toLowerCase()); }
}
