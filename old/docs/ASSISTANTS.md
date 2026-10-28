# Assistants

An Assistant is what a person picks when they start a chat. Inside it is a **flow**: a graph of steps drawn on an
n8n-style canvas. The simplest Assistant is one step ("ask an agent, reply"); a complex one routes, asks for approval,
calls other agents and Assistants, runs code in the sandbox and writes files. People who use an Assistant never see
models or steps, only its name, what it is for, and the chat.

Owner decisions (2026-10-26): flows are a new canvas built for Assistants (the deleted workflow builder is not
revived; its engine in `~/hefyn-backups/hefyn-before-cli-agents-2026-10-26.tgz` may be read for ideas). Everyone may
create Assistants, private by default; sharing with the team goes through review; admins can switch creating and
sharing off per role.

## Ownership

| | Private | Team |
|---|---|---|
| Who creates | any user with `assistants.create` | an admin, or a user's Assistant after review |
| Who sees it | its owner only | roles listed on it (empty = everyone) |
| Who edits | its owner | `assistants.manage` (Admin by default) |

"Share with team" (`assistants.share`) submits a copy for review; an approver (`hub.approve`) accepts or declines it
in the existing Hub review queue. The default Assistant ("General") is a team Assistant. A user's private Assistant may
only use agents, models, skills and connectors that user may use; a team Assistant may grant an agent's sandbox to its
roles (see SANDBOX.md).

## Flow format (`flow` column, JSON, `version: 1`)

```json
{
  "version": 1,
  "nodes": [
    { "id": "start", "type": "trigger.chat", "position": { "x": 0, "y": 0 }, "config": {} },
    { "id": "draft", "type": "agent", "label": "Draft the reply", "position": { "x": 260, "y": 0 },
      "config": { "agent": null, "model": null, "thinking": null, "instructions": "…", "prompt": "{{start.text}}",
                  "skills": [], "history": true, "subAgents": [] } },
    { "id": "reply", "type": "output.reply", "position": { "x": 520, "y": 0 }, "config": { "text": "{{draft.text}}" } }
  ],
  "edges": [
    { "id": "e1", "from": "start", "to": "draft" },
    { "id": "e2", "from": "draft", "to": "reply" }
  ]
}
```

- Node ids are `[a-z][a-z0-9_]{0,31}`, unique; `label` is shown on the canvas and in the chat's step timeline.
- An edge leaves a node through a **port** (`"port": "true"`, a router branch id, …); omitted = the node's only port.
- v1 graphs are acyclic and have exactly one trigger. Validation rejects cycles, dangling edges, unknown types,
  unknown ports, templates that name a node that cannot have run before.

### Templates

Text fields marked *template* may contain `{{node.field}}` (e.g. `{{start.text}}`, `{{draft.text}}`,
`{{classify.json.category}}`). No code, no filters in v1. A reference to a node that was skipped renders empty.

### Node types (v1)

