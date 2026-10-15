# Container sandbox + managed Playwright MCP

Shell for agents (bash, grep, glob, plus read/write/edit) in a per-conversation container, and a managed Playwright MCP
server. Code: `services/runner/` (the only holder of `docker.sock`), `services/sandbox-image/Dockerfile`,
`src/server/container-sandbox.ts` (Flue driver), `test/container-sandbox.test.ts`. **Wired** (see "Wired in v1" at the end); the sections below describe the design.

```
agent --HTTP, x-hefyn-internal--> runner --docker.sock--> sandbox container  (network hefyn-sandbox: internet, no internal services)
agent <------ MCP over HTTP ----------------------------> playwright container (network hefyn-mcp: shared with agent only)
```

## Runner API (`services/runner`, port 8790, internal network only)

Every request, including `/health`, needs `x-hefyn-internal: $HEFYN_INTERNAL_TOKEN` (timing-safe; 401 otherwise). Ids are
`[A-Za-z0-9_-]{1,128}`. The container id returned is `sha256(userId \0 conversationId)[:16]`; callers never name containers.

| Call | Result |
|---|---|
| `GET /health` | `{ok:true}` (checks the Docker daemon) |
| `POST /sandboxes {userId, conversationId}` | `{id}`; idempotent, one container per conversation |
| `POST /sandboxes/:id/exec {cmd, cwd?, env?, timeoutMs?, stdin?, maxOutput?}` | `{stdout, stderr, exitCode, truncated, timedOut}`. `cmd` is a string (run by `bash -c`) or an argv array. `cwd` must be inside `/files` or `/tmp`. `stdin` is base64. Output is capped per stream (default 1 MB, request may raise it to 64 MB), timeout default 120 s, max 10 min (kill via `timeout -k 2s`, hard socket kill 5 s later). Client disconnect cancels the stream |
| `DELETE /sandboxes/:id` | removes the container (files stay on the volume) |
| `POST /mcp/playwright {userId, conversationId}` | `{id, url}` with `url = http://hefyn-pw-<id>:8931/mcp` |
| `DELETE /mcp/playwright/:id` | removes it |

Idle reaper (every 60 s, containers with a running exec are never reaped), per-user and global caps (HTTP 429), JSON logs
(commands, stdin and output are never logged), graceful shutdown. On restart the runner re-adopts running containers with a fresh idle clock.

### Environment

| Var | Default | |
|---|---|---|
| `HEFYN_INTERNAL_TOKEN` | required | shared with web/agent |
| `HEFYN_DATA_DIR` | `/data` | where the runner sees the data volume |
| `HEFYN_RUNNER_HOST_DATA_DIR` | unset | bind mode (local runs): host path of the data dir. Unset: the runner inspects its own container and mounts the same named volume into sandboxes with **`VolumeOptions.Subpath`** (needs Docker Engine >= 26) |
| `HEFYN_SANDBOX_IMAGE` / `HEFYN_PLAYWRIGHT_IMAGE` | `hefyn-sandbox` / `mcr.microsoft.com/playwright/mcp` | operator-set only |
| `HEFYN_SANDBOX_NETWORK` / `HEFYN_MCP_NETWORK` | `hefyn-sandbox` / `hefyn-mcp` | created if missing |
| `HEFYN_SANDBOX_UID` | 1000 | |
| `HEFYN_SANDBOX_PIDS` / `_MEMORY_MB` / `_CPUS` | 256 / 1024 / 1 | `HEFYN_PLAYWRIGHT_MEMORY_MB` 2048 |
| `HEFYN_RUNNER_IDLE_MINUTES` | 15 | |
| `HEFYN_RUNNER_MAX_SANDBOXES_PER_USER` / `HEFYN_RUNNER_MAX_SANDBOXES` | 2 / 20 | `..._PLAYWRIGHT_PER_USER` / `HEFYN_RUNNER_MAX_PLAYWRIGHT`: 1 / 5 |
| `HEFYN_RUNNER_OUTPUT_BYTES`, `_MAX_OUTPUT_BYTES`, `_MAX_TIMEOUT_MS`, `_MAX_BODY_BYTES` | 1 MB, 64 MB, 600000, 96 MB | |

## What a sandbox container is

