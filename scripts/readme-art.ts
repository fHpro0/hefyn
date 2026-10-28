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
// The big ASCII "h" (the mark) is the word's first letter; a small "efyn" cropped from the real wordmark completes it.
// Menlo advance = cell width (fs = cw / 0.602). The h is ~1.45x the height of the f in efyn.
const L_W = 620, L_H = 320, L_OY = 14;
const M_CW = 12, M_CH = 22, M_FS = M_CW / ADV; // mark: 13x9 cells = 156x198 px
const W_CW = 4, W_CH = 6, W_FS = 1.25 * W_CW / ADV /* a touch heavier so the fine word keeps weight */; // efyn grid
const BASE = 156; // px from the raster top to the wordmark baseline (svg y 712, viewBox top 284) = 26 efyn rows
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
  const TAG = "one login · shared workflows · your team's agents";
  const markBottom = L_OY + 9 * M_CH, wy = markBottom - BASE; // efyn baseline sits on the mark's baseline
  const wW = word[0].length * W_CW, L_X = (L_W - (13 * M_CW + GAP + wW)) / 2, wx = L_X + 13 * M_CW + GAP;
  const MAXP = 13 * M_CW + GAP + wW + (wy + word.length * W_CH - L_OY);
  const layers = [
    { x: L_X, y: L_OY, cw: M_CW, ch: M_CH, fs: M_FS, fin: MARK, accent: true },
    { x: wx, y: wy, cw: W_CW, ch: W_CH, fs: W_FS, fin: word, accent: false },
  ];
  const tagY = wy + word.length * W_CH + 10;
  if (tagY + 16 + 12 > L_H) throw new Error("canvas too short for the subtitle");
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

