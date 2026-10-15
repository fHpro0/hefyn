# Shell sandbox for agents. Runs as uid 1000 (see docs/SANDBOX.md); the runner adds the hardening flags.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash coreutils findutils git curl ca-certificates ripgrep jq python3 python3-venv python3-pip nodejs npm \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --user-group --create-home --shell /bin/bash hefyn \
 && mkdir -p /files
USER hefyn
WORKDIR /files
CMD ["sleep", "infinity"]