Fixed image `hefyn-sandbox` (Debian bookworm slim: bash, coreutils, findutils, git, curl, ca-certificates, ripgrep, jq,
python3 + venv + pip, nodejs + npm). User `hefyn`, uid/gid 1000. `users/<id>/files` -> `/files` (rw), `users/<id>/tmp/<conv>` -> `/tmp` (rw),
cwd `/files`. Hardening, all fixed by the runner: `CapDrop ALL`, `no-new-privileges`, read-only rootfs (tmpfs `/run` 16 MB,
`/home/hefyn` 64 MB), pids 256, memory 1 GB (swap = memory), 1 CPU, init process, not privileged, no docker socket, no
other mounts, own bridge network `hefyn-sandbox` with **inter-container communication disabled** (sandboxes cannot reach each other)
and not attached to the compose network (web/agent/redact/runner are unreachable; verified with decoys in the test).

**Volume ownership.** `node:24-slim` services run as root, so the volume is root-owned. On container creation the runner
creates `users/<id>/files` and `tmp/<conv>` and `chown -R`s them to uid 1000 (falls back to `chmod 777` of those two
dirs if it is not root, e.g. local runs; logged as warn). Files that web/agent write afterwards (uploads) are root-owned and
therefore read-only for the shell. Fix when wiring: have `storage.ts` `chown` uploads to `HEFYN_SANDBOX_UID` (preferred), or run web and agent as uid 1000.
The runner container needs `CHOWN`, `FOWNER` and `DAC_OVERRIDE` if you `cap_drop: ALL`.

## Driver (`src/server/container-sandbox.ts`)

`containerSandboxFactory({ userId, conversationId })` -> `SandboxFactory` (no `tools` override, so Flue's default
bash/grep/glob/read/write/edit apply). The container starts on first use (and transparently restarts once if the runner answers 404 because it was reaped).
Env: `HEFYN_RUNNER_URL` (e.g. `http://runner:8790`), `HEFYN_INTERNAL_TOKEN`.

