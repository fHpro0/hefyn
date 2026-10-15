# hefyn — Design

Status: **v1 built and verified 2026-10-15** (phases 1–4; 60/60 tests, Docker prod stack checked). Phase 5 items remain.

## Goal

**hefyn** is a **visual** agent for teams that don't live in the terminal: pi / oh-my-pi power
(orchestrator + roles, skills, MCP, many models) behind one login, with a hub to
install and share skills, roles and connectors in one click. GDPR (DSGVO) compliant.

It is the web/team successor of the native hefyn terminal (github.com/fHpro0/warden) and keeps
its promise: **agents work with your data without seeing your secrets.**

## Brand (from the native hefyn)

- Logo: `assets/brand/` (mark, wordmark, white variants, app icon).
- Themes: `assets/themes/hefyn-light.json`, `hefyn-dark.json` → CSS variables
  (primary `#2563eb`, dark background `#0b1220`, sidebar `#0f172a`).
- Status colours: running `#2563eb`, success `#15803d`/`#4ade80`, failure `#b91c1c`/`#f87171`,
  agent `#7c3aed`/`#a78bfa` (agent badges and redaction pills).
- Code/monospace: JetBrains Mono.
- Layout language: session tree on the left with coloured groups, tabs, cards for edits and
  tool calls, "Sent to <model>" panel showing exactly what left the server and what was redacted.

## Decided

| Topic | Decision |
|---|---|
| Framework | Flue (`@flue/runtime` 2.x, built on Pi / `@earendil-works/pi-ai`) |
| Client | Web app only: **Astro (static build) + React islands**, served by the Hono app (one container) |
| Audience | One company, several teams |
| Access | **Custom user roles**: built-in `Admin` (all permissions, not deletable) and `Worker` (default for new users); admins create roles and tick permissions. Own `roles` table; Better Auth only does identity + sessions |
| Login | Better Auth inside the Hono app (also OIDC provider for own MCP servers) |
| Hosting | Self-hosted Docker. Bun for install/build/scripts; server runs on **Node** (Flue's Node runtime imports `node:sqlite`, Bun 1.3.14 lacks it) |
| Agents | One generic `Configurable` Flue agent, built at runtime from DB profiles |
| Models | **Every pi-ai provider**: API keys (OpenRouter, Zen, Anthropic, OpenAI, …), subscription logins (ChatGPT/Codex, Claude, Copilot, …) and custom OpenAI-compatible endpoints. Each user connects their own; admins can add company-wide ones |
| Privacy | **All model traffic goes through the privacy gateway** — that is the GDPR mitigation, not a provider allowlist |
| Redaction engine | Reuse `warden-redact` (formerly `hefyn-redact`; Rust crate from the native app, pinned rev fe15b9f: regex + entropy + local GLiNER via `gline-rs`, fail-closed, `{{var:NAME}}` / `{{secret:NAME}}` placeholders, prompt-injection `Guard`) as a small HTTP sidecar — no new Python GLiNER service |
| Processes | Two services: **`web`** (auth, API, UI, hub — always up, proxies `/agents/*`) and **`agent`** (Flue runtime only, internal network). Agent restarts via a **restart queue**: `running → draining` (new tasks blocked, running ones finish) `→ restarting → running`; triggered by admin, provider removal or code changes |
| Storage | **Per-user storage**: `files/` (persistent: uploads, results) + `tmp/<conversation>/` (scratch, auto-cleaned). Agents use it via a scoped Flue sandbox (file tools, no shell until the container sandbox); Files page + chat attachments; quota per user; deleted with the user |
| Plugins | Skills + roles + MCP servers + custom model providers. **No user-uploaded server code** |

## Verified (spike, 2026-10-15)

- `useSubagent({ name, description, model, agent: closure })` and
  `useSkill(defineSkill(row))` accept data built at runtime; per-role model,
  instructions and skills reach the model (checked against a fake provider).
- `useMcpConnection` takes plain data; `optional: true` survives a dead server.
- Hono middleware in front of `createAgentRouter` works (401 / 202).
- Flue MCP is remote-only: `transport: 'streamable-http' | 'sse'`. No stdio.
- `SkillDefinition.files` carries supporting files, so hub skills can live in the DB.
- pi-ai ships 50+ providers (anthropic, openai, openrouter, opencode/Zen, bedrock,
  vertex, …), OAuth flows and a `CredentialStore`; Flue exposes **no per-user model
  credentials** (only MCP `auth` resolvers).

## Architecture

```
Browser (React SPA)
  │  Better Auth session
  ▼
Hono app (Node, Docker) ──────────────────────────────────────────────┐
  ├─ /api/auth/*        Better Auth (email, company SSO, OIDC provider)│
  ├─ /api/hub/*         catalog, install, share, review                │
  ├─ /api/profiles/*    orchestrator + roles editor                    │
  ├─ /agents/configurable/:convId   Flue router (owner check first)   │
  │      └─ Configurable agent: loads profile → useModel / useSubagent │
  │         / useSkill / useMcpConnection                              │
  ├─ model gateway (phase 4): GLiNER redaction + per-user credentials  │
  └─ MCP runner: starts/stops managed MCP containers via Docker API ───┘
        │
        ├─ SQLite (app DB + Flue store; conversation ids = u_<userId>_<chat>)
        ├─ hefyn-redact sidecar (Rust, CPU, GLiNER ONNX) [phase 2]
        ├─ managed MCP containers, e.g. Playwright + Chrome   [phase 3]
        └─ code sandbox (self-hosted, e.g. Daytona)      [phase 3, open]
```

## Hub

One catalog, four package kinds. Formats follow existing standards so popular
skills install unchanged.

| Kind | Format | Installs as |
|---|---|---|
| `skill` | Agent Skills `SKILL.md` + files | `useSkill(defineSkill({..., files}))` |
| `role` | Claude Code `agents/*.md` (frontmatter: name, description, model) | a subagent in a profile |
| `mcp` | remote URL **or** managed container image + port | `useMcpConnection({ url, auth })` |
| `bundle` | Claude Code plugin (`.claude-plugin/plugin.json` + `skills/`, `agents/`, `.mcp.json`) | all of the above |

Not imported in v1: plugin `hooks/` and `commands/` (ponytail's SessionStart hook,
for example — its skill still works). Commands may later become prompt templates.

**Sources:** created in the UI, import from a git URL, Claude Code plugin
marketplaces (`marketplace.json`), the official MCP Registry.

**Install flow (no terminal):** browse → "Add to my profile" or "Add to team
profile". A managed MCP asks only for its settings (form generated from its
schema); the runner starts the container.

