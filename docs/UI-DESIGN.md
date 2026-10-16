# hefyn — UI design (v3)

Replaces v2. No colours, logo or theme files from the native app (now warden) are used any more; hefyn has
its own identity. Reference point: the calm, keyboard-first density of tools like T3 Code (shadcn/ui on
Base UI, zinc neutrals, lucide icons) — but with hefyn's own signature: the redaction bar.

Subject: a team workspace where AI agents work on company data and nothing personal reaches the model
unsealed. Audience: people who are not terminal users but work with agents every day. Primary job: give a
task, follow the agent, see what left the building.

## Signature: the redaction bar

The brand mark is a short horizontal bar on a rounded square — the black bar of a redacted document.
The same bar appears where it carries meaning:
- **Seals**: in the user's own messages, sealed values get a 2 px violet bar *under* the text (not a
  dotted underline); hover/focus shows "Sent to the model as EMAIL_1".
- **Ledger payloads**: placeholders render as solid violet bars with the seal name in mono inside.
- **Logo/wordmark**: `hefyn` in the UI sans, the mark to its left.
When a message is sent, its seals slide in once (180 ms, left to right) when the audit arrives — the only
ambient motion. Panels open instantly (no slide animations), like T3 Code's default.

## Tokens

Neutrals are zinc, monochrome-first; colour is reserved for meaning.

| Token | Light | Dark | Use |
|---|---|---|---|
| background | `#FFFFFF` | `#09090B` | app canvas |
| surface | `#FAFAFA` | `#111113` | sidebar, panels |
| raised | `#FFFFFF` | `#18181B` | menus, dialogs, composer |
| foreground | `#09090B` | `#FAFAFA` | text, primary buttons (inverted) |
| muted | `#71717A` | `#A1A1AA` | secondary text, icons |
| border | `#E4E4E7` | `#27272A` | hairlines |
| seal | `#5B3DF5` | `#8B7BFF` | seals, agents, privacy — the only brand colour |
| success / danger / warning | `#16A34A` / `#DC2626` / `#CA8A04` | `#4ADE80` / `#F87171` / `#FACC15` | status only (+ AA text variants) |

- **Primary action = foreground fill** (black button on light, white on dark), like shadcn. Secondary =
  border + transparent. Destructive = danger text, filled only in confirm dialogs.
- **Type**: IBM Plex Sans for UI (13/18 controls, 14/22 body, 16/24 transcript prose, 20/28 titles,
  semibold, no tracking games) and IBM Plex Mono for machine text (code, tool output, payloads, seal names,
  keyboard shortcuts). Self-hosted via fontsource. Sentence case everywhere, no all-caps labels.
- **Geometry**: compact. Controls 32 px high, radius 8; panels/dialogs radius 12; chips/seals radius 6
  (bars, not pills). Hairline borders, no drop shadows except floating layers (composer, menus,
  command palette, dialogs) which use a subtle shadow + `backdrop-blur(12px)` at 80 % opacity.
- **Icons**: lucide, 16 px, stroke 1.75, muted colour by default.

## Layout

```
┌───────────────────────┬────────────────────────────────────────────┬──────────────┐
│ ▣ hefyn        ⌘K  ⇤  │ Q3 summary            model ▾   ▭ 2   ⌘J  │ Ledger       │
│───────────────────────│────────────────────────────────────────────│ (right panel │
│ ✎ New chat            │                                            │  ⌘L; also    │
│ ⌕ Search              │   user message (subtle surface block)      │  files/diff) │
│ ▤ Files   ⬡ Hub       │                                            │              │
│───────────────────────│   ● read /files/q3.csv              12 ms  │              │
│ Today                 │   ● writer  Draft the summary     1.8 s ▾  │              │
│  Q3 summary        ●  │   │  …                                     │              │
│  Pricing review       │   answer prose (68ch)                      │              │
│ Earlier               │                                            │              │
│  …                    │  ┌───────────── composer ─────────────┐    │              │
│───────────────────────│  │ Ask hefyn…          📎  model  ⏎  │    │              │
│ ⚙ Settings   ◯ Ada ▾  │  └────────────────────────────────────┘    │              │
└───────────────────────┴──────────────────┬─────────────────────────┴──────────────┘
                                           │ terminal drawer (⌘J): sandbox shell output
```
- **One sidebar** (260 px, collapsible with ⇤ / ⌘B): brand + command palette button, primary actions
  (New chat, Search, Files, Hub), threads grouped by day with a running indicator, settings + account at
  the bottom. No separate icon rail.
- **Top bar** (48 px): thread title (editable), model picker, ledger toggle with seal count, terminal toggle.
- **Transcript**: left-aligned, max 68ch, 16 px prose. User messages: subtle surface block, full width of
  the column (not chat bubbles). Tool calls and delegations: compact one-line rows with a status dot,
  expandable; delegated agents indent with a seal-coloured rail.
- **Right panel** (360 px, ⌘L): Ledger by default; also shows a file preview or diff when opened from a step.
- **Terminal drawer** (bottom, ⌘J): the sandbox shell's commands and output for this thread, mono, dark in
  both themes.
- **Command palette** (⌘K): new chat, switch thread, open settings pages, connect a model, toggle
  ledger/terminal, change theme (system/light/dark), search the hub.
- **Settings**: a page with a left section list and rows (label + one-line help | control), shadcn-style.
- **Hub**: dense table-like list with kind icon, name, description, source; detail in the right panel.
- Responsive: <1100 px right panel overlays; <800 px sidebar becomes a sheet; composer stays docked.

## Principles
1. Monochrome first. Colour means something: violet = sealed/agent, red = blocked/destructive.
2. Keyboard first: every main action has a shortcut and is in the palette; focus is always visible
   (2 px foreground ring with offset).
3. Dense but breathable: 32 px controls, 8 px grid, generous transcript measure.
4. One motion moment (seals sliding in); everything else is instant. `prefers-reduced-motion` respected.
5. Copy: plain verbs, sentence case, errors say what to do next.
