# Shell sandbox for agents, and the home of third-party CLI agents. Runs as uid 1000 (see docs/SANDBOX.md); the runner adds the hardening flags.
# Node 22 comes from the official image: Debian bookworm's own nodejs is too old for several agents (Claude Code needs >= 22).
FROM node:22-bookworm-slim AS node

FROM debian:bookworm-slim
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash coreutils findutils git curl ca-certificates ripgrep jq python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --user-group --create-home --shell /bin/bash hefyn \
 && mkdir -p /files
# No agent is baked in: admins install them from the ACP Registry into the hefyn-agents volume (mounted read-only at /opt/agents; docs/SANDBOX.md).
# Managed settings (root-owned, the user cannot override them): the http hooks that report to hefyn at 127.0.0.1:47000/hooks/<event> (and only that URL may be a hook),
# and WebSearch/WebFetch denied (the sandbox has no network; the gateway refuses server tools). No sign-in method is touched, no hook is disabled.
# They apply to Claude Code, wherever it is installed; other agents are configured by their profile (src/cli-agents/profiles.ts). Docs: docs/WRAPPER.md.
COPY managed-settings.json /etc/claude-code/managed-settings.json
COPY bridge.mjs run-agent.sh seed.mjs install-agent.mjs /opt/hefyn/
COPY --chmod=755 codex-shim.mjs /opt/hefyn/
USER hefyn
WORKDIR /files
CMD ["sleep", "infinity"]