// ---------- 2. hero: one login, private or shared workflows, one team account per CLI ----------
// Story (10 s loop, 200 frames): lena sends a workflow through the one gate into her PRIVATE panel, types it,
// runs it on Claude Code + ERP; she shares it (the row slides up into the team panel); tobias and sofia use it
// (row counter 1->3, Claude Code's "in use by" 1->3: one team account, three people); the row fades out and the
// counters ease back, so the last frame equals frame 0. No model is ever picked: people pick workflows.
const H_W = 1200, H_H = 520, H_CW = 10, H_FS = H_CW / ADV, H_CH = 19, H_COLS = 120;
type Kind = "line" | "fg" | "muted" | "accent";
interface HCell { ch: string; k: Kind; comp?: string; only?: string }
const FIRST_ROW = 1, LAST_ROW = 24;
const HFPS = 20, HT = 200;
const GX = 22, BUS = 20, RB = 78; // gate column, person bus column, right-hand bus column
const FR = 76, PR = 73, AX = 82; // frame and panel right edges, team-accounts box left edge
const PY = [5, 10, 15, 20]; // person name rows (each person box is 4 rows: name + "private sessions")
const TEAM_Y = 10, PRIV_Y = 15; // the empty team slot row and lena's private row
const ROW_NAME = "▸ Month-end close";
// timeline (frames)
const TYPE0 = 20, SHARE0 = 90, SLIDE0 = 98, SLIDE1 = 112, FADE0 = 164, FADE1 = 180;
const ROW_TICKS = [112, 129, 143]; // "used by" 1,2,3 on the shared row
const CL_TICKS = [52, 139, 153]; // Claude Code "in use by" 1,2,3 ...
const CL_DOWN = [164, 168, 172]; // ... eased back to 0

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
    box(1, y - 1, 19, y + 2, c);
    put(3, y, n, "fg", c);
    if (!j) put(3 + n.length, y, " · admin", "muted", c);
    put(3, y + 1, "private sessions", "muted", c);
    put(19, y, "├", "line", c);
  });
  put(BUS, PY[0], "┐", "line"); put(BUS, PY[1], "┤", "line"); put(BUS, PY[2], "┤", "line"); put(BUS, PY[3], "┘", "line");
  for (const y of [6, 7, 8, 9, 12, 13, 14, 16, 17, 18, 19]) put(BUS, y, "│", "line");
  put(BUS, 11, "├", "line"); put(21, 11, "►", "line");

  // hefyn frame; its left edge is the gate (drawn as a rect in hero())
  box(GX, 2, FR, 21);
  for (let y = 3; y <= 20; y++) cells.delete(`${GX},${y}`);
  put(26, 2, " hefyn ", "accent");
  put(GX - 4, 1, "one login", "accent");
  put(GX - 5, 23, "✓ signed in", "accent", "gate", "gate");

  // team workflows
  box(25, 4, PR, 11);
  put(27, 4, " team workflows ", "fg");
  ([["Invoice processing", "anna", 4], ["Support triage", "lena", 4]] as const).forEach(([n, a, u], i) => {
    const y = 6 + 2 * i;
    put(27, y, ("▸ " + n).padEnd(21), "fg"); put(48, y, "by " + a, "muted"); put(63, y, "used by " + u, "muted");
  });
  put(27, TEAM_Y, "▫ free slot", "line", "slot");
  // private panel
  box(25, 13, PR, 17);
  put(27, 13, " private · lena ", "fg");
  put(27, PRIV_Y, "▫ nothing private yet", "line", "privslot");
  // inner bus from the gate to the three team rows and the private row
  put(23, 6, "┌", "line"); put(23, 7, "│", "line"); put(23, 8, "├", "line"); put(23, 9, "│", "line");
  put(23, 10, "├", "line"); put(23, 11, "┤", "line");
  for (const y of [12, 13, 14]) put(23, y, "│", "line");
  put(23, 15, "└", "line");
  for (const y of [6, 8, TEAM_Y, PRIV_Y]) put(24, y, "►", "line");
  // hint
  const hint = "pick a workflow, not a model";
  put(mid(hint, 25, PR), 19, hint, "muted");

  // team accounts (one per CLI), set up once by the admin; line 2 carries the session counter
  put(AX, 1, "set up once by anna", "muted");
  box(AX, 2, 118, 16); put(AX + 2, 2, " team accounts · one per CLI ", "fg");
  ["Claude Code", "Codex", "OpenCode", "Pi"].forEach((n, i) => {
    const y = 5 + 3 * i;
    put(AX + 2, y, n, "fg", "a" + i);
    if (i) put(AX + 2, y + 1, `team account · ${[0, 2, 1, 0][i]} private session${[0, 2, 1, 0][i] == 1 ? "" : "s"}`, "muted");
  });
  box(AX, 18, 118, 21); put(AX + 2, 18, " tools ", "fg");
  ["ERP", "Wiki"].forEach((n, i) => put(AX + 2, 19 + i, n, "fg", "t" + i));

  // team/private rows -> right bus -> accounts and tools
  for (const y of [TEAM_Y, PRIV_Y]) { put(PR, y, "├", "line"); put(PR + 1, y, "──", "line"); put(FR, y, "┼", "line"); put(FR + 1, y, "─", "line"); }
  put(RB, 5, "┌", "line");
  for (const y of [6, 7, 9, 12, 13, 16, 17, 18]) put(RB, y, "│", "line");
  for (const y of [8, 11, 14, 19]) put(RB, y, "├", "line");
  put(RB, TEAM_Y, "┤", "line"); put(RB, PRIV_Y, "┤", "line"); put(RB, 20, "└", "line");
  for (const y of [5, 8, 11, 14, 19, 20]) { put(RB + 1, y, "──", "line"); put(RB + 3, y, "►", "line"); }

  // footer, spread out
  const caps = ["one login, private sessions", "workflows: private or team", "one team account per CLI"];
  const x3 = 119 - caps[2].length, x2 = Math.floor((1 + caps[0].length + x3 - caps[1].length) / 2);
  [1, x2, x3].forEach((x, i) => put(x, 24, caps[i], "muted"));

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
  const toGate = (j: number) => line([BUS, PY[j]], [BUS, 11], [21, 11]);
  const toClaude = (y: number) => line([PR + 1, y], [RB, y], [RB, 5], [RB + 3, 5]);
  const toErp = (y: number) => line([PR + 1, y], [RB, y], [RB, 19], [RB + 3, 19]);
  const pulses = [
    // lena -> gate -> private row (it types in while her pulse rests there)
    pulse(7, [{ hold: "p1", n: 3 }, { move: toGate(1) }, { hold: "gate", n: 5 }, { move: line([23, 11], [23, PRIV_Y], [24, PRIV_Y]) }, { hold: "new", n: 18 }]),
    // the private row runs on Claude Code and ERP ...
    pulse(40, [{ hold: "new", n: 3 }, { move: toClaude(PRIV_Y) }, { hold: "a0", n: 8 }]),
    pulse(40, [{ hold: "new", n: 3 }, { move: toErp(PRIV_Y) }, { hold: "t0", n: 8 }]),
    // ... and the results return to lena
    pulse(62, [{ move: [...toClaude(PRIV_Y)].reverse() }, { hold: "new", n: 3 },
      { move: line([24, PRIV_Y], [23, PRIV_Y], [23, 11], [21, 11], [BUS, 11], [BUS, PY[1]]) }, { hold: "p1", n: 4 }], false),
    pulse(58, [{ move: [...toErp(PRIV_Y)].reverse() }, { hold: "new", n: 2 }], false),
    // tobias and sofia use the shared row: same gate, same team account
    ...[[117, 2, 4], [128, 3, 4]].map(([start, j, gateN]) => pulse(start, [
      { hold: "p" + j, n: 3 }, { move: toGate(j) }, { hold: "gate", n: gateN }, { move: line([23, 11], [23, TEAM_Y], [24, TEAM_Y]) },
      { hold: "new", n: 3 }, { move: toClaude(TEAM_Y) }, { hold: "a0", n: 6 },
    ])),
  ];
  for (const p of pulses) if (p.start + p.states.length > HT) throw new Error("pulse runs past the loop end");
  return { cells, pulses };
}

