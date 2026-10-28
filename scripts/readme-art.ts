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
// The big ASCII "h" (the mark) is the word's first letter; a small "efyn" cropped from the real wordmark completes it.
const L_W = 704, L_H = 384, L_OY = 18;
const M_CW = 16, M_CH = 30, M_FS = M_CW / ADV; // mark: 13x9 cells = 208x270 px
const W_CW = 4, W_CH = 6, W_FS = 1.25 * W_CW / ADV /* a touch heavier so the fine word keeps weight */; // efyn grid
const BASE = 114; // px from the raster top to the wordmark baseline (svg y 712, viewBox top 284) = 19 efyn rows
const K = BASE / (712 - 284); // wordmark px per svg unit
const GAP = M_CW; // one mark cell between the h and the e

/** Rasterize the real wordmark, crop the h off at the empty column gap, map cell coverage to the ramp. */
async function efynGrid() {
  const w = Math.round(1474 * K), h = Math.round(596 * K);
  const tmp = mkdtempSync(join(tmpdir(), "hefyn-word-"));
  try {
    await sh(["rsvg-convert", "-w", String(w), "-h", String(h), "-o", join(tmp, "w.png"), join(ROOT, "assets/brand/hefyn-wordmark.svg")]);
    const px = await sh(["magick", join(tmp, "w.png"), "-alpha", "extract", "-depth", "8", "gray:-"]);
    const ink = (x: number) => { for (let y = 0; y < h; y++) if (px[y * w + x] > 60) return true; return false; };
    let x = 0;
    while (!ink(x)) x++;      // left margin
    for (;;) {                // the h is a stem + an arch (gap ~5 px); the gap before the e is wider (>= 6 px)
      while (ink(x)) x++;
      const g = x;
      while (!ink(x)) x++;
      if (x - g >= 6) break;
    }
    const x0 = x;
    let x1 = w - 1;
    while (!ink(x1)) x1--;
    const cols = Math.ceil((x1 - x0 + 1) / W_CW), rows = Math.ceil(h / W_CH);
    return Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => {
        let s = 0;
        for (let y = r * W_CH; y < (r + 1) * W_CH; y++)
          for (let xx = c * W_CW; xx < (c + 1) * W_CW; xx++) {
            const px_ = x0 + xx;
            if (y < h && px_ <= x1) s += px[y * w + px_];
          }
        const cov = s / (W_CH * W_CW * 255);
        return cov < 0.3 ? " " : RAMP[1 + Math.min(5, Math.floor(Math.pow((cov - 0.3) / 0.7, 0.7) * 6))];
      }).join(""));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function logo() {
  const word = await efynGrid();
  const TAG = "one login · shared workflows · your team's coding agents";
  const markBottom = L_OY + 9 * M_CH, wy = markBottom - BASE; // efyn baseline sits on the mark's baseline
  const wW = word[0].length * W_CW, L_X = (L_W - (13 * M_CW + GAP + wW)) / 2, wx = L_X + 13 * M_CW + GAP;
  const MAXP = 13 * M_CW + GAP + wW + (wy + word.length * W_CH - L_OY);
  const layers = [
    { x: L_X, y: L_OY, cw: M_CW, ch: M_CH, fs: M_FS, fin: MARK, accent: true },
    { x: wx, y: wy, cw: W_CW, ch: W_CH, fs: W_FS, fin: word, accent: false },
  ];
  const tagY = wy + word.length * W_CH + 14;
  if (tagY + 16 + 14 > L_H) throw new Error("canvas too short for the subtitle");
  const FPS = 20, N = 100;
  for (const th of THEMES) {
    const back = backdrop(L_W, L_H, th);
    const tag = newGrid(1, TAG.length);
    [...TAG].forEach((ch, i) => (tag[0][i] = { ch, color: th.muted }));
    const tagSvg = textLayer(tag, (L_W - TAG.length * 8) / 2, tagY, 8, 16, 8 / ADV);
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
          const p0 = (ly.x - L_X + c * ly.cw + ly.y - L_OY + r * ly.ch) / MAXP;
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
      body += textLayer(g, ly.x, ly.y, ly.cw, ly.ch, ly.fs);
      });
      svgs.push(svgDoc(L_W, L_H, th, back, body + tagSvg));
    }
    await makeGif(`logo-${th.name}.gif`, L_W, L_H, FPS, svgs);
  }
}

