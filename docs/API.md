# API additions (privacy layer, agent runtime)

All routes are on the web service under `/api`, session cookie required.

## Privacy / audit

### `GET /api/conversations/:id/audit`
Owner of the conversation only (403 otherwise). One row per model request, newest first (max 200):

```json
{
  "requests": [
    { "id": 12, "provider": "anthropic", "model": "claude-opus-5-5", "status": "ok",
      "findings": [{ "label": "EMAIL", "count": 2 }], "bytes": 5321, "error": null, "ts": "2026-10-15T19:07:02.000Z" }
  ],
  "latest": { "id": 12, "provider": "anthropic", "model": "claude-opus-5-5", "ts": "...", "payload": { } }
}
```

- Each row has `seals: string[]` (placeholder names such as `EMAIL_1` used in that request).
- `status`: `ok` (sent) or `blocked` (redaction failed, nothing left the server; `error` says why; `bytes` is 0).
- `latest.payload`: the exact provider-native request body that was sent for the newest `ok` request ("Sent to <model>" panel).
  It only contains `{{var:LABEL_n}}` placeholders, never the real values. `latest` is `null` if nothing was sent yet.
- Model output is restored server-side: conversation history and streams (`/agents/...`) carry real values.
- A blocked request shows up in the conversation as an assistant error: `Blocked by the privacy layer: <reason>. Nothing was sent to the model.`

### `GET /api/conversations/:id/seals`
Owner only (404 otherwise), `Cache-Control: no-store`. `[{ name: "EMAIL_1", label: "EMAIL", value: "ada@example.com" }]`: the conversation's placeholder map (real values), for marking sealed spans in the user's own transcript. Contains secrets: do not cache or log.

### Privacy guarantees (summary; see README "Privacy guarantees")
- Every model request is redacted by GLiNER (+ regex/entropy) before it leaves; blocked requests are audited with a reason. A model-API request that did not pass the gate is refused as a **bypass attempt** (audit `blocked`, `error` contains "bypass attempt").
- Images: by default the gate replaces images (user images, tool-result images, screenshots) with the text `[image removed by the privacy layer]`; audit findings `IMAGE_REMOVED` x n.
  `GET/POST /api/settings/privacy` (permission `models.manage`) `{ allowImages: boolean }` lets images through unredacted (audit finding `IMAGE_SENT_UNREDACTED`).
- `GET /api/runtime` additionally returns `privacy: { gliner: boolean, imagesAllowed: boolean }`. `gliner: false` means the redaction service runs without GLiNER
  (only possible with `HEFYN_ALLOW_NO_GLINER=1` outside production): show a red warning. In production the agent refuses to start and the gate fails closed without GLiNER.

## Agent runtime / restart queue

State machine (stored in app.db): `running -> draining -> restarting -> running`.
While not `running`, new agent submissions (`POST /agents/...`) are rejected with **503** `{ "state": "draining" | "restarting", "error": "..." }`;
reads and streams of existing conversations keep working while the agent process is up. The agent restarts when no
submission is unsettled, or after `HEFYN_DRAIN_TIMEOUT_MS` (default 10 min; Flue resumes interrupted submissions
after its 30 s lease expires).

### `GET /api/runtime`
Any logged-in user (poll it for the banner / composer lock):
`{ "state": "running", "runningTasks": 0, "agentUp": true, "requestedAt": null, "requestedBy": null }`.
`agentUp` is false when the agent heartbeat is older than 5 s (`runningTasks` is then 0).

### `POST /api/runtime/restart`
Permission `models.manage`. Requests a restart (idempotent), returns the same body as `GET /api/runtime`.
A restart is also requested automatically (`requestedBy: "system: provider removed"`) when a provider is removed.
Newly connected providers need no restart: the agent registers them on the next request.

## Files and attachments

Per-user storage (agents see it as `/files`, plus `/tmp` = scratch of the current conversation). All under `/api`, session required.
`GET /api/files?path=`, `GET /api/files/download?path=`, `POST /api/files/upload?dir=` (multipart), `DELETE /api/files?path=`,
`POST /api/files/mkdir {path}`, `POST /api/files/rename {from,to}`, `GET /api/files/usage`, `POST /api/files/keep {conversationId,path,dir?}`.
Details and limits: `docs/STORAGE.md`. For users with `sandbox.shell` the Files API and attachments run inside their sandbox container (symlink-safe, see `docs/SANDBOX.md`); the API is unchanged.
New permission `sandbox.shell` (Admin yes, Worker no): bash/grep/glob in a container; without it the agent has file-only tools.

`POST /api/conversations/:id/attachments` (owner only, multipart) stores into the conversation's scratch dir and returns
`{ saved: [{ name, path: "/tmp/report.pdf", size }] }`; mention that path in the message so the agent can read it.

## Connectors