All filesystem operations run **inside the container** through argv helper commands (`base64 -w0`, `cat >` with base64 stdin transport,
`stat`, `find -printf`, `test -e`, `mkdir`, `rm`, `mv`), so reads/writes follow symlinks in the container's namespace only. A symlink the shell makes to
`/etc/passwd` reads the container's passwd, never the host's (integration test). Paths are validated (`/files`, `/tmp`, no `..`, NUL, backslash) before the call. Errors carry fs-style
`code` (`ENOENT`, `EISDIR`, `EEXIST`, ...) mapped from stderr; a dead runner raises Flue's `SandboxDiedError`; timeouts yield exit code 124 and a note in stderr.
`containerFs(opts)` additionally exposes `rename` (not part of Flue's driver), `run` and `destroy()` (call on conversation delete).
Limit: reads over 48 MB fail (`EFBIG`); writes are bounded by the runner body cap (96 MB).

## TOCTOU (DESIGN.md Risks)

`storage.ts` checks realpath-before-use on the host. That is safe only while nobody can create symlinks on the host dir. A container with a shell can
(it can swap a path between check and use). So: **never use the host-side file-only sandbox (`userSandbox`) for a user while a container sandbox has shell access to
the same dir.** Pick one mode per agent run and keep it for the whole conversation. The Files page (`storage-routes.ts`, host side) still reads user dirs on the host;
for users who have `sandbox.shell` it must either also go through the container driver (`containerFs`) or accept the race (attacker = that user's own shell, target = host files readable
by the web process). Recommended: route Files downloads through `containerFs.readFileBuffer` for shell users.

## Wiring

### compose (`docker-compose.yml`)

```yaml
services:
  agent:
    environment:
      HEFYN_RUNNER_URL: http://runner:8790
    networks: [default, hefyn-mcp]
    depends_on: [redact, runner]
  runner:
    build: ./services/runner
    environment:
      HEFYN_INTERNAL_TOKEN: ${HEFYN_INTERNAL_TOKEN:?set HEFYN_INTERNAL_TOKEN in .env}
      HEFYN_SANDBOX_IMAGE: hefyn-sandbox
    volumes:
      - hefyn-data:/data
      - /var/run/docker.sock:/var/run/docker.sock
    networks: [default, hefyn-mcp]      # default = internal compose network; NOT published
    cap_drop: [ALL]
    cap_add: [CHOWN, FOWNER, DAC_OVERRIDE]
    read_only: true
    security_opt: [no-new-privileges:true]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8790/health',{headers:{'x-hefyn-internal':process.env.HEFYN_INTERNAL_TOKEN}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
  # build-only service so `docker compose build` produces the image the runner starts; never run by compose
  sandbox-image:
    build: ./services/sandbox-image
    image: hefyn-sandbox
    profiles: [build]
networks:
  hefyn-mcp:
    name: hefyn-mcp      # fixed name: the runner attaches Playwright containers to it
```

`docker compose --profile build build` (or `docker build -t hefyn-sandbox services/sandbox-image`) before first use. The sandbox network
(`hefyn-sandbox`) is created by the runner at first use (icc disabled), deliberately outside compose. `docker.sock` access: on Linux the in-container root user can use it
without extra groups. Dev stack: same services in `docker-compose.dev.yml`; the runner needs no Watch (it changes rarely).

### `src/agents/configurable.ts` (mode selection, one mode per user)

```ts
import { containerSandboxFactory } from '../server/container-sandbox.ts';
// `shell` = the user holds sandbox.shell (resolve once per conversation start and keep it; do not flip mid-conversation)
if (userId) useSandbox(shell && process.env.HEFYN_RUNNER_URL
  ? containerSandboxFactory({ userId, conversationId: id })
  : userSandboxFactory({ userId, conversationId: id }), { cwd: '/files' });
```

The mode must be stored per user (not per request) so a user never has both a host-side sandbox and a shell on the same dir in flight at once: persist it in the conversation row and
reject switching while a shell conversation exists, or simply make "has sandbox.shell" the per-user mode for every conversation (host sandbox is then unused for that user).
Call `containerFs(...).destroy()` from conversation deletion (next to `deleteConversationTmp`).

### Permissions (`src/server/permissions.ts`)

- Add `'sandbox.shell'` to `PERMISSIONS`; Admin: yes (admins hold every permission), Worker: **no** (not in `WORKER_DEFAULTS`). The UI role editor lists it automatically if it iterates `PERMISSIONS`.
- Playwright is a built-in **managed connector** gated by `mcp.run_managed`: in `configurable.ts`, when the user may run managed MCP and has enabled it, call the runner
  `POST /mcp/playwright {userId, conversationId}` (lazily, at first turn that needs it) and register `useMcpConnection({ name: 'playwright', url, transport: 'streamable-http', optional: true })`;
  failure (429, runner down) must not fail the conversation (`optional: true`). Delete it with `DELETE /mcp/playwright/:id` on conversation end / delete; the reaper covers the rest.
  Playwright carries no mounts and no secrets: it is stateless (`--isolated`, in-memory profile).

### Connectors catalog

Show Playwright as a built-in entry ("Browser") in the connectors/hub list, enabled per user only when `mcp.run_managed` is held. The hub `mcp` kind
("managed container image + port") stays unsupported by the runner: the runner only starts the two fixed images. Arbitrary images would make the runner a general container launcher.

## Playwright MCP assumptions (verified against `mcr.microsoft.com/playwright/mcp:latest` on 2026-10-15)

Image entrypoint is `tini -- node /app/cli.js --headless --browser chromium --no-sandbox`, user `node`. The runner appends
`--host 0.0.0.0 --port 8931 --isolated --allowed-hosts '*'` and serves streamable HTTP at `/mcp` (integration test: `initialize` + `tools/list` returned `browser_navigate`).
`--allowed-hosts '*'` disables the server's Host check, because the agent reaches it by container name; the network is the access control.
The image tag is `latest` (pin a digest in `HEFYN_PLAYWRIGHT_IMAGE` for production). Chromium `--no-sandbox` is required because caps are dropped; the container (read-only rootfs, tmpfs `/tmp`, 512 MB shm) is the boundary.

## Risks and what the runner allows / refuses

`docker.sock` is root-equivalent on the host. Compromise of the runner = host compromise, so its surface is deliberately small.

**Allows (authenticated callers only):** create/exec/remove containers from two operator-configured images, with fixed flags; mounts only `users/<validated id>/files` and `tmp/<validated id>`
of the data volume; exec of arbitrary commands inside those containers as uid 1000 (that is the feature); create two bridge networks.
**Refuses:** any caller-chosen image, flag, mount, network, user, capability, privileged mode or host path; exec in containers it did not label; ids that are not `[A-Za-z0-9_-]{1,128}` / 16-hex; cwd outside `/files`/`/tmp`; bad env names; oversized bodies/output; unauthenticated requests; no generic Docker passthrough.

Remaining risks, be honest about them:

- The token is the only gate. Anyone on the internal compose network with the token can run commands as any user (`userId` is trusted from the caller). web/agent must derive `userId` from the session only.
- Sandboxes have unrestricted internet egress (needed for git/npm/pip): data exfiltration of anything in `/files` is possible by design, and cloud metadata endpoints (169.254.169.254) are reachable on cloud hosts. Block them with host firewall rules (`DOCKER-USER` chain) in production.
- **Redaction does not see shell traffic**: file contents the shell reads still pass through the model gateway (redacted as text), but output of commands the model never asks the user about is not extra-protected; and whatever the shell sends to the internet bypasses redaction entirely.
- **Playwright screenshots are images. The redaction layer passes images through unredacted**, so a screenshot of a page with personal data goes to the model provider as is. Not solved here; consider disabling image output (`--caps`/tool filter) for sensitive profiles or adding OCR redaction later.
- Quota: bytes written by the shell bypass `checkQuota` in `storage.ts` (it counts only on the host write path). Add a periodic `usageBytes` check that kills the sandbox over quota, or use a size-limited volume. Until then a shell user can fill the data volume.
- Playwright containers share `hefyn-mcp` with the agent and with each other (ICC cannot be disabled there without cutting the agent off), and the network has internet egress and can reach the agent's port 3000. Do not rely on the agent's port being unauthenticated; consider a runner-side proxy later.
- A timed-out `exec` kills the process group via `timeout`; a process that daemonises out of the group survives until the idle reaper or `DELETE`.
- Stale-file ownership (see above) and the host-side TOCTOU (see above).
- Kernel-level container escapes are out of scope of this hardening; gVisor/Kata (`--runtime`) is the next step for a multi-tenant public deployment.

## Tests

`node --test test/container-sandbox.test.ts`: unit tests (validation, 401s, limits, reaper selection, demux, fake-docker hardening assertions, driver against a fake runner) always run.
The integration test needs a Docker daemon and socket (skips with a message otherwise). It builds the image as `hefyn-sandbox-test:<run>`, runs the runner in-process against the real socket
with a temp data dir and uniquely named networks, and removes every container, network and image it created. Last run: 15/15 pass including the Playwright MCP handshake (image was present locally).


## Wired in v1 (decisions applied)

- **Mode per user:** permission `sandbox.shell` (Admin yes, Worker no) + `HEFYN_RUNNER_URL` => `containerSandboxFactory` (bash/grep/glob/read/write/edit); otherwise the
  file-only host sandbox. Resolved from the role at each render (`src/server/runner.ts`); changing a role mid-conversation swaps the sandbox at the next turn.
- **TOCTOU:** for shell users the Files API and chat attachments run through `containerStorage` (`runner.ts`) in a per-user `files` container (same runner API, reaped when idle),
  never through host-side realpath checks. Verified: a shell-made `ln -s /etc/passwd /files/p` downloads the *container's* passwd (test + Docker run).
  Non-shell users keep the host path (no shell can write their dir).
- **Ownership:** web and agent images run as uid/gid 1000 (`/data` is created owned by 1000, so new volumes inherit it). The runner only chowns the directory levels it creates
  (no recursive walk). Volumes from before this change are root-owned: `chown -R 1000:1000` the volume once. The sandbox mounts use `NoCopy`: without it Docker copies the image's
  root-owned `/files` over the user's dir on first start (found in the Docker run; bind mode in the tests never showed it).
- **Quota:** before each exec and write the driver checks the user's usage (cached 60 s, `overQuota` in `runner.ts`) and answers `storage quota exceeded: ...` (exec: exit 1 + stderr).
  Output written within one long command can still overshoot until the next check.
- **Egress:** `HEFYN_SANDBOX_EGRESS=internet|none` (default internet; `none` creates the sandbox network `internal: true`). For `internet` on a real server run
  `scripts/sandbox-egress-rules.sh` (DOCKER-USER rules: RFC1918, link-local/metadata, CGNAT, loopback, host INPUT). An existing network keeps its old setting: remove `hefyn-sandbox` to change it.
- **Playwright:** image pinned by digest in the runner default (`HEFYN_PLAYWRIGHT_IMAGE` overrides). Built-in connector `builtin:playwright` (needs `mcp.run_managed`, enabled per user in Connectors);
  the agent mounts it with the container's derived URL and a `fetch` that asks the runner to start it on first use (`optional: true`). Screenshots are not redacted (API `note`).
- **Limits:** one sandbox container per active conversation plus one `files` container per shell user: per-user cap raised to 8 (`HEFYN_RUNNER_MAX_SANDBOXES_PER_USER`).
- **Compose:** `runner` (only service with docker.sock; internal; caps CHOWN/FOWNER/DAC_OVERRIDE), `sandbox-image` (profile `build`), network `hefyn-mcp` for agent + runner + Playwright.
  `docker compose --profile build build` before first use. Dev: the runner source is synced and only the runner restarts.
- **Fixed on the way:** `exists()` used `test -e --`, which GNU `test` rejects (every run failed on the AGENTS.md probe in a real container).
