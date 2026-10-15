import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const secret = process.env.HEFYN_SECRET;
// Production validation (missing / placeholder / short) lives in startup.ts, imported first by web and agent.
export const SECRET = secret ?? 'hefyn-dev-secret-not-for-production';

const key = (s: string) => createHash('sha256').update(s).digest();

// AES-256-GCM; stored as base64(iv | tag | ciphertext).
export function encrypt(plain: string, s = SECRET): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(s), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

export function decrypt(blob: string, s = SECRET): string {
  const b = Buffer.from(blob, 'base64');
  const d = createDecipheriv('aes-256-gcm', key(s), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
