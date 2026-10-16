# hefyn — Design

Status: **v1 built and verified 2026-10-15** (phases 1–4; 60/60 tests, Docker prod stack checked). Phase 5 items remain.

## Goal

**hefyn** is a **visual** agent for teams that don't live in the terminal: pi / oh-my-pi power
(orchestrator + roles, skills, MCP, many models) behind one login, with a hub to
install and share skills, roles and connectors in one click. GDPR (DSGVO) compliant.

It shares its promise with the native terminal [warden](https://github.com/fHpro0/warden) — **agents work
with your data without seeing your secrets** — and uses a TypeScript port of warden's redaction engine, but
has its own identity.

## Brand

hefyn's own identity (no colours or assets from warden): monochrome zinc neutrals, one brand colour
(seal violet), IBM Plex Sans/Mono, and a redaction-bar mark in `assets/brand/`. Full tokens, layout and
principles: [UI-DESIGN.md](UI-DESIGN.md).

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
| Redaction engine | **TypeScript port of warden's redaction engine** (`src/server/redact/`; ported from the Rust crate `warden-redact` at rev fe15b9f and verified against it, see `test/redact-parity.test.ts`): regex rules, entropy, local GLiNER (`gliner-pii-small`, quantized ONNX via `onnxruntime-node`, inference in a `worker_thread`), span merging, fail-closed, `{{var:NAME}}` placeholders, prompt-injection heuristics. Runs as its own **`redact` service** (`src/redact-server.ts`, same image, internal network, internal token, CPU/memory limits) — no Python, no Rust. Agent and web call it over HTTP (`POST /redact`, `POST /guard`, `GET /health`) and fail closed on any error, timeout or non-2xx. It has no internet: `web` downloads the model files into a `redact-models` volume (mounted read-only into `redact`), SHA-256 verified, which keeps the one component that sees plain text offline and needs no egress rule for Hugging Face. The model stays loaded across agent restarts; the agent no longer waits for it (the gate checks readiness per request) |
| Processes | Two services: **`web`** (auth, API, UI, hub — always up, proxies `/agents/*`) and **`agent`** (Flue runtime only, internal network). Agent restarts via a **restart queue**: `running → draining` (new tasks blocked, running ones finish) `→ restarting → running`; triggered by admin, provider removal or code changes |
| Storage | **Only on the Docker stack** (the `hefyn-data` volume) — no cloud storage (no AWS/S3) built in. External storage only through add-ons: WebDAV (Nextcloud, ownCloud, NAS) and MCP filesystem servers (incl. hub installs) mount as `/files/<name>` for the Files page and the agent's file tools (not the shell; no local quota; see `docs/STORAGE.md`). **Per-user storage**: `files/` (persistent: uploads, results) + `tmp/<conversation>/` (scratch, auto-cleaned). Agents use it via a scoped Flue sandbox (file tools, no shell until the container sandbox); Files page + chat attachments; quota per user; deleted with the user |
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
  ├─ model gateway (phase 4): GLiNER redaction (redact service) + per-user credentials │
  └─ MCP runner: starts/stops managed MCP containers via Docker API ───┘
        │
        ├─ SQLite (app DB + Flue store; conversation ids = u_<userId>_<chat>)
        ├─ redact service (TypeScript; GLiNER ONNX in a worker thread, CPU) [phase 2]
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
as `pending`, are pre-checked by the redaction engine's `guard`, and an admin approves before `team` visibility. Pin by version + content
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
   through the redact service, same rules as native hefyn:
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
- The engine was built for terminal output; chat prose and streamed model replies may need
  tuning (thresholds, labels for German text). It is a port of warden at a pinned rev; changes in warden
  are not picked up automatically.
- The quantized GLiNER model is sensitive to the ONNX Runtime version (scores shift by ~1 %, borderline entities flip):
  `onnxruntime-node` is pinned to 1.20.1, the version the Rust original ran on. Re-run `test/redact-parity.test.ts` before bumping it.
- Regexes run on the JS engine (backtracking) instead of Rust's linear-time one. Defence in depth: (1) regex, entropy and the guard run in a
  worker-thread pool (`HEFYN_REDACT_WORKERS`, default 2), never on the main thread; a job that exceeds `HEFYN_REDACT_TIMEOUT_MS` (default 10 s)
  fails closed ("redaction timed out", the request is blocked), its worker is killed and replaced and other requests continue; (2) the rules
  that were quadratic on long runs are bounded or guarded by a required literal (email local part <= 64, labels <= 63, URL scheme <= 31,
  key name after a keyword <= 256, JWT segments <= 8192, hash <= 1024), so 1 MB worst-case inputs take ~0.2 s. Cost: values beyond those
  bounds (an email local part over 64 characters, a 300-character variable name before `=`) are no longer matched as Rust would. A new rule
  with nested quantifiers could still be slow, which the timeout then contains. The GLiNER worker has its own timeout (`HEFYN_REDACT_GLINER_TIMEOUT_MS`, 60 s).
- Subscription logins: pi-ai's OAuth flows are built for a local CLI (callback /
  device code); a web flow needs adapting. Providers may block or rate-limit
  subscription tokens used outside their own apps (Anthropic has done so).
- Gateway per-user routing relies on registering providers at runtime via `setProvider` — untested.
- Storage path checks are realpath-before-use (TOCTOU with symlinks). Safe while agents have no shell;
  must be closed (open with O_NOFOLLOW / openat-style checks, or confine via the container mount) before
  the container sandbox gives agents a shell on the same directory.


## Privacy enforcement (v1)

Layers, outermost first: (network) the agent container has no route out except the egress proxy with a derived allowlist; (fetch guard) model-API hosts are only reachable under the
gate's stamp; (gate) the pi-ai `Models` class itself redacts every chat request through the redact service (regex, entropy, GLiNER), fail closed; (policy) GLiNER is mandatory in production,
images are stripped by default, every request is audited. See README "Privacy guarantees". Risks: GLiNER misses entities; node:http(s)-based SDKs bypass the in-process guard but not the network layer;
the allowlist is host-based (an allowlisted host that is also a general-purpose proxy would defeat it); the sandbox shell and Playwright have their own internet egress by design.