### Conversation model
- `GET /api/conversations` items: `{ id, title, model, createdAt }` (`model: null` = profile default).
- `PATCH /api/conversations/:id { model: "<id>" | null }` (owner). 403 if the model is not in `GET /api/models/available`.
- `GET /api/models/available` -> `[{ id, name, provider, scope: "company" | "own", label }]` (company models + the caller's own).
- Enforced server-side again when a request leaves the server: a model of someone else's provider is refused
  ("Blocked: this model is not available to you. Nothing was sent to the model.") and audited as `blocked`.

### Own model connections (permission `models.use`)
- `GET /api/connectors/models/providers` -> `{ apiKey: [{id,name}], oauth: [{id,name,description,subscription}] }` (OAuth entries are labelled from the flow's source and sorted: Anthropic, OpenAI, GitHub Copilot, OpenRouter, xAI, then the rest; Radius is not offered)
- `GET /api/connectors/models` -> `[{ provider, name, kind: "api_key"|"oauth", status: "ok"|"expired"|"error", baseUrl, createdAt }]`
  (`expired`: OAuth refresh failed, show "Sign in again").
- `POST /api/connectors/models { provider, apiKey, baseUrl?, models? }` (custom endpoints: `provider: "custom"`, `baseUrl`, `models: [...]`; internal/private addresses are refused)
- `DELETE /api/connectors/models/:provider`
- No restart needed: the agent registers a user's providers as `u-<userId>-<provider>` on the next request.

### Subscription / OAuth login (pi-ai flows, adapted)
1. `POST /api/connectors/oauth/:provider/start { scope?: "me" | "company" }` (default `me`; `company` needs `models.manage`, else 403) -> `{ flowId, authUrl?, device?: { userCode, verificationUrl, expiresInSeconds? }, needsPaste, state }`.
   Open `authUrl` (or show the device code). Flows are bound to the user, single use, and expire after 10 minutes.
2. Providers with a fixed redirect URI end on a page the user cannot reach: ask them to paste the code or the redirect URL:
   `POST /api/connectors/oauth/:provider/complete { flowId, code }` (or `pastedUrl`) -> `{ state: "done"|"error", error? }`. 404 unknown/expired, 409 already used.
3. Device-code flows and callbacks: poll `GET /api/connectors/oauth/:flowId/status` -> `{ state: "pending"|"done"|"error", error? }`.
   With `scope: "company"` a successful sign-in becomes a **company provider** (tokens encrypted, refreshed automatically, registered like every other provider,
   listed in `GET /api/models/providers` and visible to everyone in `GET /api/models/available` as `scope: "company"`); the setup state "provider connected" is satisfied by it.
4. `GET /api/connectors/oauth/callback?state=&code=` (browser redirect target where a provider can redirect to hefyn) answers a small static HTML page
   ("Connected — you can close this window." / "Sign-in failed: ...", strict CSP).

### MCP connectors (permission `models.use`; team visibility needs `profiles.edit_team`)
- `GET /api/connectors/mcp` -> `[{ id, name, visibility: "private"|"team", url, transport: "streamable-http"|"sse", auth: "none"|"bearer"|"oauth", mine, connected, sharedAccount }]` (own + team)
  `connected` is per caller: for `oauth` it means *this user* has signed in ("Sign-in needed" otherwise, also on team connectors); for `bearer` it means a token is set.
  `sharedAccount: true` = team connector with a bearer token: everyone acts as that one shared account.
- `POST /api/connectors/mcp { name, url, transport?, visibility?, auth?, bearer? }` -> `{ id }`; internal/private URLs are refused (400).
- `DELETE /api/connectors/mcp/:id` (owner or Admin)
- `POST /api/connectors/mcp/:id/test` -> `{ ok, tools?: string[], error? }` (owner or team-visible)
- `POST /api/connectors/mcp/:id/oauth/start` (owner) -> `{ authUrl }` or `{ connected: true }`; the authorization server redirects the browser to
  `GET /api/connectors/mcp/oauth/callback` (static HTML page; state is single use, 10 min). MCP auth spec: resource-metadata discovery,
  dynamic client registration, PKCE; tokens are refreshed automatically. On a team connector with `auth: oauth` the definition is shared but tokens are per user: every user signs in themselves (`POST .../oauth/start` works for any visible OAuth connector); users without a token get the connector as unavailable in the agent. A team connector with `auth: bearer` is a shared account; only users with `profiles.edit_team` can set or replace its token.
- `PUT /api/connectors/mcp/:id/bearer { bearer }` (owner; for team connectors anyone with `profiles.edit_team`): sets the token of a bearer connector that was created without one (hub installs).
- Built-in managed connector: for users with `mcp.run_managed` the list starts with
  `{ id: "builtin:playwright", name: "Browser (Playwright)", builtin: true, enabled, connected, available, note, ... }` (`available: false` = no runner configured; `note` is the
  screenshot/redaction warning to show in the UI). `POST /api/connectors/mcp/builtin:playwright/enable` | `/disable` (403 without `mcp.run_managed`, 409 enabling without a runner).
  When enabled the agent mounts the browser tools (`mcp__playwright__...`) from a per-conversation container.
- Mounted tools are named `mcp__<name>_<id4>__<tool>`; their results pass through the redaction seam like any tool result.

## Hub

See `docs/HUB-API.md` (contract) and `docs/HUB.md`. Mounted at `/api/hub`.
Installing an MCP package creates connector entries with `connected: false` until the user signs in (`PUT .../bearer` or the OAuth start flow):
target `me` creates a private entry for the installer, target `team` creates ONE team-visible entry (OAuth: each user signs in for themselves; bearer: shared account set by a team editor). Uninstalling removes the entries of that package for that target.
Installed skills and agents reach the agent automatically (team installs + the user's own); profile agents win name collisions.

## Company providers

`GET /api/models/providers` (permission `models.manage`) -> `{ available: [...], connected: [{ id, name, kind: "oauth" | "api_key", status: "ok" | "expired" | "error" }] }`.
`expired` = the OAuth refresh failed: sign in again (`POST /api/connectors/oauth/:provider/start { scope: "company" }`).
