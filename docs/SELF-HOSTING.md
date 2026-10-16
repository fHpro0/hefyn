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
| `redact` | redaction engine (regex, entropy, GLiNER, TypeScript port of warden's), CPU/memory limited, warm across agent restarts | internal only, no internet |
| `egress` | allowlisting forward proxy for model, OAuth and MCP traffic | internal + internet |
| `runner` | the only holder of `docker.sock`; starts sandboxes and Playwright | internal |

The `redact` service runs the redaction engine: regex rules, entropy and GLiNER (inference in worker threads; regex, entropy and the hub guard in a worker pool with a hard per-job timeout, `HEFYN_REDACT_WORKERS` default 2, `HEFYN_REDACT_TIMEOUT_MS` default 10000). It is a separate container so the model stays loaded when `agent` restarts and so it has its own limits (`HEFYN_REDACT_CPUS`, default 2; `HEFYN_REDACT_MEMORY`, default 1536m). It has no internet: on first start `web` downloads the GLiNER files (~86 MB, SHA-256 verified) from Hugging Face into the `redact-models` volume, which `redact` mounts read-only. Until they are there `redact` reports GLiNER as `loading` and no model request is sent (fail closed). Agent and web reach it at `HEFYN_REDACT_URL` with the internal token. `HEFYN_REDACT_GLINER=off` (regex and entropy only) additionally needs `HEFYN_ALLOW_NO_GLINER=1` in production.

Data lives in the `hefyn-data` volume (`HEFYN_DATA_DIR`): `app.db` (auth, roles, profiles, usage, hub,
connectors), `flue.db` (conversations) and `users/<id>/{files,tmp}`. Web and agent run as uid/gid 1000;
volumes created by older versions need `docker run --rm -v <volume>:/d busybox chown -R 1000:1000 /d` once.

## Getting the GLiNER model

The redact service needs two files of [`knowledgator/gliner-pii-small-v1.0`](https://huggingface.co/knowledgator/gliner-pii-small-v1.0)
(`tokenizer.json` 3.6 MB and `onnx/model_quint8.onnx` 83 MB). Whatever the source, hefyn only uses files whose size and SHA-256
match the pinned list in `src/server/redact/models.ts`; anything else is rejected. `HEFYN_GLINER_SOURCE` chooses the source
(default `huggingface`). The redact service never downloads anything: it has no internet and only reads and verifies the files.
The Models page (Privacy) shows the source and the state (`ready`, `missing`, `downloading`, `invalid`, `error`); the same is in
`GET /api/runtime` under `privacy` (`glinerSource`, `glinerState`, `glinerDetail`, `glinerHost`).

| Source | Who fetches | Network use |
|---|---|---|
| `huggingface` | `web` on first start, into the `redact-models` volume | Hugging Face (redirects to its CDN, which is AWS-hosted) |
| `mirror` | `web`, from `HEFYN_GLINER_BASE_URL` | only that https host; a redirect to another host is refused |
| `image` | nobody at runtime; baked at build time into `/opt/hefyn/models/gliner` | none at runtime |
| `local` | nobody; files in `HEFYN_GLINER_DIR` (default `models/gliner` in the data volume) or uploaded in the UI | none |

**Mirror.** Serve the same relative layout over https from any static file server, an object store, or a Nextcloud public share
(direct-download links; the base URL must resolve `<base>/tokenizer.json` and `<base>/onnx/model_quint8.onnx`):

```
https://files.example.com/gliner/tokenizer.json
https://files.example.com/gliner/onnx/model_quint8.onnx
```

Set `HEFYN_GLINER_SOURCE=mirror` and `HEFYN_GLINER_BASE_URL=https://files.example.com/gliner`. Plain http is refused. A redirect is only
followed within the same host. A file with a different hash is discarded, so the mirror does not need to be trusted. To fill a mirror,
or to carry the files to an offline machine, run once on a machine with internet (add the mirror URL as the second argument to fetch from a mirror):

```
node scripts/gliner-fetch.ts ./gliner            # downloads from Hugging Face and verifies; bun works too
```

**Baked into the image.** `docker compose build --build-arg HEFYN_GLINER_BAKE=1` (or `HEFYN_GLINER_BAKE=1` in `.env`) downloads and verifies
the files while building (add `--build-arg HEFYN_GLINER_BASE_URL=https://...` to build from a mirror) and stores them read-only in the image;
that image then defaults to `HEFYN_GLINER_SOURCE=image` and `web` makes no model request at all. The default image does not contain the
model and stays small (about 86 MB less).

**Local files / upload.** `HEFYN_GLINER_SOURCE=local`: copy the files into the `redact-models` volume (`models/gliner/`) or point
`HEFYN_GLINER_DIR` at a directory, for example a bind mount in a `docker-compose.override.yml`
(`redact: { volumes: !override ["/srv/hefyn/gliner:/models:ro"] }`, `web` likewise read-write if you want uploads, and `HEFYN_GLINER_DIR=/models` in `.env`).
Admins (permission `models.manage`) can also upload them in Models, Privacy, or with
`POST /api/settings/privacy/gliner/upload` (multipart with the two files, or one `.tar` / `.zip`; at most 300 MB). Each file must have the exact
pinned size and SHA-256, any other file in the upload is rejected (macOS/Windows junk files are ignored), names with `..` or absolute paths are
refused, and files are stored atomically; the target path never comes from the upload. The redact service notices new files within seconds.

**Licence.** The model card of the pinned repository declares `license: apache-2.0` (not gated; developed by Wordcab and Knowledgator).
Apache-2.0 allows redistribution, including on a mirror or inside an image, provided you pass on the licence text and the attribution; keep a
copy of the [licence](https://www.apache.org/licenses/LICENSE-2.0) and the model card with whatever you redistribute and say that the ONNX
file is the quantized export published in that repository. hefyn does this for you: `scripts/gliner-fetch.ts` (and therefore the baked image,
in `/opt/hefyn/models/gliner/`) writes `NOTICE.txt` (model, repo URL, pinned revision, authors, licence) and `LICENSE-Apache-2.0.txt` next to the
model files and also fetches the model card `README.md` (pinned by SHA-256; the repo has no separate LICENSE file; if the card cannot be fetched
the NOTICE and licence text are still written). A download by `web` writes the two notice files too. Uploads may include any of these three
files (verified byte for byte) but never need to. If you mirror the files, put the same three next to them. The card does not describe the training data's own licensing; this is not legal
advice, so check it for your use. hefyn itself does not ship the model.

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
  GLiNER is off in dev (`HEFYN_REDACT_GLINER=on` turns it on, web downloads ~86 MB into the dev data volume).
- **Without Docker:** `bun install && bun run dev` (agent on :5174, web API on :5173, Astro on :4321). `bun run dev` also starts the redact
  service (`node src/redact-server.ts`, :8787; `HEFYN_REDACT_GLINER=off` skips the model, `on` downloads it to `data/models/gliner`).
  The server runs on Node ≥ 22.19 (Bun lacks `node:sqlite`).
- **Checks:** `bun run typecheck`, `bun run test` (builds, then `node --test`; a fake model upstream, no API keys
  needed; the sandbox tests use Docker when available). The GLiNER half of `test/redact-parity.test.ts` is skipped unless the model files are present (`HEFYN_REDACT_MODEL_DIR` or `data/models/gliner`).

## Further reading

- [DESIGN.md](DESIGN.md): architecture and decisions
- [API.md](API.md): HTTP API
- [HUB.md](HUB.md), [HUB-API.md](HUB-API.md): skill hub · [STORAGE.md](STORAGE.md): per-user storage
- [UI-DESIGN.md](UI-DESIGN.md): interface direction
