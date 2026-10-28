import { z } from 'zod';
import { db } from '../appdb.ts';
import { authed, router } from '../trpc.ts';

// A user's look (mode, accent, base neutrals, radius, density, text size), stored per user so it follows them across devices.
// Deliberately NOT sealed: appearance is not personal data, and the sign-in page needs no key to read it.
db.exec('CREATE TABLE IF NOT EXISTS user_prefs (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))');

export const ThemeSchema = z.strictObject({
  mode: z.enum(['system', 'light', 'dark']),
  accent: z.union([z.literal('default'), z.string().regex(/^#[0-9a-f]{6}$/i)]), // 'default' = hefyn's monochrome primary
  base: z.enum(['zinc', 'neutral', 'slate', 'stone']),
  radius: z.enum(['none', 'small', 'default', 'large']),
  density: z.enum(['comfortable', 'compact']),
  textSize: z.enum(['small', 'default', 'large']),
});
export type ThemePrefs = z.output<typeof ThemeSchema>;
export const DEFAULT_THEME: ThemePrefs = { mode: 'system', accent: 'default', base: 'zinc', radius: 'default', density: 'comfortable', textSize: 'default' };

export const themeRouter = router({
  get: authed.query(({ ctx: { me } }): ThemePrefs => {
    const row = db.prepare("SELECT value FROM user_prefs WHERE user_id = ? AND key = 'theme'").get(me.id) as { value: string } | undefined;
    const parsed = row && ThemeSchema.safeParse(JSON.parse(row.value));
    return parsed?.success ? parsed.data : DEFAULT_THEME;
  }),
  save: authed.input(ThemeSchema).mutation(({ ctx: { me }, input }) => {
    db.prepare("INSERT OR REPLACE INTO user_prefs (user_id, key, value) VALUES (?, 'theme', ?)").run(me.id, JSON.stringify(input));
    return input;
  }),
});