| Type | Config | Output | Ports |
|---|---|---|---|
| `trigger.chat` | — | `text`, `files[]` (the user's message and attachments) | out |
| `agent` | `agent` (null = hefyn, else an installed agent id), `model`, `thinking`, `instructions`, `prompt`*, `skills[]`, `history` (send the chat history), `subAgents[]` (hefyn only: `{name, description, model, instructions, skills}`), `output: "text" \| "json"`, `schema?` | `text`, `json?` | out |
| `assistant` | `assistantId`, `prompt`* | `text` | out |
| `router` | `mode: "ai" \| "rules"`, `input`* (ai: the text to route on), `branches: [{id, label, description?, rule?: {left*, op, right*}}]` (1 to 10; `rule` for `rules`), `model?` | `branch` | one per branch id, plus `else` |
| `condition` | `left`*, `op` (`equals`, `contains`, `matches`, `empty`, `not_empty`, `gt`, `lt`), `right`* | `result` | `true`, `false` |
| `approval` | `message`* (the question), `content` (what is reviewed; empty: the text of the nearest earlier step that made some), `editable` | `text` (the content, edited if allowed) | `approved`, `rejected` |
| `ask` | `question`*, `fields?: [{name, label, type: "text" \| "choice", options?}]` | `answers` | out |
| `template` | `text`* | `text` | out |
| `code` | `language: "javascript" \| "python"`, `source`, `timeoutSec` | `json` (stdout parsed), `text` | out |
| `tool` | `connectorId`, `tool`, `args` (object of templates) | `json` | out |
| `output.reply` | `text`* | — | — |
| `output.file` | `path`*, `content`* | `path` | out |

\* template

## Running

- Every user message in a chat with a flow Assistant starts a **run** of that Assistant's flow version.
- Nodes run in dependency order. A node runs once all its incoming edges are settled: a delivered edge passes data, an
  edge from a branch that was not taken (or from a skipped node) marks that path skipped. A node with only skipped
  inputs is skipped.
- `approval` and `ask` pause the run (`waiting`) until the user answers in the chat; the run then continues. Stop
  cancels it.
- `agent` with `agent: null` runs the hefyn agent (instructions, skills, sub-agents, the user's files and tools); with an
  agent id it runs that CLI agent in the user's sandbox for this conversation and its permission requests appear in the
  chat. `assistant` runs another Assistant's flow as a sub-run (no recursion: a run may not enter an Assistant it is
  already in; depth ≤ 4).
- `code` runs in the user's sandbox (no network) with the node's inputs as JSON on stdin.
- **Data**: step inputs and outputs are stored sealed with the user's key, like messages. Model calls are forwarded as they are (classic chat or the CLI gateways).

### Run events (conversation event log, shown in the chat)

`{hefyn:"run_start", runId, assistantId}`, `{hefyn:"step_start", runId, node, label, type}`,
`{hefyn:"step_output", runId, node, text?, json?}`, `{hefyn:"step_end", runId, node, status: "done" | "skipped" | "failed", error?}`,
`{hefyn:"waiting", runId, node, kind: "approval" | "ask", message, fields?, editable?, content?}`,
`{hefyn:"run_end", runId, status: "done" | "failed" | "cancelled"}`; `output.reply` text arrives as
`agent_message_chunk` updates so it renders as the assistant's answer. CLI agent nodes forward their ACP updates with
the `runId`/`node` attached.

## Simple and flow editing

The editor has two views of the same flow. **Simple**: name, description, icon, agent, model, instructions, skills,
input rules, who may use it. Valid only while the flow is `trigger.chat → agent → output.reply`, and it edits that agent
node. **Flow**: the canvas. Adding any other node turns Simple off for that Assistant (with a note).

## As built (backend, 2026-10-26)

Code: `src/assistants/` (`flow.ts` format, templates and structural checks; `validate.ts` availability checks per user; `engine.ts` the run; `runs.ts` sealed run rows; `session.ts` the chat side; `hefyn-step.ts` + `src/agents/flow-step.ts` the hefyn agent step), `src/server/assistants.ts` (data), `assistant-store.ts` (write), `assistant-share.ts` (sharing), `routers/assistants.ts` (API: docs/API.md).

- **Storage.** `profiles.flow` is the truth. While the flow is the simple shape (`isSimple`: trigger -> one agent whose prompt is `{{trigger.text}}` and output is text -> reply of `{{agent.text}}`) the columns `agent/model/thinking/instructions/skills` and `profile_agents` mirror it (`writeAssistant`; `profile.update` re-syncs the default with `syncSimpleFlow`), and chats use today's paths. Every Assistant that existed got the simple flow at first boot; General keeps its `profile_agents` as the agent node's `subAgents` (`{name, description, model, thinking, instructions, skills: [{name, description, instructions}]}`). `version` bumps on every save; a run stores the flow version it started with and a snapshot of the flow, so editing an Assistant never changes a run in flight.
- **A flow chat** is a conversation with `flow = 1` (set when the Assistant is not simple). The browser uses `/agents/cli/<id>/…` (events, prompt, cancel, permission, answer); the log is the conversation's `cli_events`, sealed like a CLI chat's. Every message starts a run (`assistant_runs`; `state` sealed with the owner's key: flow snapshot, input, every step's output, the open question). One run works or waits at a time per chat: a new message while a run works or waits is refused (409) until it ends or is stopped.
- **Run order.** Nodes run one at a time in topological order. A node runs when at least one incoming edge was delivered (the source is done and left through that port); otherwise it is skipped (it sends only `step_end` with `status: "skipped"`, no `step_start`). A step that fails ends the run: `step_end failed`, then `run_end failed` with `The step "<label>" failed: <reason>`. A run in which no Reply ran says `The flow finished without a reply.`
- **Events.** As listed above, with `runId` on all of them. The reply is an `agent_message_chunk` with `runId` and **no** `node`; a CLI-agent step forwards its own ACP updates with `runId` and `node`, which are that step's output and must not be shown as the answer. `error` events carry `message` (and `runId`). `trigger.chat`, `agent`, `assistant`, `template`, `code`, `tool` and `output.file` send `step_output` (`text`, `json`); `router` and `condition` do not.
- **Templates.** `{{node.field.path}}`; node ids as above, field names are the output keys (`text`, `json`, `files`, `branch`, `result`, `answers`, `path`), inherited properties are never readable. A malformed `{{…}}` is a validation error, except text with a `:` such as `{{x:NAME}}`, which is not a reference (`NODE_ID` cannot contain `:`).
- **agent (hefyn).** A Flue instance of the `FlowStep` agent (fresh `u_<user>_<ulid>` per execution, recorded in `assistant_steps` so deleting the chat purges it), with the step's instructions, model, thinking, skills (approved team skill ids), sub-agents and the user's tools exactly like the classic chat (sandbox, connectors, data collections, modules; not chat-to-chat). Every model request goes through the privacy gate and is counted in usage. With `history: true` the chat so far (user messages and answers, last 12 000 characters) is put before the prompt as text. `output: "json"` asks for one JSON object (and the `schema`), repairs once, checks the schema's top-level `required`, then fails. An empty `model` means the model the classic default would use.
- **Agent, Provider, Model.** An agent step's config is `{agent, provider, model, thinking, ...}`. The hefyn agent takes any connected model (`model` is the full `provider/model` id; no `provider`). A CLI agent takes a provider it can use (its manifest's `providers`; Claude Code Anthropic, Codex OpenAI, OpenCode and Pi Anthropic plus any OpenAI-compatible provider) that is connected with an API key, and one of that provider's models (bare id). A step saved without `provider` runs on the agent's own API's provider (Anthropic / OpenAI), so every old Assistant reads as before and nothing is migrated. `assistants.options` returns per CLI agent `providers: [{id, name, connected, reason?, models: [{id, name, contextWindow, reasoning, vision}]}]` (the agent's own provider first, with a reason when no key is connected). `assistants.save` / `validate` refuse with a plain message per agent, provider and model (`checkChoice` in `src/server/agent-choices.ts`); availability (`assistants.list`) judges the key of the chosen provider. Chats on a CLI agent without an Assistant use the admin's default provider and model for that agent (Settings, Agents & keys, "Default model": `agents.update` `defaultProvider` + `defaultModel`, both or neither; `agents.models` lists the choices). The session, not the sandbox, decides the upstream (docs/SANDBOX.md "Providers per session"). **Claude Code runs the wrapper** (docs/WRAPPER.md): the official CLI in a PTY, the chat built from its hooks and transcript, so a step's text, tool calls, diffs and permission questions look as before. In a chat somebody is in, a user who is signed in to Claude Code (Settings, Agent accounts) runs it on their own Claude account; otherwise it uses the API key. **A flow's agent steps (and so schedules, and the Assistant-as-tool calls a CLI chat starts) never use a personal account**: `FlowSession.cliStep` marks the session `unattended`, which means the API key only; with no key the step fails with a plain message, and an Assistant flow is listed as unavailable until a key is connected, even for a signed-in user. An Assistant's instructions, skills and model reach Claude Code's config dir (`/tmp/.claude`, or the user's Claude home when they are on their own account, where the user's most recently started chat wins).
- **agent (CLI).** A prompt to that agent's session in a hidden child chat (`conversations.parent_id` = the flow chat; one per agent; not listed; deleted with the chat) driven by the CLI host, with the step's model, instructions and skills applied the way an Assistant's are. Its permission questions appear in the flow chat (`permission` events with `runId`/`node`; answer with `permission`); the step's result is the agent's final message text. Team Assistants grant the sandbox to their roles for the agents in their steps; for a private Assistant the owner needs `sandbox.shell` and the agent's role.
- **assistant.** A quiet sub-run of the other flow (only its Reply texts, joined, come back as `text`; no events of its own). Runs may not enter an Assistant already in the chain (the starting one included) and nest at most 4 deep. An `approval` or `ask` inside a sub-run fails it (nobody can answer). Validation also refuses a reference to itself or to an Assistant that calls it back.
- **router (ai).** One tool-less model call through the gate listing the branches (`id: label (description)` plus `else`) and the text; the answer is matched by id, then label, then a single id mentioned in it; anything else takes `else`. **rules:** the first branch whose rule holds, else `else`.
- **condition ops.** `equals` (trimmed), `contains` (case-insensitive), `matches` (regular expression, case-insensitive; shortcut: no linear-time engine, a pathological pattern can be slow), `empty`, `not_empty`, `gt`/`lt` (numbers, comma allowed; anything else is false).
- **approval / ask.** The run stops with status `waiting` after the `waiting` event. An answer is checked first (a mistyped one leaves the question open), then claimed atomically (only one answer wins), then the run continues. `approval` shows `message` as the question and `content` as what is reviewed (the template `content`; when it renders empty, the `text` of the nearest earlier step that delivered some, so flows saved before the field existed work; the editor suggests `{{<step it is connected from>.text}}`), outputs `text` (the content, as edited when `editable` and approved; a rejection passes it on unchanged) and goes out of `approved` or `rejected`; `ask` outputs `answers` (and `text`); without `fields` it takes `text`. A waiting run survives an agent restart (its state is in the database); a run that was working is marked failed on the chat's next contact with a message to send again. Stop on a waiting run cancels it.
- **code.** Written to `/tmp/flow-<node>.js` (Node detects CommonJS or ES module syntax) or `.py` in the chat's sandbox and run with `node` / `python3`, cwd `/tmp`, time limit `timeoutSec` (default 30, max 300). stdin is `{"input": {"text", "files"}, "steps": {"<node>": <that step's output>}}`; stdout must be JSON (empty is fine: `json` is then absent); `text` is stdout. The sandbox has no network (SANDBOX.md). A private Assistant's code step needs the user to hold `sandbox.shell`; a team Assistant's runs for its roles.
- **tool.** `openClient` as the chat's user (their own credentials for OAuth/bearer connectors), `callTool`; `json` is `structuredContent`, else the text parsed as JSON, else the text; an error result fails the step.
- **output.file.** Into the user's `/files` (relative path, no `..`) through the same storage the Files API uses (container or host dir, add-ons, upload limit and quota enforced); `path` is the written path.
- **Sharing.** `assistants.share` validates the flow for the team and files a Hub package of kind `assistant` (`asst_<id>`, `assistant.json`) as `pending` in the existing review queue (`hub.review` / `hub.approve` / `hub.reject` work on it, so the Hub's review UI needs only to know the kind). Approval (via `assistants.review` or `hub.approve`) creates or updates the team copy `t_<id>`; rejection marks the private one `declined`.
- **In CLI agents (mods).** Every Assistant the user may use (role, availability as `assistants.list`) is a tool `assistant_<slug>` (input `{message}`; the description is the Assistant's) of hefyn's own MCP server, `src/cli-agents/mcp.ts`, the third route `/mcp` on the conversation's model socket (the sandbox reaches it as `http://127.0.0.1:47000/mcp`). The chat's own Assistant and the hidden chats of flow steps are left out (no recursion); equal slugs get `-2`, `-3`. A call is a run of that CLI chat (`FlowHost.forCli`): its events (`run_start`, `step_*`, `waiting` ..., not chat text) go into the CLI chat's log with `runId`, an approval or question is answered with `POST /agents/cli/<chat>/answer` like in a flow chat, and the Reply is the tool result. The call answers as an event stream with keep-alives and waits `mcpWaitMs` (30 min) for a person, then cancels the run and returns a plain message; when the agent drops the call the run is cancelled. Each agent whose manifest has an `mcp` file registers the server (Claude Code `mcpServers` http in `.claude.json`, OpenCode `mcp` remote, Codex `[mcp_servers.hefyn]`; Pi has no MCP client) and gets `/<slug>` commands (`config.commandsDir`: Claude Code, OpenCode) or skills (`skillsDir`), marked `hefyn-managed` and swept at every agent start; the list is re-read each turn and the agent restarts (session resumes) when it changed. `tools/list` is computed per request; there is no `list_changed` stream (GET is 405).
- **Trying a step.** `assistants.testStep` (`src/assistants/test-step.ts`) runs one Text, Condition, rule Router or Code step against a sample `{ stepId: output }` with the engine's own comparison, templates and code contract (a copy of the engine's error wording for code: keep them in step). No model, no chat; code runs in the caller's sandbox under a scratch conversation `u_<user>_teststep`, 60 s at most.
- **Tools.** `flow.tools.disabled` (ids in `src/agents/tool-filter.ts`) is the Assistant's list of turned-off tools, saved with it. `mountUserTools` (`src/agents/mount.ts`) leaves out turned-off sandbox and data tools and wraps a connector's fetch (`hideTools`) so its turned-off tools vanish from `tools/list` and refuse calls: an agent function is synchronous and cannot ask the server for its tool names, which Flue's `tools` allowlist would need. Classic chats read the Assistant's setting, hefyn steps get it in their `StepSpec` (the run's flow snapshot), CLI steps drop turned-off skills, and `assistantTools` (`cli-agents/mcp.ts`) drops turned-off Assistants. The Tools tab (`assistants.tools`, `assistants.tryTool`; `src/assistants/tools.ts`) lists and tries tools. Shortcuts: modules' tools, the browser and chat-to-chat messaging are not switchable; a nested Assistant's steps use the outer Assistant's setting; user-installed Hub skills are not listed.
- **Activity.** The agent process writes `chat_activity` (one row per busy chat, cleared at its start; `src/server/activity.ts`) from the classic observer (`agent-runtime.ts`), `CliSession.publish` and `FlowSession.publish`; `conversations.activity` joins it with the waiting `assistant_runs` in the web process. Hidden step chats are never listed.
- **Not built (v1):** parallel execution of independent branches (they run in sequence), approvals inside Assistant steps, per-step retry, streaming a hefyn step's text into the chat before the Reply (only the Reply is shown), editing a flow while someone's run waits (the run keeps its snapshot), the audit view of step model calls under the flow chat (they are audited under the step's own instance id).
