# hefyn — UI design (v3)

Replaces v2. No colours, logo or theme files from the native app (now warden) are used any more; hefyn has
its own identity. Reference point: the calm, keyboard-first density of tools like T3 Code (shadcn/ui on
Base UI, zinc neutrals, lucide icons).

Subject: a team workspace where AI agents work on company data. Audience: people who are not terminal users but work
with agents every day. Primary job: give a task and follow the agent.

## Brand

The logo is the original hefyn wordmark in hefyn blue (`#2563EB`, `assets/brand/`); its split "h" is the mark
(app icon: white h on blue). Use the drawn hefyn wordmark (`hefyn-wordmark.svg`, white variant on dark); never re-set it in the UI font.
The new-chat home shows the mark as ASCII art (`AsciiMark` in `components/ui.tsx`: ░▒▓█ glyphs in Geist Mono, `seal` colour,
`aria-hidden` with an sr-only label). `Wordmark` and `AsciiMark` decode in on mount via `ascii-reveal` (dither, top-left).
Co-brand lockup (sign-in pages, `Lockup` in `components/brand.tsx`): `hefyn × <company logo>`, the wordmark in its normal colours, a thin muted mono "×",
then the admin-uploaded logo (Settings → Workspace → Branding; ~28px tall, `object-contain`; the dark-mode logo on dark, else the same one).
No logo but a name: the name in Geist medium. Neither: the wordmark alone, no "×". Logos are data: URLs drawn only through `<img>`, never served as files.
Panels open instantly (no slide animations), like T3 Code's default.

## Tokens

Neutrals are zinc, monochrome-first; colour is reserved for meaning.

The console is React + Tailwind v4, bundled and served in dev (HMR) by Bun (`web/serve.ts`, `web/build.ts`, one HTML shell routed by `web/src/entry.tsx`), built from shadcn/ui (Base UI) components in `web/src/ui/` (add more with `bunx --bun shadcn@latest add <name>`);
`web/src/components/ui.tsx` is the house kit on top. Tokens use shadcn's variable names (`app.css`): foreground
fill = `primary`, raised = `card`/`popover`, danger = `destructive`, surface = `sidebar`; `muted` is a *background*,
secondary text is `text-muted-foreground`. `surface`, `raised`, `seal`, `success`, `warning` and the `*-ink` colours are hefyn's own.

| Token | Light | Dark | Use |
|---|---|---|---|
| background | `#FFFFFF` | `#09090B` | app canvas |
| surface | `#F6F7F8` | `#111113` | sidebar, panels |
| raised | `#FFFFFF` | `#18181B` | menus, dialogs, composer |
| foreground | `#14161A` | `#FAFAFA` | text, primary buttons (inverted) |
| muted-foreground | `#5B616B` | `#A1A1AA` | secondary text, icons |
| muted / accent / secondary | `#F4F4F5` | `#27272A` | subtle fills, hover |
| border | `#E3E5E8` | `#27272A` | hairlines |
| seal | `#2563EB` | `#60A5FA` | agents, running state, links — the only brand colour (token name kept from the removed privacy layer) |
| success / danger / warning | `#16A34A` / `#DC2626` / `#CA8A04` | `#4ADE80` / `#F87171` / `#FACC15` | status only (+ AA text variants) |

- **Primary action = foreground fill** (black button on light, white on dark), like shadcn. Secondary =
  border + transparent. Destructive = danger text, filled only in confirm dialogs.
- **Type**: Geist for UI (13/18 controls, 14/22 body, 16/24 transcript prose, 20/28 titles,
  semibold; large headings get slight negative tracking, -0.02 to -0.03em) and Geist Mono only for machine output (code, tool rows,
  keyboard shortcuts, the ASCII mark). Self-hosted via fontsource. Sentence case everywhere, labels included: sidebar group
  labels and settings section titles are Geist 12-13 px, medium, muted (set once in `SidebarGroupLabel` and `Section`).
  Chat: agent prose 16/26 and user text 15/24 in a 720 px column, tool rows 12.5 px mono.
- **Canvas** (the look of ascii-reveal): `.hf-dots` is a faint halftone dot grid behind the new-chat home, masked to
  fade out around the content. The one bold device is `.hf-corners`: "+" marks at the four corners of the composer
  (new-chat home and the docked composer). Nothing else is framed. (`.hf-frame` remains for the auth pages.)
- **Geometry**: compact. Controls 32 px high, radius 8; panels/dialogs radius 12; chips radius 6
  (bars, not pills). Hairline borders, no drop shadows except floating layers (composer, menus,
  command palette, dialogs) which use a subtle shadow + `backdrop-blur(12px)` at 80 % opacity.
- **Icons**: lucide, 16 px, stroke 1.75, muted colour by default.

## Layout