**Trust:** skills are prompt-injection surface, MCP servers run code. Imports land
as `pending`, are pre-checked by `hefyn-redact`'s `Guard`, and an admin approves before `team` visibility. Pin by version + content
hash; updates need re-approval. Each package shows what it can reach.

**Managed MCP example — Playwright:** container
`mcr.microsoft.com/playwright/mcp` started with an HTTP port, one per user
session, killed on idle. Tool results carry screenshots, which the UI shows
inline; a live browser view comes later.

## Data model (sketch)

```
users(+ role_id), teams, team_members                 -- Better Auth tables + teams
roles(id, name, builtin, permissions_json)             -- Admin, Worker, custom
  permissions (code-defined keys): models.manage, models.use, users.manage, roles.manage,
  usage.view_all, profiles.edit_team, hub.install, hub.publish, hub.approve, mcp.run_managed
  later scopes per role: allowed models, monthly budget
packages(id, kind, name, version, source, hash, manifest_json, files_blob,
         owner_id, visibility: private|team|public, status: pending|approved)
profiles(id, owner_id, visibility, orchestrator_json)  -- model, instructions, skills, mcp
profile_agents(profile_id, name, description, model, instructions, skill_ids, mcp_ids)
profile_packages(profile_id, package_id, config_json)
mcp_instances(id, user_id, package_id, container_id, url, last_used_at)
user_credentials(user_id, provider, enc_secret)        -- phase 4, encrypted
conversations(id = u_<userId>_<chat>, user_id, profile_id, title)
```

Sharing = `visibility` + "fork" (copy row, new owner).

## Visual agent UI

