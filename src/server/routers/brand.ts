import { z } from 'zod';
import { db } from '../appdb.ts';
import { perm, publicProcedure, router } from '../trpc.ts';

// brand.*: the company co-brand shown beside hefyn on the sign-in pages. Instance-wide, so the read is public (nobody is signed in yet).
// Logos are data: URLs inside JSON only, rendered through <img> (never served as a same-origin file, so an uploaded SVG cannot run script here).
const MAX = 256 * 1024;
const LOGO = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;
const logo = z.string().max(MAX, 'Logo must be 256 KB or less.').regex(LOGO, 'Logo must be a PNG, JPEG, WebP or SVG image.').nullable();
const KEYS = ['brand_name', 'brand_logo', 'brand_logo_dark'] as const;
const read = () => {
  const m = Object.fromEntries((db.prepare(`SELECT key, value FROM instance_settings WHERE key IN (${KEYS.map(() => '?').join(',')})`).all(...KEYS) as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  return { name: m.brand_name ?? '', logo: m.brand_logo ?? null, logoDark: m.brand_logo_dark ?? null };
};

export const brandRouter = router({
  get: publicProcedure.query(read),
  set: perm('users.manage').input(z.object({ name: z.string().trim().max(60), logo, logoDark: logo })).mutation(({ input }) => {
    const v = { brand_name: input.name || null, brand_logo: input.logo, brand_logo_dark: input.logoDark };
    for (const k of KEYS) v[k] === null ? db.prepare('DELETE FROM instance_settings WHERE key = ?').run(k) : db.prepare('INSERT OR REPLACE INTO instance_settings (key, value) VALUES (?, ?)').run(k, v[k]);
    return read();
  }),
});
