import { trpc } from '@/lib/trpc';
import { applyTheme, type ThemePrefs } from './theme-apply';

export type Theme = ThemePrefs['mode'];
export type { ThemePrefs };
export { applyTheme };
export const DEFAULT_THEME: ThemePrefs = { mode: 'system', accent: 'default', base: 'zinc', radius: 'default', density: 'comfortable', textSize: 'default' };

// The device's last look. The inline script in Layout.astro applies it before first paint; the server copy (per user) wins after load.
// 'hefyn-theme' (just the mode) predates the full cache and is the fallback.
const CACHE = 'hefyn-theme-prefs';
export const cachedTheme = (): ThemePrefs => {
  try { return { ...DEFAULT_THEME, ...JSON.parse(localStorage.getItem(CACHE) ?? '{}') }; } catch { return DEFAULT_THEME; }
};
const cache = (t: ThemePrefs) => { localStorage.setItem(CACHE, JSON.stringify(t)); localStorage.setItem('hefyn-theme', t.mode); dispatchEvent(new Event('hefyn-theme')); };

export const getTheme = (): Theme => cachedTheme().mode;
// Persist + apply (the inline script listens for 'hefyn-theme'); rejects when the server refuses, e.g. offline.
export async function saveTheme(t: ThemePrefs) { cache(t); await trpc.theme.save.mutate(t); }
export const setTheme = (mode: Theme) => { saveTheme({ ...cachedTheme(), mode }).catch(() => {}); };
// After load: the server value wins and refreshes the cache.
export async function syncTheme() {
  const t = await trpc.theme.get.query().catch(() => null);
  if (t && JSON.stringify(t) !== JSON.stringify(cachedTheme())) cache(t);
}

// WCAG contrast ratio of two #rrggbb colours.
const lum = (h: string) => { const [r, g, b] = [1, 3, 5].map((i) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export const SEAL = '#2563eb';
// True when the accent is hard to tell from the seal blue (RGB distance; seals must stay recognisable).
export const nearSeal = (hex: string) => Math.hypot(...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) - parseInt(SEAL.slice(i, i + 2), 16))) < 70;