// ---------- 2. hero: one login + shared workflows ----------
// Story: four people -> ONE gate -> shared workflows -> agents/tools. A loop of 8 s (160 frames):
// lena adds a workflow (typed in), tobias and sofia use it (counter ticks), it runs on Claude Code + ERP,
// results flow back to everyone, the new row fades out so frame 159 -> frame 0 is seamless.
const H_W = 1200, H_H = 520, H_CW = 10, H_FS = H_CW / ADV, H_CH = 19, H_COLS = 120;
type Kind = "line" | "fg" | "muted" | "accent";
interface HCell { ch: string; k: Kind; comp?: string; only?: string }
const FIRST_ROW = 1, LAST_ROW = 23;
const HFPS = 20, HT = 160;
const GX = 22, BUS = 19, NR = 12, PY = [5, 9, 13, 17];
const NEW_ROW = "▸ Month-end close".padEnd(24) + "by lena";
const TYPE0 = 18, TAG0 = 50, TICKS = [50, 67, 81], FADE0 = 128;

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

  // your team -> bus -> the one gate
  put(1, 1, "your team", "muted");
  ["anna", "lena", "tobias", "sofia"].forEach((n, j) => {
    const y = PY[j], c = "p" + j;
    box(1, y - 1, 16, y + 1, c);
    put(3, y, n, "fg", c);
    if (!j) put(3 + n.length, y, " · admin", "muted", c);
    put(16, y, "├", "line", c);
    put(17, y, "──", "line");
  });
  put(BUS, 5, "┐", "line"); put(BUS, 9, "┤", "line"); put(BUS, 13, "┤", "line"); put(BUS, 17, "┘", "line");
  for (const y of [6, 7, 8, 10, 12, 14, 15, 16]) put(BUS, y, "│", "line");
  put(BUS, 11, "├", "line"); put(20, 11, "─", "line"); put(21, 11, "►", "line");

  // hefyn frame; its left edge is the gate (drawn as a rect in hero())
  box(GX, 2, 84, 19);
  for (let y = 3; y <= 18; y++) cells.delete(`${GX},${y}`);
  put(26, 2, " hefyn ", "accent");
  put(GX - 4, 1, "one login", "accent");
  put(GX - 5, 20, "✓ signed in", "accent", "gate", "gate");

  // shared workflows panel
  box(25, 4, 81, 14);
  put(27, 4, " shared workflows ", "fg");
  ([["Invoice processing", "anna", 4], ["Support triage", "lena", 4], ["Onboarding checklist", "tobias", 3]] as const).forEach(([n, a, u], i) => {
    const y = 6 + 2 * i;
    put(27, y, ("▸ " + n).padEnd(24), "fg"); put(51, y, "by " + a, "muted"); put(72, y, "used by " + u, "muted");
  });
  put(23, 6, "┌", "line"); put(23, 7, "│", "line"); put(23, 8, "├", "line"); put(23, 9, "│", "line");
  put(23, 10, "├", "line"); put(23, 11, "┤", "line"); put(23, 12, "└", "line");
  for (const y of [6, 8, 10, 12]) put(24, y, "►", "line");
  // set-up strip
  box(25, 16, 81, 18);
  const s1 = "set up once by anna", s2 = ": agents · keys · tools", sx = mid(s1 + s2, 25, 81);
  put(sx, 17, s1, "fg"); put(sx + s1.length, 17, s2, "muted");

  // ready for everyone
  put(96, 1, "ready for everyone", "muted");
  box(96, 4, 118, 9); put(98, 4, " agents ", "muted");
  ["Claude Code", "Codex", "OpenCode", "Pi"].forEach((n, i) => put(98, 5 + i, n, "fg", "a" + i));
  box(96, 11, 118, 16); put(98, 11, " tools · models ", "muted");
  ["ERP", "Wiki", "Anthropic", "OpenAI"].forEach((n, i) => put(98, 12 + i, n, "fg", "t" + i));
  put(81, 12, "├", "line"); put(82, 12, "──", "line"); put(84, 12, "┼", "line"); put(85, 12, "─────", "line");
  put(90, 5, "┌", "line"); for (const y of [6, 7, 8, 13, 14]) put(90, y, "├", "line");
  for (const y of [9, 10, 11]) put(90, y, "│", "line");
  put(90, 12, "┼", "line"); put(90, 15, "└", "line");
  for (const y of [5, 6, 7, 8, 12, 13, 14, 15]) { put(91, y, "────", "line"); put(95, y, "►", "line"); }

  // footer
  const caps = ["sign in once, use every agent", "build a workflow once, the whole team uses it", "keys and tools set up once by an admin"];
  caps.reduce((x, s, i) => {
    put(x, 23, s, "muted");
    if (i < 2) put(x + s.length + 1, 23, "·", "muted");
    return x + s.length + 3;
  }, 1);

  // ---- pulses: cells in path order, holds highlight a component ----
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
  const pulse = (start: number, segs: Seg[], fwd = true) => {
    const states: State[] = [];
    for (const s of segs) {
      if ("hold" in s) for (let i = 0; i < s.n; i++) states.push({ cells: [], fwd, comps: [s.hold] });
      else for (let i = 0; i < s.move.length; i += 2) {
        const h = Math.min(i + 1, s.move.length - 1);
        states.push({ cells: s.move.slice(Math.max(0, h - 4), h + 1), fwd, comps: [] });
      }
    }
    return { start, states };
  };
  const toGate = (j: number) => line([17, PY[j]], [BUS, PY[j]], [BUS, 11], [21, 11]);
  const toRow = line([23, 11], [23, 12], [24, 12]);
  const use = (start: number, j: number, gateN: number, rowN: number) =>
    pulse(start, [{ hold: "p" + j, n: 3 }, { move: toGate(j) }, { hold: "gate", n: gateN }, { move: toRow }, { hold: "new", n: rowN }]);
  const pulses = [
    use(4, 1, 5, 32), // lena adds the workflow: lands at TYPE0, typing ends ~f48, pulse done at f50
    use(54, 2, 4, 5), // tobias uses it: lands f67
    use(66, 3, 4, 5), // sofia uses it: lands f81
    pulse(88, [{ hold: "new", n: 3 }, { move: line([82, 12], [90, 12], [90, 5], [95, 5]) }, { hold: "a0", n: 8 }]), // -> Claude Code
    pulse(88, [{ hold: "new", n: 3 }, { move: line([82, 12], [95, 12]) }, { hold: "t0", n: 8 }]), // -> ERP
    ...PY.map((y, k) => pulse(108, [
      { hold: "new", n: 2 }, { move: line([24, 12], [23, 12], [23, 11]) }, { hold: "gate", n: 3 },
      { move: line([21, 11], [BUS, 11], [BUS, y], [17, y]) }, { hold: "p" + k, n: 4 },
    ], false)), // results flow back to everyone
  ];
  for (const p of pulses) if (p.start + p.states.length > HT) throw new Error("pulse runs past the loop end");
  return { cells, pulses };
}