- Chat with streaming, tool calls as cards, screenshots and files inline.
- Subagent tree: which role is working, live (like oh-my-pi's Agent Hub).
- Profile editor: orchestrator + roles as cards; pick model, skills, MCP per role.
- Hub store page; admin review queue.
- Approval prompts for risky tools (human in the loop).

## Phases

1. **Foundation** — Node Docker image, Better Auth, SQLite, profiles from DB, chat UI.
   **No built-in model:** first sign-in creates the admin and opens a setup wizard
   (connect a provider with an API key, pick orchestrator/role models, invite users).
   **Usage stats** from day one: tokens + cost per response (`useResponseFinish`), admin
   dashboard per user / model / day, each user sees their own.
   **Roles:** Admin + Worker seeded, role editor (permission checkboxes), `requirePermission()` on every API route.
2. **Model gateway** — "Connect a model" page (API key, subscription login, custom
   endpoint), per-user encrypted credentials, usage per user. Every request goes
   through the `hefyn-redact` sidecar, same rules as native hefyn:
   - outgoing text is redacted; **if any detector fails, nothing is sent**;
   - values become `{{var:EMAIL_1}}`-style placeholders kept per conversation;
   - placeholders in the model's tool-call arguments are swapped back to real values
     before the tool runs, and tool output is redacted again on the way back;
   - every call is audited in redacted form; the UI shows "Sent to <model>".
   Model picker shows everything the user connected.
   **Web login (OAuth) for every connector, like omp / opencode:** model providers via pi-ai's
   OAuth flows (Claude, ChatGPT/Codex, Copilot, OpenRouter, xAI, …) adapted to the browser
   (redirect back to hefyn, paste-code or device-code where the provider fixes its redirect URI),
   tokens refreshed through a DB-backed `CredentialStore`; MCP servers via the MCP OAuth spec
   (discovery, dynamic client registration, PKCE), per-user tokens fed to `useMcpConnection({ auth })`.
3. **Hub v1** — skills, roles, remote MCP; import from git / Claude plugins;
   visibility, fork, admin review.
4. **Managed MCP + sandbox** — MCP runner (Playwright + Chrome), self-hosted code
   sandbox.
5. **Later** — per-user DB files (hybrid Flue adapter), deterministic workflows
   (Inngest), live browser view.

## GDPR checklist (not legal advice — owner: data protection officer)

- GLiNER gateway on all model traffic; mapping stays in the user's data, never sent out.
- Optional per provider: EU route + AVV where available (Bedrock EU / Vertex EU).
- Records of processing, TOMs, deletion/export per user (id prefix), retention.
- DPIA likely; works council if one exists (§87 BetrVG).

## Open decisions

1. History storage: central SQLite (recommended) vs per-user files now.
2. Code sandbox: self-hosted Daytona vs plain Docker containers via the MCP runner.

## Risks

- Flue is young (2.x); per-user storage would rely on `@flue/runtime/internal`.
- Container per user session for MCP needs limits (CPU, memory, idle kill).
- Hub content from public sources is untrusted — review step is mandatory.
- GLiNER misses entities; redaction is best effort, pseudonymized data is still personal data.
- `hefyn-redact` was built for terminal output; chat prose and streamed model replies may need
  tuning (thresholds, labels for German text). Native hefyn is still changing — pin a commit
  when the sidecar depends on it.
- Subscription logins: pi-ai's OAuth flows are built for a local CLI (callback /
  device code); a web flow needs adapting. Providers may block or rate-limit
  subscription tokens used outside their own apps (Anthropic has done so).
- Gateway per-user routing relies on registering providers at runtime via `setProvider` — untested.
- Storage path checks are realpath-before-use (TOCTOU with symlinks). Safe while agents have no shell;
  must be closed (open with O_NOFOLLOW / openat-style checks, or confine via the container mount) before
  the container sandbox gives agents a shell on the same directory.


## Privacy enforcement (v1)

Layers, outermost first: (network) the agent container has no route out except the egress proxy with a derived allowlist; (fetch guard) model-API hosts are only reachable under the
gate's stamp; (gate) the pi-ai `Models` class itself redacts every chat request with GLiNER via the hefyn-redact sidecar, fail closed; (policy) GLiNER is mandatory in production,
images are stripped by default, every request is audited. See README "Privacy guarantees". Risks: GLiNER misses entities; node:http(s)-based SDKs bypass the in-process guard but not the network layer;
the allowlist is host-based (an allowlisted host that is also a general-purpose proxy would defeat it); the sandbox shell and Playwright have their own internet egress by design.
