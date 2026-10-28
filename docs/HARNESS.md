# hefyn: the harness

Product scope and direction. How the code works today is in [DESIGN.md](DESIGN.md). Related: [WRAPPER.md](WRAPPER.md) (Claude Code in a PTY),
[SANDBOX.md](SANDBOX.md) (runner and sandboxes), [ENCRYPTION.md](ENCRYPTION.md) (keys, who sees what), [MODULES.md](MODULES.md) (writing modules).

Status: proof of concept, not used in production. "Built" below means in the code today; "Planned" means not started or only designed.

## Prototype scope (2026-10-27)

Owner decision: hefyn runs **no agent of its own**. It is pure agentic coding with standard CLIs (Claude Code, Codex, OpenCode, Pi).
Every chat is a hosted CLI agent (`src/cli-agents`, [WRAPPER.md](WRAPPER.md)). A new chat is Claude Code (`claude-acp`) unless an Assistant or the picker says otherwise.

Built and kept:

- The CLI-agent host (chat view and terminal view), sub-agents, users and roles, MCP servers, skills (stored in the Hub tables), agent accounts, agents and keys (providers, gateways, install), Assistants as simple presets (name, agent, instructions, skills), appearance, usage, Devices (pairing only), the Cordis kernel and the module registry.
- Sealing (vault, keys, seal) stays. The default key mode is `server`, so nothing needs an unlock.

Moved to `old/` (same relative paths; not typechecked, not tested, not built, not in the images, no `@flue/*` dependency):