function hero() {
  const { cells, pulses } = heroBase();
  const oy = (H_H - (LAST_ROW - FIRST_ROW + 1) * H_CH) / 2 - FIRST_ROW * H_CH;
  const gx = GX * H_CW + H_CW / 2, gy = oy + 3 * H_CH, gh = 16 * H_CH;
  return Promise.all(THEMES.map(async (th) => {
    const back = backdrop(H_W, H_H, th);
    const col: Record<Kind, string> = { line: mix(th.muted, th.bg, 0.55), fg: th.fg, muted: th.muted, accent: th.accent };
    const ret = mix(th.accent, th.fg, 0.55);
    const svgs: string[] = [];
    for (let f = 0; f < HT; f++) {
      const g = newGrid(Math.ceil(H_H / H_CH), H_COLS);
      const active = new Set<string>();
      let shapes = "";
      for (const p of pulses) {
        const st = p.states[f - p.start];
        if (!st) continue;
        st.comps.forEach((c) => active.add(c));
        st.cells.forEach((c, i) => {
          // bright head with a halo, then a trail of shrinking, fading dots along the path
          const age = st.cells.length - 1 - i, clr = st.fwd ? th.accent : ret;
          const cx = c[0] * H_CW + H_CW / 2, cy = oy + c[1] * H_CH + H_CH / 2;
          if (!age) shapes += `<circle cx="${cx}" cy="${cy}" r="9" fill="${clr}" fill-opacity="0.22"/>`;
          shapes += `<circle cx="${cx}" cy="${cy}" r="${age ? 3.6 - 0.6 * age : 5}" fill="${clr}" fill-opacity="${age ? 0.85 - 0.2 * age : 1}"/>`;
        });
      }
      for (const [key, c] of cells) {
        if (c.only && !active.has(c.only)) continue;
        const [x, y] = key.split(",").map(Number);
        g[y][x] = { ch: c.ch, color: c.comp && active.has(c.comp) ? th.accent : col[c.k] };
      }
      // the new workflow row: typed in, tagged, counted, then faded out
      const typed = f < TYPE0 ? 0 : Math.min(NEW_ROW.length, f - TYPE0 + 1);
      const fade = f >= FADE0 ? clamp(1 - (f - FADE0) / 16) : 1;
      if (typed && fade > 0) {
        const hl = active.has("new"), put = (x: number, s: string, c: string) =>
          [...s].forEach((ch, i) => { if (ch !== " ") g[NR][x + i] = { ch, color: mix(c, th.bg, fade) }; });
        [...NEW_ROW.slice(0, typed)].forEach((ch, i) =>
          put(27 + i, ch, hl || typed < NEW_ROW.length ? th.accent : i >= 24 ? th.muted : th.fg));
        if (typed < NEW_ROW.length) put(27 + typed, "█", th.accent);
        if (f >= TAG0 && f < TAG0 + 14) put(61, "shared ✓", th.accent);
        const n = TICKS.filter((t) => f >= t).length;
        if (n) put(72, `used by ${n}`, TICKS.some((t) => f >= t && f < t + 6) ? th.accent : th.muted);
      }
      // the gate: always lit, strongest accent when someone signs in
      const on = active.has("gate");
      const gate = on
        ? `<rect x="${gx - 9}" y="${gy}" width="18" height="${gh}" fill="${th.accent}" fill-opacity="0.22"/><rect x="${gx - 3}" y="${gy}" width="6" height="${gh}" fill="${th.accent}"/>`
        : `<rect x="${gx - 2}" y="${gy}" width="4" height="${gh}" fill="${th.accent}" fill-opacity="0.6"/>`;
      svgs.push(svgDoc(H_W, H_H, th, back, textLayer(g, 0, oy, H_CW, H_CH, H_FS) + gate + shapes));
    }
    await makeGif(`hero-${th.name}.gif`, H_W, H_H, HFPS, svgs);
  }));
}

const which = process.argv[2];
if (!which || which === "logo") await logo();
if (!which || which === "hero") await hero();
