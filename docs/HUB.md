# Hub backend: wiring notes

Files: `src/server/hub.ts` (core), `src/server/hub-routes.ts` (`hubRoutes()`), `test/hub.test.ts`. Contract: `docs/HUB-API.md`.

## Wiring (existing files, not edited by the hub work)

1. `src/server/api.ts`: `import { hubRoutes } from './hub-routes.ts'; app.route('/api/hub', hubRoutes({ onMcpInstall }));`
   Tables are created on import of `hub.ts` (`ensureHubTables()`, idempotent).
2. MCP install -> Connectors. `hubRoutes({ onMcpInstall: (me, target, connectors) => ... })` receives
   `{name, url, transport: 'streamable-http'|'sse', auth, source: 'hub:<packageId>'}[]` after a successful install.
   Connectors should upsert a per-user entry (`mine: true`, source `hub:<id>`; for target 'team', one per user on
   first use, or resolve from `installedFor`). No credentials are stored by the hub; sign-in happens in Connectors.
   `onMcpInstall(userId, packageId)` in hub.ts is the pure function behind it. Uninstall does not remove connectors (wire if wanted).
3. `src/agents/configurable.ts`, inside `Configurable` after `userId` is known:
   ```ts
   const h = installedFor(userId);                       // from ../server/hub.ts
   for (const s of h.skills) useSkill(defineSkill({ name: s.name, description: s.description, instructions: s.instructions, files: s.files }));
   for (const a of h.agents) useSubagent({ name: a.name, description: a.description, ...(a.model ? { model: a.model } : {}),
     agent: () => { h.skills.filter((s) => a.skills.includes(s.name)).forEach((s) => useSkill(defineSkill(s))); return a.instructions; } });
   // MCP: reuse the Connectors path (mountable()) once the connector entries exist; do not call useMcpConnection with tokens from the hub.
   ```
   (`useMcpConnection({ name, url, transport, auth })` is only valid for `auth: 'none'`.) Log/show `h.warnings`.
   hub.ts imports `mcp.ts` (`assertPublicUrl`); it is fine in the agent process too.

## Decisions

- Bundles embed their contents (all text files + parsed skills/agents/mcp in the manifest); no child packages.
  Plugin `hooks/` and `commands/` -> `manifest.ignored: ['hooks/', 'commands/']`. Skills are found at any depth (SKILL.md dirs).
- Without plugin.json, an imported repo yields one package per skill / `agents/*.md` / remote MCP entry. With a plugin.json (or via a marketplace) it is one bundle.
- stdio MCP entries are only listed in `manifest.needsRunner` ("needs managed runner (phase 4)"); a package with nothing installable returns 409 on install.
- MCP transport is stored as `streamable-http` | `sse` (the Connectors vocabulary; `http` accepted on input). Private/loopback URLs are rejected (`assertPublicUrl`).
- Versioning: same row; content hash changes -> published packages go back to `pending` (drafts stay drafts). `approved_json` (extra column) holds the last approved snapshot
  (manifest + files); installs and non-owner/non-reviewer views only ever use it. Owner's never-approved package installed for themselves ('me') uses live content.
- `installedFor(userId)` = team installs then own; collisions: first wins, rest skipped with an entry in `warnings`.
- Re-importing the same repo as the same user updates the existing package (same owner+kind+name) instead of duplicating.
- Guard runs per text file + name/description (8 in parallel); if the sidecar fails, nothing is saved (502). Flagged packages are never auto-approved;
  a reviewer can still approve explicitly. Test hook: `setGuard()`.
- Import: `https://github.com/owner/repo[/tree/ref/path]` via `codeload.github.com` tarball, manual redirects only to github.com/codeload.github.com, 30 s timeout,
  50 MB download / 100 MB unpacked, then within the chosen subpath max 200 text files, 5 MB, depth 8; binaries skipped; any symlink in that subpath rejects the import.
  Private repos are unsupported (no token). Large repos: import a `/tree/ref/path` subfolder (the whole archive is still downloaded).
- Files are served `text/plain` with `nosniff` and a `default-src 'none'; sandbox` CSP.

## Untested / risks

- Registry: shape verified once against the live `/v0/servers` (servers[].server.{name,description,repository,remotes[{type,url,headers}]}); tests use a stub. Search is the registry's `search` param; import looks up by exact name within the first 50 results.
- No route-level tests (permissions are enforced in hub.ts and tested there); `hubRoutes` typechecks only.
- Marketplace plugin sources: relative `./path`, `owner/repo`, `{source:'github'|'url'}` (GitHub only). Inline (`strict:false`) plugin definitions are not supported.
- Owner display name reads Better Auth's `user` table (falls back to the id).