- The hefyn chat on Flue (`src/agents`, the Flue router, flue-vault, model-access, the container/storage Flue sandboxes, chat links, the console's classic chat) and the Assistant flow engine, canvas and "runs on hefyn". Chats made earlier on it open as "retired hefyn chat"; their rows stay in the database.
- Data collections and dashboards, schedules, projects, trace.
- Hub UI (browse, review, import), Files page connections, Mail settings page, Modules page, Security's encryption and unlock UI.
- `docs/DATA.md`, `docs/SCHEDULES.md` and `docs/ASSISTANTS.md` (now in `old/docs/`).

Why: with no hefyn-native agent these features had nothing to run on. Tables and columns stay as they are (no destructive migrations).

## Direction

hefyn's harness is modelled on [t3code](https://github.com/pingdotgg/t3code) (MIT): durable threads in projects, a provider adapter per agent,
an event-sourced orchestrator, per-turn checkpoints, one thread view. It follows the "everything is a plugin" idea of
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT), with [Cordis](https://github.com/cordiverse/cordis) (MIT) as the plugin kernel.
Owner decision, 2026-10-27. Everything below that is marked Planned is this target.

Stack (built): Bun for runtime, package manager, tests, bundler and dev server for the console, and container images (pinned in `package.json`).
No Node, Astro or Vite. The sandbox image and the Playwright MCP image are external images.

## Principles

1. **Private by default, shared on purpose.** Chats, skills and MCP servers start private. Sharing is an explicit action and, where an admin wants it, goes through review (Hub items: `hub.approve`).
2. **Each user sees only their own data. Admins never read users' chats.** Admins manage users, roles, providers and policies, and see metadata (counts, usage, cost). There is no admin read path for chats in the API; `test/encryption.test.ts` checks titles.
3. **Non-technical users never meet models.** Model ids and providers are visible only to people with `models.manage`; the API strips them for others. Planned: a test for this across every API response.
4. **Model requests go through hefyn's gateways** (provider check, key injection, usage), for API-key sessions. Sessions on a user's own Claude account bypass the gateway by design ([WRAPPER.md](WRAPPER.md)).
5. **Code only from the build, user code only in the sandbox.** Built-in modules are TypeScript reviewed with the app. Installed modules ship no server code (manifest, declarative screens, MCP). User-written code runs only in the runner sandbox ([SANDBOX.md](SANDBOX.md)).
6. **Admins can turn things off.** Each capability is a permission; Admin gets all, Worker gets a default set.

## Kernel (built)

One Cordis `Context` per process, created in `src/kernel/index.ts` and filled by `src/modules/registry.ts`. Cordis is vendored (`vendor/cordis`, version 4.0.5).

- Each built-in module (`defineModule`, `src/modules/types.ts`) is loaded as a plugin by `modulePlugin`: migrate, register contributions, run jobs. Disposing it takes back everything it registered. An optional module is switched off by not loading it (`HEFYN_MODULES_DISABLED` or the instance setting `modules_disabled`).
- Two kernel services exist: `modules` (the loaded list, permissions, jobs) and `storage` (Files connection kinds).
- **Boot check** (`bootCheck`): a plugin whose `inject` is never satisfied stays silently pending in Cordis. After boot, any plugin not active is an error naming the missing service.
- Tests: `test/kernel.test.ts`, `test/module-contract.test.ts`, `test/modules.test.ts`.

Planned: the core services (db, auth, keys, model access, orchestrator, routes) as plugins, typed events with the five Cordis modes
(`emit`, `bail`, `parallel`, `serial`, `waterfall`) in place of today's hard-coded hooks, and removing the compatibility layer around `defineModule`.

## Module tiers

hefyn is a multi-user server, so a plugin must never be able to read another user's data. deepseek-harness runs third-party plugins in-process; hefyn never does.

| Tier | Server logic | UI | Status |
|---|---|---|---|
| Built-in | TypeScript in the server process, reviewed with the app (17 modules in `src/modules`) | React in the console | Built |
| Installed, declarative | none; MCP servers for tools | JSON screens rendered by the console | Built (`src/modules/installed.ts`, [MODULES.md](MODULES.md)) |
| Installed, with code | runs in a runner container or as an MCP server, never in-process | sandboxed iframe over `postMessage`, capability-checked plugin API | Planned |

Agent modules are JSON manifests (how to install and launch an agent, env and config as templates with a fixed set of placeholders) that hefyn fills in and never executes.
The four shipped agents are such manifests (`src/modules/agents/`). Others come from the ACP Registry or an admin-pasted manifest. Schema: [MODULES.md](MODULES.md#agent-modules).

Planned: capabilities declared in a manifest and granted by an admin on install; Creator mode (an agent drafts a plugin, active only after review).

## Agent adapters (Planned)

Today one `CliSession` in `src/cli-agents/host.ts` (about 830 lines, in-memory state) runs both paths: Claude Code in a PTY via hooks and transcript
(`src/cli-agents/claude-wrapper.ts`) and ACP stdio agents. The plan is one `AgentAdapter` per kind (after t3code's provider adapters) so complexity sits at that boundary.

| Method | Does |
|---|---|
| `capabilities()` | honest flags: steer, rollback, fork, native permission modes, plan mode, questions |
| `openSession(thread)` | session with an event stream (ACP-shaped updates, which the console already renders) |
| `startTurn`, `steerTurn`, `interruptTurn` | drive one turn |
| `respond(requestId, decision)` | answer an approval or question |
| `readSnapshot`, `close` | rebuild thread view; end the session |

Adapters: ACP (codex, opencode, pi and manifest agents) and the Claude wrapper. Not the Agent SDK, which may not offer claude.ai login ([WRAPPER.md](WRAPPER.md)).
Where an adapter lacks a capability, orchestration falls back (no fork: hand the context to a new thread).

## Orchestrator (Planned)

Event-sourced, like t3code. Every action is a command: a pure `decide(state, command)` returns events; events, projections and an outbox row commit in one SQLite transaction;
an effect worker runs the outbox and feeds results back as commands. Thread state is rebuilt from the log. Event rows stay sealed per user.
Today `cli_events` is a plain append (`src/server/appdb.ts`).

## Projects, threads, turns (Planned)

A project is a git directory in the user's sandbox, a thread is a durable conversation in it, a turn is one user-to-agent cycle.
After each turn the working tree is stored as a hidden ref (`refs/hefyn/checkpoints/<thread>/<turn>`) without touching the user's branch, for a per-turn diff and "restore to this turn".
Today all of a user's chats share `/files`, there are no checkpoints, and git is in the sandbox image but unused.

## Surface

Built: one chat view per conversation with a terminal view on the same agent process; tool-call cards; permission questions answered in the chat; Stop.
Planned: a terminal drawer on the thread, permission modes (Supervised, Auto-accept edits, Auto, Full access) offered only where the agent enforces them natively
(hefyn never fakes a mode by answering approvals itself; new threads default to Supervised), plan mode with a plan card, and a "Details" toggle for tool calls, diffs and terminal.

## Skills and MCP servers (built)

Anyone with `hub.install` adds skills (SkillsMP search, GitHub/GitLab link, or write one) and MCP servers privately. `hub.publish` shares them with the team through review (`hub.approve`).
An MCP server's credentials stay with whoever connected it unless an admin sets a team connection. Admins can turn adding and sharing off per role. Hub API: [HUB-API.md](HUB-API.md).

## Outbound channels

Model requests are forwarded as they are (the redaction gate was removed 2026-10-26). Known channels: Playwright browsing (open internet), sandbox egress (off by default),
and the own-account proxy to three Anthropic hosts. Who sees what: [ENCRYPTION.md](ENCRYPTION.md#who-sees-what).

## Stages

Each stage keeps the tests green and is a stopping point.

1. **Kernel.** Built: Cordis in, `defineModule` modules load through `modulePlugin`, the boot check.
2. **Adapter boundary.** Planned. Split `CliSession` into the ACP adapter, the Claude-wrapper adapter and a thin session host.
3. **Orchestrator and event store.** Planned.
4. **Projects as directories**, checkpoints and the diff panel. Planned.
5. **The thread surface**: drawer, modes, plan, questions, Details. Planned.
6. **Native plugins.** Planned. The 17 built-in modules become native Cordis plugins and the compatibility layer goes. Product rules to add: an admin-no-content test across all plugins, and model fields stripped for non-managers in every API response.
7. **Installed tiers and Creator mode.** Planned.

Devices stage 2 (an outbound daemon so agents run on the user's laptop, server-brokered) is separate from these stages: [DEVICES.md](DEVICES.md).

## Writing a module today

`defineModule({...})` in `src/modules/<id>/index.ts`, registered in `src/modules/builtin.ts`. Types: `src/modules/types.ts`.
The core calls modules through `active()` (`src/modules/active.ts`) and never imports one (`test/module-contract.test.ts` checks).
Steps, fields and console slots: [MODULES.md](MODULES.md#writing-a-module).
