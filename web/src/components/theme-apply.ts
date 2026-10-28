// Mirrors src/server/routers/theme.ts. applyTheme must stay self-contained: web/shell.ts inlines its source into <head> (via toString) to run before first paint.
export type ThemePrefs = {
  mode: 'system' | 'light' | 'dark';
  accent: string; // 'default' or #rrggbb
  base: 'zinc' | 'neutral' | 'slate' | 'stone';
  radius: 'none' | 'small' | 'default' | 'large';
  density: 'comfortable' | 'compact';
  textSize: 'small' | 'default' | 'large';
};

export function applyTheme(t: ThemePrefs) {
  const el = document.documentElement, s = el.style;
  el.classList.toggle('dark', t.mode === 'dark' || (t.mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches));
  el.dataset.base = t.base; el.dataset.radius = t.radius; el.dataset.density = t.density; el.dataset.text = t.textSize;
  if (/^#[0-9a-f]{6}$/i.test(t.accent)) {
    const l = [1, 3, 5].map((i) => { const c = parseInt(t.accent.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    const y = 0.2126 * l[0]! + 0.7152 * l[1]! + 0.0722 * l[2]!;
    s.setProperty('--accent-src', t.accent);
    s.setProperty('--accent-fg', (y + 0.05) / 0.05 >= 1.05 / (y + 0.05) ? '#09090b' : '#ffffff'); // whichever of black / white contrasts more
    el.dataset.accent = 'custom';
  } else { s.removeProperty('--accent-src'); s.removeProperty('--accent-fg'); delete el.dataset.accent; }
}
