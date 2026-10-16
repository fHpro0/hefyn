export type Theme = 'system' | 'light' | 'dark';
export const getTheme = (): Theme => (localStorage.getItem('hefyn-theme') as Theme) || 'system';
// The inline script in Layout.astro applies the class; it listens for this event.
export const setTheme = (t: Theme) => { localStorage.setItem('hefyn-theme', t); dispatchEvent(new Event('hefyn-theme')); };
