# hefyn docs

Proof of concept; the docs describe the code as it is today.

## Using and running

- [SELF-HOSTING.md](SELF-HOSTING.md): install with Docker, `.env`, reverse proxy, backups and upgrades. For admins.
- [ENCRYPTION.md](ENCRYPTION.md): key modes, who sees what, honest limits. For admins and reviewers.
- [SANDBOX.md](SANDBOX.md): the runner, sandbox containers, networks, limits and egress. For admins and developers.
- [DEVICES.md](DEVICES.md): pairing a laptop (stage 1) and what is planned. For users and developers.

## How it works

- [DESIGN.md](DESIGN.md): components, networks and the path of a chat turn. Start here.
- [WRAPPER.md](WRAPPER.md): how Claude Code is hosted in a terminal and turned into chat events. For developers.
- [MODULES.md](MODULES.md): the module system and how to write a module or agent manifest. For developers.
- [STORAGE.md](STORAGE.md): per-user files, quotas and WebDAV.
- [HUB.md](HUB.md): the package store behind skills, Assistant sharing and agent modules (its UI page is retired).
- [HUB-API.md](HUB-API.md): the Hub HTTP API.
- [API.md](API.md): the HTTP API of the web service. For integrators and developers.

## Direction and design

- [HARNESS.md](HARNESS.md): product scope, what is built and planned, the stages.
- [UI-DESIGN.md](UI-DESIGN.md): brand and console design rules. For designers and front-end developers.

## Examples

[examples/](examples/): example Assistant bundles (`examples/assistants/`) and a sample module manifest (`hello-module.json`).
