# Self-hosting hefyn

## Quick start (Docker)

```sh
bun run init                       # creates .env with random secrets, never overwrites real values
docker compose --profile build build   # once: the shell-sandbox image
docker compose up --build
```

Open http://localhost:3000/setup. The first account becomes the Admin; sign-ups are closed after that and
admins add people under **Users**.

Web, agent, runner and egress refuse to start in production with a missing, placeholder or short (<32 chars)
`HEFYN_SECRET` / `HEFYN_INTERNAL_TOKEN`. Back up `HEFYN_SECRET`: stored provider keys and sign-ins are
encrypted with it (AES-256-GCM) and become unreadable without it.

The compose project is named `hefyn`. Volumes from runs under an older project name (`agent_*`) are not
picked up; remove them with `docker compose -p agent down -v`.

## Services

| Service | Role | Network |
|---|---|---|
| `web` | auth, `/api`, UI, guarded proxy to the agent | published on :3000 |
| `agent` | Flue runtime: agents, conversations, privacy gate | internal only, leaves via `egress` |
| `redact` | redaction sidecar (regex, entropy, GLiNER via `warden-redact`) | internal |
| `egress` | allowlisting forward proxy for model, OAuth and MCP traffic | internal + internet |
| `runner` | the only holder of `docker.sock`; starts sandboxes and Playwright | internal |

Data lives in the `hefyn-data` volume (`HEFYN_DATA_DIR`): `app.db` (auth, roles, profiles, usage, hub,
connectors), `flue.db` (conversations) and `users/<id>/{files,tmp}`. Web and agent run as uid/gid 1000;
volumes created by older versions need `docker run --rm -v <volume>:/d busybox chown -R 1000:1000 /d` once.

## Reverse proxy and client IPs

hefyn uses the socket peer as the client IP for rate limiting. Behind a reverse proxy, set
`HEFYN_TRUSTED_PROXIES` (comma-separated IPs or IPv4 CIDRs of your proxies); only then are `X-Forwarded-For`
/ `X-Real-IP` believed. Without it those headers are stripped. In plain Docker every user appears as the bridge
gateway and shares one rate-limit bucket, so put a proxy (Caddy, nginx, Traefik) in front for real use.

## Shell sandbox

People with the `sandbox.shell` permission (Admin by default) get bash, grep and glob in a per-conversation
container; everyone else gets file-only tools. Design, limits and risks: [SANDBOX.md](SANDBOX.md).

**Egress (required on a real server):** sandboxes can reach the internet by default
(`HEFYN_SANDBOX_EGRESS=internet`). Install the firewall rules so they can't reach the host, your LAN or cloud
metadata: `sudo scripts/sandbox-egress-rules.sh` (after the first sandbox started, and again if the
`hefyn-sandbox` network is recreated). `HEFYN_SANDBOX_EGRESS=none` gives sandboxes no network at all.

The browser connector (Playwright) is available to people with `mcp.run_managed`. Screenshots are removed
before anything is sent to a model unless an admin allows unredacted images.

## Development

- **Docker with hot reload:** `bun run dev:docker`, open http://localhost:4321. Changes in `src/`, `web/src/`,
  `assets/` and `profiles/` reload in place; dependency or config changes rebuild only the affected service.
  GLiNER is off in dev (`HEFYN_REDACT_GLINER=on` turns it on, ~83 MB download).
- **Without Docker:** `bun install && bun run dev` (agent on :5174, web API on :5173, Astro on :4321). Start the
  sidecar with `HEFYN_REDACT_GLINER=off cargo run --manifest-path services/redact/Cargo.toml` and set
  `HEFYN_REDACT_URL=http://localhost:8787`. The server runs on Node ≥ 22.19 (Bun lacks `node:sqlite`).
- **Checks:** `bun run typecheck`, `bun run test` (builds, then `node --test`; a fake model upstream, no API keys
  needed; the sandbox tests use Docker when available), `cargo test` in `services/redact`.

## Further reading

- [DESIGN.md](DESIGN.md): architecture and decisions
- [API.md](API.md): HTTP API
- [HUB.md](HUB.md), [HUB-API.md](HUB-API.md): skill hub · [STORAGE.md](STORAGE.md): per-user storage
- [UI-DESIGN.md](UI-DESIGN.md): interface direction
