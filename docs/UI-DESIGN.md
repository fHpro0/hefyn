# hefyn — UI design direction (v2)

Subject: a team workspace where AI agents work on company data, and nothing personal reaches the model
unsealed. Audience: people who don't live in a terminal. Primary job: give an agent a task, watch it work,
and *see* what left the building.

## The one bold thing: seals

Every value the privacy layer replaced is a **seal**. In the transcript the user sees their real text, but
sealed spans carry a fine violet underline with a tiny seal glyph; hover/focus shows "Sent to the model as
EMAIL_1". In payloads (the ledger) the placeholder is a solid violet seal token in mono. When a message is
sent, its sealed spans get stamped once (single 300 ms press animation) as soon as the audit arrives — the
only ambient motion in the product. Everything else stays quiet.

## Tokens

Colour (light / dark)
| Name | Light | Dark | Use |
|---|---|---|---|
| paper | `#F5F6FA` | `#0D1120` | app background (cool, never cream) |
| sheet | `#FFFFFF` | `#151A2C` | raised surfaces: panes, composer, dialogs |
| ink | `#151B30` | `#E6E9F5` | text (navy ink, not neutral black) |
| ink-soft | `#5B6380` | `#9AA2BF` | secondary text, icons |
| line | `#E2E5EF` | `#262C44` | hairlines between regions only |
| hefyn blue | `#2563EB` | `#5B8DEF` | primary actions, focus ring, selection (from the logo) |
| seal | `#6A4DF4` | `#9C88FF` | seals, agents, privacy ledger |
| ok / alarm / caution | `#0E9F6E` / `#E5484D` / `#C98A04` | `#3DD68C` / `#FF6369` / `#F5B83D` | status only |

Type
- **Schibsted Grotesk** (variable, self-hosted via fontsource) for everything: UI 14/20, body 15/24,
  titles 22/28 semibold with tight tracking (-0.01em), page titles 28/34. Sentence case everywhere.
- **JetBrains Mono** only where text *is* machine text: code, tool output, payloads, seal tokens. Never for
  labels, counts or dates.
- No ALL CAPS labels, no eyebrows above headings, no middle-dot meta strings, no arrows appended to buttons.

Shape & depth
- Radius by hierarchy: panes 16, controls 10, chips/seals full. No left accent bars.
- Depth from surface colour (paper vs sheet) and one soft shadow for floating layers only (composer, dialogs,
  popovers). Regions are separated by space or a single hairline, not by boxing everything.

## Layout

```
┌──┬──────────────┬───────────────────────────────────────┬─────────────┐
│◉ │ Conversations│  Title                      model ▾  ⛨ 3 │ Ledger      │
│💬│  + New       │                                        │ (drawer,    │
│📁│  today       │   user block (right, sheet bg)         │  toggled by │
│⬡ │   ▸ Q3 rep…  │                                        │  ⛨ button)  │
│⚙ │  earlier     │   │ read  /files/q3.csv          12ms  │ request 4   │
│  │   ▸ …        │   ├─● writer  “draft the summary”      │  seals      │
│  │              │   │   └ write /files/summary.md        │  payload    │
│👤│              │   answer prose, 68ch measure            │             │
│  │              │  ┌──────────────────────────────────┐  │             │
│  │              │  │ composer (floating sheet)  📎  ⏎ │  │             │
└──┴──────────────┴──┴──────────────────────────────────┴──┴─────────────┘
 rail  context pane            transcript (left-aligned)         ledger
```
- **Rail** (64 px): logo mark, Chat, Files, Hub, Settings; user avatar at the bottom. Icons + tooltips.
- **Context pane** (260 px, collapsible): conversation list grouped by day for Chat; section nav for
  Settings; folder tree for Files; filters for Hub.
- **Transcript**: left-aligned, max 68ch. Assistant text is prose, not a bubble. User messages are compact
  sheet blocks aligned right. Tool calls and delegations form an **activity timeline** in the gutter (a real
  sequence, so the line + nodes carry information): one line per step, expandable; delegated agents branch
  into an indented violet lane. Shell output opens in a dark terminal sheet inside the step.
- **Ledger** (right drawer, 360 px, toggled by the shield button that shows the seal count): one entry per
  model request — model, status, seals as tokens, bytes, expandable exact payload; blocked requests in alarm.
- **Settings**: two-column rows — left: name + one-sentence explanation; right: the control. No card stacks.
- **Usage**: one chart (cost per day, 30 slots) and plain tabular rows; numbers in tabular figures of
  Schibsted, not mono.
- **Hub**: dense list rows (icon by kind, name, description, source, install button); detail in a side sheet.
- Responsive: below 1100 px the ledger becomes an overlay; below 900 px the context pane collapses behind the
  rail; below 640 px the rail becomes a bottom bar.

## Principles
1. The privacy layer is visible, never alarming: violet means "sealed", red only means "blocked".
2. Structure only where it informs: the timeline is a sequence; nothing else gets numbers or boxes.
3. Calm by default, one moment of motion (the stamp). Respect `prefers-reduced-motion`.
4. Write like the product talks to a colleague: plain verbs, sentence case, errors say what to do next.

## Review against generic defaults
- Plan v1 had "slate dark sidebar + cards with blue left bars" (current UI) → replaced by rail + panes,
  hierarchy by surface, no accent bars.
- Considered Inter/Geist → rejected as the default everyone ships; Schibsted Grotesk has a sturdy,
  newspaper-grade voice that fits "seals and ledgers" without looking like a template.
- Considered near-black + one neon accent for dark mode → rejected; dark mode is deep navy ink with the same
  violet seal, so both themes read as the same brand.
- Mono for labels/counts (current UI) → restricted to machine text only.