```
┌───────────────────────┬─────────────────────────────────────────────────────┐
│ ▣ hefyn        ⌕  ⇤   │ Q3 summary                                  actions │
│───────────────────────│─────────────────────────────────────────────────────│
│ ✎ New chat            │                                                     │
│ ⌕ Search              │   user message (subtle surface block)               │
│ ✦ Assistants          │                                                     │
│ ▤ Files   ▣ Skills    │   ● read /files/q3.csv                              │
│───────────────────────│   ● Agent  Draft the summary                     ▾  │
│ Today                 │   answer prose                                      │
│  Q3 summary        ●  │                                                     │
│  Pricing review       │  ┌───────────── composer ─────────────┐             │
│ Earlier               │  │ Ask…                    📎  ⏎      │             │
│  …                    │  └────────────────────────────────────┘             │
│───────────────────────│                                                     │
│ ⚙ Settings   ◯ Ada ▾  │   (the chat can switch to the agent's Terminal view)│
└───────────────────────┴─────────────────────────────────────────────────────┘
```
- **One sidebar** (260 px, collapsible with the button or ⌘B): brand and command palette button, the main nav entries
  from the modules (New chat, Search, Assistants, Skills, Files; each only if the user holds the permission), chats
  grouped by day with a running indicator and folders, settings and account at the bottom. No separate icon rail.
- **Top bar** (48 px): page or chat title, plus the actions the page passes in (`Shell` `actions`).
- **Composer**: attach (button or drop), @-mentions, send / stop.
- **Chat**: every chat is a hosted CLI agent (`docs/WRAPPER.md`). The Chat view is a transcript; the Terminal view is the agent's own
  terminal (xterm, `CliTerminal.tsx`). The sub-agents that are running are listed in a panel above the composer.
- **Transcript**: left-aligned in a column of about 54 rem. User messages: subtle surface block (not chat bubbles). Tool calls: compact
  one-line rows with a status icon, expandable. Steps read as plain-language sentences ("wants to run a command"); the raw
  input and output sit under "Technical details".
- **Side panel**: `Shell` has an optional 360 px panel slot (an overlay below 1100 px), but no page fills it today.
- **Command palette** (⌘K): new chat, toggle the terminal, connect a provider, the modules' go-to entries (settings pages, Files,
  Skills, Assistants), theme (system, light, dark) and switch chat. Shortcuts in `Shell`: ⌘K palette, ⌘N new chat, ⌘B sidebar
  (Ctrl on other platforms).
- **Settings**: the sidebar swaps to the section list (Back to chats on top) in two groups: **You** (Profile, Appearance, Security, your providers, MCP, devices, your usage: everyone's own things) and **Workspace** (Agents & keys, Users, Roles, Branding, everyone's usage: shown only to people holding an admin permission; `group` on a module's settings nav item, `settingsGroups`). Pages are a centred column with rows (label + one-line help | control), shadcn-style.
- **Right-click menu**: one app-wide menu (`components/AppMenu.tsx`, mounted in Shell). An area declares its entries with
  `<MenuArea items={() => <><DropdownMenuItem>…</DropdownMenuItem></>}>…</MenuArea>` (the same list can feed a ⋯ menu); the innermost area under the pointer provides the
  main items and the generic entries are added around them: selection (Copy, Search), link, image, `pre`/`code` (Copy code, only if the area gave no items), and the page
  (Back, Forward, Reload, New chat, Palette, Copy page link) at the bottom. The browser's own menu stays on inputs, textareas, contenteditable, code editors, dialogs and
  Shift+right-click. Touch: no JS long-press (it would fight scrolling and drag and drop); Android's native long-press fires `contextmenu`, iOS Safari has none.
- Responsive: below 768 px the sidebar becomes a sheet (`web/src/hooks/use-mobile.ts`); the composer stays docked.

## Principles
1. Monochrome first. Colour means something: blue = agent, red = blocked/destructive.
2. Keyboard first: every main action has a shortcut and is in the palette; focus is always visible
   (2 px foreground ring with offset).
3. Dense but breathable: 32 px controls, 8 px grid, generous transcript measure.
4. Almost no motion: panels are instant. The exception is loading: skeletons and arriving content use `ascii-reveal`
   (`Loading`/`Reveal` in the kit, dither, top-left). `prefers-reduced-motion` respected (the package turns it into a fade).
5. Copy: plain verbs, sentence case, errors say what to do next.

## Themes

Every user styles hefyn for themselves under Settings → Appearance; it is stored per user (`user_prefs`, `theme.get` / `theme.save`)
and follows them across devices. A copy in localStorage is applied by an inline script before first paint.

- **Can change:** mode (light / dark / system), accent (presets or any hex; drives primary fill, focus ring, active sidebar
  item, links; the text on it is black or white by contrast), base neutrals (zinc, neutral, slate, stone), corner radius,
  density (compact scales `--spacing`) and text size (root font size).
- **Stays fixed:** the seal colour (so agent and running markers stay recognisable; the page warns when an accent is close to it), the semantic
  colours (success, warning, danger and their inks), and the fonts.
- The default accent keeps the monochrome primary described above. The page warns below 3:1 contrast against the light
  background but still lets the user save.
