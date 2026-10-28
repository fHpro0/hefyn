#!/usr/bin/env bun
// Generates the animated ASCII-art GIFs for the README into docs/readme/.
// Usage: bun run readme:art [logo|hero]   (needs rsvg-convert, magick, ffmpeg; font: Menlo)
// Output is deterministic: all randomness is a hash of (seed, frame, cell).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "docs/readme");

interface Theme { name: string; bg: string; fg: string; muted: string; accent: string }
const THEMES: Theme[] = [
  { name: "dark", bg: "#0d1117", fg: "#fafafa", muted: "#a1a1aa", accent: "#60a5fa" },
  { name: "light", bg: "#ffffff", fg: "#14161a", muted: "#71717a", accent: "#2563eb" },
];

// ---------- helpers ----------
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** t of a, rest of b */
const mix = (a: string, b: string, t: number) => {
  const [x, y] = [hex(a), hex(b)];
  return "#" + x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, "0")).join("");
};
/** Deterministic hash -> [0,1) */
function rnd(...n: number[]) {
  let h = 0x2545f491;
  for (const x of n) {
    h = Math.imul(h ^ (x + 0x7f4a7c15), 0x9e3779b1);
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
  }
  return (h >>> 0) / 4294967296;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type Cell = { ch: string; color: string } | null;
type Grid = Cell[][];
const newGrid = (rows: number, cols: number): Grid => Array.from({ length: rows }, () => Array<Cell>(cols).fill(null));

// Menlo metrics (em): advance 0.602, ascent 0.928, descent 0.236
const ADV = 0.602, ASC = 0.928, DESC = 0.236;

// Box-drawing chars are drawn as strokes (l, r, u, d, heavy): font glyphs leave gaps between cells.
const LINES: Record<string, number[]> = {
  "─": [1, 1, 0, 0], "│": [0, 0, 1, 1], "┌": [0, 1, 0, 1], "┐": [1, 0, 0, 1], "└": [0, 1, 1, 0], "┘": [1, 0, 1, 0],
  "├": [0, 1, 1, 1], "┤": [1, 0, 1, 1], "┬": [1, 1, 0, 1], "┴": [1, 1, 1, 0], "┼": [1, 1, 1, 1],
  "━": [1, 1, 0, 0, 1], "┃": [0, 0, 1, 1, 1],
};

/** One <text> per glyph (rsvg ignores per-glyph x lists) so cell width is exact. */
function textLayer(g: Grid, ox: number, oy: number, cw: number, ch: number, fs: number) {
  let out = "";
  const strokes = new Map<string, string>();
  g.forEach((row, r) => {
    const y = (oy + r * ch + (ch - (ASC + DESC) * fs) / 2 + ASC * fs).toFixed(2);
    row.forEach((cell, c) => {
      if (!cell || cell.ch === " ") return;
      const ln = LINES[cell.ch];
      if (ln) {
        const [l, rr, u, d, hv] = ln, w = hv ? 2 : 1, x0 = ox + c * cw, y0 = oy + r * ch;
        const mx = Math.round(x0 + cw / 2) + (hv ? 0 : 0.5), my = Math.round(y0 + ch / 2) + (hv ? 0 : 0.5);
        let dd = "";
        if (l && rr) dd += `M${x0} ${my}H${x0 + cw}`; else if (l) dd += `M${x0} ${my}H${mx}`; else if (rr) dd += `M${mx} ${my}H${x0 + cw}`;
        if (u && d) dd += `M${mx} ${y0}V${y0 + ch}`; else if (u) dd += `M${mx} ${y0}V${my}`; else if (d) dd += `M${mx} ${my}V${y0 + ch}`;
        const k = cell.color + "|" + w;
        strokes.set(k, (strokes.get(k) ?? "") + dd);
        return;
      }
      const x = (ox + c * cw + (cw - ADV * fs) / 2).toFixed(2);
      out += `<text x="${x}" y="${y}" fill="${cell.color}">${esc(cell.ch)}</text>`; // rsvg ignores per-glyph x lists
    });
  });
  for (const [k, d] of strokes) {
    const [color, w] = k.split("|");
    out += `<path d="${d}" stroke="${color}" stroke-width="${w}" fill="none"/>`;
  }
  return `<g font-size="${fs.toFixed(2)}">${out}</g>`;
}

/** Halftone dot grid (14px, fading out radially like .hf-dots) + hairline "+" corner marks. */
function backdrop(W: number, H: number, th: Theme) {
  let out = "";
  for (let y = 7; y < H; y += 14)
    for (let x = 7; x < W; x += 14) {
      const d = Math.hypot((x - W / 2) / (W * 0.5), (y - H / 2) / (H * 0.5));
      const o = 0.14 * clamp(1 - d / 1.05);
      if (o > 0.012) out += `<circle cx="${x}" cy="${y}" r="1" fill="${th.muted}" fill-opacity="${o.toFixed(3)}"/>`;
    }
  const m = 12, a = 6, st = mix(th.muted, th.bg, 0.55);
  for (const [x, y] of [[m, m], [W - m, m], [m, H - m], [W - m, H - m]])
    out += `<path d="M${x - a} ${y}H${x + a}M${x} ${y - a}V${y + a}" stroke="${st}" stroke-width="1" fill="none"/>`;
  return out;
}

const svgDoc = (W: number, H: number, th: Theme, back: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="${W * 2}" height="${H * 2}" viewBox="0 0 ${W} ${H}" font-family="Menlo, monospace"><rect width="${W}" height="${H}" fill="${th.bg}"/>${back}${body}</svg>`;

async function sh(cmd: string[], stdin?: string) {
  const p = Bun.spawn(cmd, { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  if (code) throw new Error(`${cmd[0]} failed: ${err}`);
  return new Uint8Array(out);
}

/** Render svg frames (2x) to PNG, then ffmpeg -> palette GIF at WxH. */
async function makeGif(name: string, W: number, H: number, fps: number, svgs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "hefyn-art-"));
  try {
    for (let i = 0; i < svgs.length; i += 8)
      await Promise.all(svgs.slice(i, i + 8).map((s, k) =>
        sh(["rsvg-convert", "-f", "png", "-o", join(dir, `f${String(i + k).padStart(4, "0")}.png`)], s)));
    mkdirSync(OUT, { recursive: true });
    const vf = `scale=${W}:${H}:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=64[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
    await sh(["ffmpeg", "-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(dir, "f%04d.png"),
      "-vf", vf, "-loop", "0", join(OUT, name)]);
    const size = Bun.file(join(OUT, name)).size;
    console.log(`${name}: ${svgs.length} frames @ ${fps} fps (${(svgs.length / fps).toFixed(1)} s), ${(size / 1024).toFixed(0)} KB`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 1. logo ----------
const RAMP = " .:+*%@";
const MARK = ["*@@@%", "@@@@%", "@@@@% .::::::", "@@@@%+@@@@@@@", "@@@@%+@@@@@@@", "@@@@% .: %%%%", "@@@@%   +@@@@", "@@@@%   +@@@@", "*@@@%   +@@@*"]
  .map((l) => l.padEnd(13));
// Menlo advance = cell width (fs = cw / 0.602), line height ~1.15x font size. The word uses a finer grid.
const L_W = 880, L_H = 272, L_OY = 16;
const DENSE = 1; // font size = DENSE x (cell width / Menlo advance)
const M_CW = 12, M_CH = 23, M_FS = DENSE * M_CW / ADV; // mark: 13x9 cells = 156x207 px
const W_CW = 6, W_CH = 11.5, W_FS = 1.25 * DENSE * W_CW / ADV /* a touch heavier so the fine word keeps weight */, W_COLS = 85, W_ROWS = 18; // word: 510x207 px
const GAP = 36, L_X = (L_W - (13 * M_CW + GAP + W_COLS * W_CW)) / 2;

/** Rasterize the real wordmark and map cell coverage to the ramp (sharp threshold so letters stay legible). */
async function wordGrid() {
  const w = W_COLS * W_CW, h = Math.round(W_ROWS * W_CH);
  const tmp = mkdtempSync(join(tmpdir(), "hefyn-word-"));
  try {
    await sh(["rsvg-convert", "-w", String(w), "-h", String(h), "-o", join(tmp, "w.png"), join(ROOT, "assets/brand/hefyn-wordmark.svg")]);
    const px = await sh(["magick", join(tmp, "w.png"), "-alpha", "extract", "-depth", "8", "gray:-"]);
    return Array.from({ length: W_ROWS }, (_, r) =>
      Array.from({ length: W_COLS }, (_, c) => {
        const [y0, y1] = [Math.round(r * W_CH), Math.round((r + 1) * W_CH)];
        let s = 0;
        for (let y = y0; y < y1; y++) for (let x = 0; x < W_CW; x++) s += px[y * w + c * W_CW + x];
        const cov = s / ((y1 - y0) * W_CW * 255);
        return cov < 0.3 ? " " : RAMP[1 + Math.min(5, Math.floor(Math.pow((cov - 0.3) / 0.7, 0.7) * 6))];
      }).join(""));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function logo() {
  const word = await wordGrid();
  console.log(word.join("\n"));
  const TAG = "self-hosted coding agents for teams";
  const wx = L_X + 13 * M_CW + GAP, MAXP = wx - L_X + W_COLS * W_CW + 9 * M_CH;
  // [grid origin x, cell w, cell h, font size, final glyphs, base colour kind]
  const layers = [
    { x: L_X, cw: M_CW, ch: M_CH, fs: M_FS, fin: MARK, accent: true },
    { x: wx, cw: W_CW, ch: W_CH, fs: W_FS, fin: word, accent: false },
  ];
  const FPS = 20, N = 100;
  for (const th of THEMES) {
    const back = backdrop(L_W, L_H, th);
    const tag = newGrid(1, TAG.length);
    [...TAG].forEach((ch, i) => (tag[0][i] = { ch, color: th.muted }));
    const tagSvg = textLayer(tag, (L_W - TAG.length * 8) / 2, L_OY + 9 * M_CH + 14, 8, 16, 8 / ADV);
    const svgs: string[] = [];
    for (let f = 0; f < N; f++) {
      const t = f / FPS;
      let body = "";
      layers.forEach((ly, li) => {
      const g = newGrid(ly.fin.length, ly.fin[0].length);
      for (let r = 0; r < g.length; r++)
        for (let c = 0; c < g[0].length; c++) {
          const fin = ly.fin[r][c];
          const base = ly.accent ? th.accent : th.fg;
          const p0 = (ly.x - L_X + c * ly.cw + r * ly.ch) / MAXP;
          const p = clamp(p0 + (rnd(1, c, r, li) - 0.5) * 0.12);
          // dissolve 0.4-0.6 s, scrambled, decode settles 1.2-2.0 s (diagonal wave from top-left)
          let ch = fin, color = base;
          if (t >= 0.4 + 0.2 * p && t < 1.2 + 0.8 * p) {
            const k = f >> 1; // glyphs change every other frame: calmer, and keeps the GIF small
            ch = fin === " " && rnd(2, k, c, r, li) < (li ? 0.85 : 0.55) ? " " : RAMP[Math.floor(rnd(3, k, c, r, li) * 7)];
            color = mix(base, th.bg, 0.75);
          } else if (t >= 2 && t < 3.6) {
            // glint: a soft diagonal band, one ramp step lighter, passes once
            const pos = -0.15 + ((t - 2) / 1.6) * 1.3;
            if (Math.abs(p0 - pos) < 0.08 && fin !== " ") {
              ch = RAMP[Math.max(1, RAMP.indexOf(fin) - 1)];
              color = mix(base, th.bg, 0.8);
            }
          }
          g[r][c] = { ch, color };
        }
      body += textLayer(g, ly.x, L_OY, ly.cw, ly.ch, ly.fs);
      });
      svgs.push(svgDoc(L_W, L_H, th, back, body + tagSvg));
    }
    await makeGif(`logo-${th.name}.gif`, L_W, L_H, FPS, svgs);
  }
}

// ---------- 2. hero ----------
const H_W = 1200, H_H = 520, H_CW = 10, H_FS = H_CW / ADV, H_CH = 19, H_COLS = 120;
type Kind = "line" | "fg" | "muted" | "accent";
interface HCell { ch: string; k: Kind; comp?: string; only?: string }
const FIRST_ROW = 2, LAST_ROW = 24;

function heroBase() {
  const cells = new Map<string, HCell>();
  const put = (x: number, y: number, s: string, k: Kind, comp?: string, only?: string) =>
    [...s].forEach((ch, i) => cells.set(`${x + i},${y}`, { ch, k, comp, only }));
  const mid = (s: string, x0: number, x1: number) => x0 + Math.floor((x1 - x0 + 1 - s.length) / 2);
  const box = (x0: number, y0: number, x1: number, y1: number, comp?: string) => {
    for (let x = x0 + 1; x < x1; x++) { put(x, y0, "─", "line", comp); put(x, y1, "─", "line", comp); }
    for (let y = y0 + 1; y < y1; y++) { put(x0, y, "│", "line", comp); put(x1, y, "│", "line", comp); }
    put(x0, y0, "┌", "line", comp); put(x1, y0, "┐", "line", comp);
    put(x0, y1, "└", "line", comp); put(x1, y1, "┘", "line", comp);
  };
  const P = { L: 18, PB: 15, GX: 92, BX: 102 };
  const py = [5, 10, 15], ty = [9, 14, 19];
  const cx = [0, 1, 2].map((i) => P.L + 2 + i * 24 + 11);

  // people
  put(1, 3, "your team", "muted");
  ["lena", "tobias", "sofia"].forEach((n, j) => {
    const y0 = py[j] - 1, c = "p" + j;
    box(1, y0, 13, y0 + 3, c);
    put(3, y0 + 1, n, "fg", c);
    put(3, y0 + 2, "▫ browser", "muted", c);
    put(13, py[j], "├", "line", c);
    put(14, py[j], "─", "line");
  });
  put(P.PB, 5, "┬", "line"); put(P.PB, 10, "┤", "line"); put(P.PB, 15, "┘", "line");
  for (const y of [6, 7, 8, 9, 11, 12, 13, 14]) put(P.PB, y, "│", "line");
  put(P.PB + 1, 5, "──", "line"); put(P.L, 5, "┼", "line"); put(P.L + 1, 5, "►", "line");
  put(14, 10, "─", "line"); put(14, 15, "─", "line");

  // hefyn box
  box(P.L, 2, P.GX, 16);
  put(P.L + 2, 2, " hefyn · self-hosted ", "accent");
  box(P.L + 2, 4, P.L + 72, 6, "bar");
  const bt = "login · roles · keys · usage";
  put(mid(bt, P.L + 2, P.L + 72), 5, bt, "fg", "bar");
  ["Claude Code", "Codex", "Pi"].forEach((n, i) => {
    const x0 = P.L + 2 + i * 24, c = "sb" + i, x = cx[i];
    box(x0, 8, x0 + 22, 11, c);
    put(mid(n, x0, x0 + 22), 9, n, "fg", c);
    put(x0 + 1, 10, "sandbox · no network", "muted", c);
    put(x, 6, "┬", "line", "bar"); put(x, 7, "│", "line"); put(x, 8, "┴", "line", c);
    put(x, 11, "┬", "line", c); put(x, 12, "│", "line"); put(x, 13, "┴", "line", "gw");
  });
  box(P.L + 2, 13, P.L + 72, 15, "gw");
  const gx = mid("gateway  + adds the real key", P.L + 2, P.L + 72);
  put(gx, 14, "gateway", "fg", "gw"); put(gx + 9, 14, "+ adds the real key", "muted", "gw");
  // egress gate on the box edge
  for (const y of [13, 14, 15]) put(P.GX, y, "┃", "line", "gate");
  put(P.GX + 1, 13, "egress", "muted"); put(P.GX + 1, 15, "allowlist", "muted");
  put(P.GX + 1, 16, "✓ allowed", "accent", "gate", "gate");
  put(P.GX + 1, 14, "─".repeat(9), "line");

  // outside
  put(104, 7, "outside", "muted");
  ["Anthropic", "OpenAI", "MCP servers"].forEach((n, j) => {
    const y = ty[j], c = "pr" + j;
    box(104, y - 1, 118, y + 1, c);
    put(mid(n, 104, 118), y, n, "fg", c);
    put(P.BX + 1, y, "►", "line");
  });
  put(P.BX, 9, "┌", "line"); put(P.BX, 14, "┼", "line"); put(P.BX, 19, "└", "line");
  for (const y of [10, 11, 12, 13, 15, 16, 17, 18]) put(P.BX, y, "│", "line");

  // footer
  const caps = ["every person gets their own sandbox", "model keys never enter the sandbox", "only allowed hosts go out"];
  const gap = Math.floor((118 - caps.reduce((a, s) => a + s.length, 0)) / 2);
  caps.reduce((x, s) => (put(x, 24, s, "muted"), x + s.length + gap), 1);

  // ---- pulse timelines (cells in path order) ----
  const line = (...pts: number[][]) => {
    const out: number[][] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      for (let k = i ? 1 : 0; k <= n; k++) out.push([a[0] + Math.sign(b[0] - a[0]) * k, a[1] + Math.sign(b[1] - a[1]) * k]);
    }
    return out;
  };
  type Seg = { move: number[][] } | { hold: string; n: number };
  type State = { cells: number[][]; fwd: boolean; comps: string[] };
  const tracks = [0, 1, 2].map((j) => {
    const toBar = j ? line([14, py[j]], [P.PB, py[j]], [P.PB, 5], [P.L + 1, 5]) : line([14, 5], [P.L + 1, 5]);
    const out = line([P.GX + 1, 14], [P.BX, 14], [P.BX, ty[j]], [P.BX + 1, ty[j]]);
    const segs: Seg[] = [
      { hold: "p" + j, n: 3 }, { move: toBar }, { hold: "bar", n: 6 }, { move: [[cx[j], 7]] }, { hold: "sb" + j, n: 5 },
      { move: [[cx[j], 12]] }, { hold: "gw", n: 6 }, { move: [[P.GX - 1, 14]] }, { hold: "gate", n: 4 },
      { move: out }, { hold: "pr" + j, n: 5 },
    ];
    const back: Seg[] = segs.slice(0, -1).reverse().map((s) =>
      "move" in s ? { move: [...s.move].reverse() } : { hold: s.hold, n: Math.max(2, s.n - 2) });
    const states: State[] = [];
    const flatten = (list: Seg[], fwd: boolean) => {
      for (const s of list) {
        if ("hold" in s) for (let i = 0; i < s.n; i++) states.push({ cells: [], fwd, comps: [s.hold] });
        else for (let i = 0; i < s.move.length; i += 2) {
          const h = Math.min(i + 1, s.move.length - 1);
          states.push({ cells: s.move.slice(Math.max(0, h - 4), h + 1), fwd, comps: [] });
        }
      }
    };
    flatten(segs, true); flatten(back, false);
    return states;
  });
  return { cells, tracks };
}

function hero() {
  const { cells, tracks } = heroBase();
  const FPS = 20, T = 120, OFF = [0, 40, 80];
  for (const t of tracks) if (t.length > T) throw new Error(`pulse track ${t.length} > loop ${T}`);
  const oy = (H_H - (LAST_ROW - FIRST_ROW + 1) * H_CH) / 2 - FIRST_ROW * H_CH;
  return Promise.all(THEMES.map(async (th) => {
    const back = backdrop(H_W, H_H, th);
    const col: Record<Kind, string> = { line: mix(th.muted, th.bg, 0.55), fg: th.fg, muted: th.muted, accent: th.accent };
    const pulse = mix(th.accent, th.fg, 0.55);
    const svgs: string[] = [];
    for (let f = 0; f < T; f++) {
      const g = newGrid(Math.ceil(H_H / H_CH), H_COLS);
      const active = new Set<string>();
      let shapes = "";
      tracks.forEach((tr, j) => {
        const s = (((f - OFF[j]) % T) + T) % T;
        if (s >= tr.length) return;
        const st = tr[s];
        st.comps.forEach((c) => active.add(c));
        st.cells.forEach((c, i) => {
          // bright head with a halo, then a trail of shrinking, fading dots along the path
          const age = st.cells.length - 1 - i, clr = st.fwd ? th.accent : pulse;
          const cx = c[0] * H_CW + H_CW / 2, cy = oy + c[1] * H_CH + H_CH / 2;
          if (!age) shapes += `<circle cx="${cx}" cy="${cy}" r="9" fill="${clr}" fill-opacity="0.22"/>`;
          shapes += `<circle cx="${cx}" cy="${cy}" r="${age ? 3.6 - 0.6 * age : 5}" fill="${clr}" fill-opacity="${age ? 0.85 - 0.2 * age : 1}"/>`;
        });
      });
      for (const [key, c] of cells) {
        if (c.only && !active.has(c.only)) continue;
        const [x, y] = key.split(",").map(Number);
        g[y][x] = { ch: c.ch, color: c.comp && active.has(c.comp) ? th.accent : col[c.k] };
      }
      svgs.push(svgDoc(H_W, H_H, th, back, textLayer(g, 0, oy, H_CW, H_CH, H_FS) + shapes));
    }
    await makeGif(`hero-${th.name}.gif`, H_W, H_H, FPS, svgs);
  }));
}

const which = process.argv[2];
if (!which || which === "logo") await logo();
if (!which || which === "hero") await hero();
