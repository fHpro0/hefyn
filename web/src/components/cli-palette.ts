// The 16 ANSI colours of the agent's terminal, readable (>= 4.5:1) on a light and a dark console. Fixed hex: the accent and base tokens are the user's to change, the terminal's reds and greens are not.
export const ANSI_BG = { light: '#ffffff', dark: '#09090b' } as const; // what the palettes are checked against; the real background is the console's own token
export const ANSI = {
  light: {
    black: '#18181b', red: '#b91c1c', green: '#15803d', yellow: '#8a5300', blue: '#1d4ed8', magenta: '#a21caf', cyan: '#0e7490', white: '#52525b',
    brightBlack: '#6b6b76', brightRed: '#c2261f', brightGreen: '#17803d', brightYellow: '#946000', brightBlue: '#2563eb', brightMagenta: '#a21caf', brightCyan: '#0e7490', brightWhite: '#3f3f46',
  },
  dark: {
    black: '#8b8b95', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#e879f9', cyan: '#22d3ee', white: '#d4d4d8',
    brightBlack: '#8b8b95', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#f0abfc', brightCyan: '#67e8f9', brightWhite: '#fafafa',
  },
} as const;

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
/** WCAG contrast ratio of two #rrggbb colours. */
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