function hero() {
  const { cells, pulses } = heroBase();
  const oy = (H_H - (LAST_ROW - FIRST_ROW + 1) * H_CH) / 2 - FIRST_ROW * H_CH;
  const gx = GX * H_CW + H_CW / 2, gy = oy + 3 * H_CH, gh = 18 * H_CH;
  const ease = (t: number) => t * t * (3 - 2 * t);
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
      const slotBusy = f >= SLIDE0 - 2 && f < FADE1 + 4, privBusy = f >= TYPE0 - 2 && f < SLIDE0 + 2;
      for (const [key, c] of cells) {
        if (c.only && !active.has(c.only)) continue;
        if ((c.comp === "slot" && slotBusy) || (c.comp === "privslot" && privBusy)) continue;
        const [x, y] = key.split(",").map(Number);
        g[y][x] = { ch: c.ch, color: c.comp && active.has(c.comp) ? th.accent : col[c.k] };
      }
      const put = (x: number, y: number, s: string, c: string) =>
        [...s].forEach((ch, i) => { if (ch !== " ") g[y][x + i] = { ch, color: c }; });
      // Claude Code's counter: one team account, many people (flashes on each tick, eases back at the end)
      const ups = CL_TICKS.filter((t) => f >= t).length, downs = CL_DOWN.filter((t) => f >= t).length;
      const cn = ups - downs;
      put(AX + 2, 6, "team account · ", th.muted);
      put(AX + 17, 6, `${cn}`, CL_TICKS.some((t) => f >= t && f < t + 6) ? th.accent : th.muted);
      put(AX + 18, 6, ` private session${cn == 1 ? "" : "s"}`, th.muted);

      // the new workflow row: typed in privately, shared (slides up), counted, faded out. Drawn on its own
      // layer at a fractional y so the slide is smooth.
      const typed = f < TYPE0 ? 0 : Math.min(ROW_NAME.length, f - TYPE0 + 1);
      const fade = f >= FADE0 ? clamp(1 - (f - FADE0) / (FADE1 - FADE0)) : 1;
      let rowSvg = "";
      if (typed && fade > 0) {
        const r1 = newGrid(1, H_COLS), hl = active.has("new");
        const p1 = (x: number, s: string, c: string) =>
          [...s].forEach((ch, i) => { if (ch !== " ") r1[0][x + i] = { ch, color: mix(c, th.bg, fade) }; });
        const shared = f >= SLIDE1, sliding = f >= SLIDE0 && !shared;
        p1(27, ROW_NAME.slice(0, typed), hl || typed < ROW_NAME.length || f >= SHARE0 && !shared ? th.accent : th.fg);
        if (typed < ROW_NAME.length) p1(27 + typed, "█", th.accent);
        else if (f >= TYPE0 + ROW_NAME.length && f < SHARE0) p1(48, "private · only lena", th.muted);
        else if (f >= SHARE0 && !shared) p1(48, "share →", th.accent);
        else if (shared) {
          p1(48, "by lena", th.muted); p1(56, "team ✓", th.accent);
          const n = ROW_TICKS.filter((t) => f >= t).length;
          p1(63, `used by ${n}`, ROW_TICKS.some((t) => f >= t && f < t + 6) ? th.accent : th.muted);
        }
        const y = sliding ? PRIV_Y + (TEAM_Y - PRIV_Y) * ease((f - SLIDE0) / (SLIDE1 - SLIDE0)) : shared ? TEAM_Y : PRIV_Y;
        rowSvg = textLayer(r1, 0, oy + y * H_CH, H_CW, H_CH, H_FS);
      }
      // the gate: always lit, strongest accent when someone signs in
      const on = active.has("gate");
      const gate = on
        ? `<rect x="${gx - 9}" y="${gy}" width="18" height="${gh}" fill="${th.accent}" fill-opacity="0.22"/><rect x="${gx - 3}" y="${gy}" width="6" height="${gh}" fill="${th.accent}"/>`
        : `<rect x="${gx - 2}" y="${gy}" width="4" height="${gh}" fill="${th.accent}" fill-opacity="0.6"/>`;
      svgs.push(svgDoc(H_W, H_H, th, back, textLayer(g, 0, oy, H_CW, H_CH, H_FS) + rowSvg + gate + shapes));
    }
    await makeGif(`hero-${th.name}.gif`, H_W, H_H, HFPS, svgs);
  }));
}

const which = process.argv[2];
if (!which || which === "logo") await logo();
if (!which || which === "hero") await hero();
