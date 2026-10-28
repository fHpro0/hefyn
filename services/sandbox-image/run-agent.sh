#!/bin/bash
# usage: run-agent.sh <command> [args...]   (an agent's ACP server for chat, its terminal UI for the terminal view)
# Starts the model bridge once per container, writes the config the agent's profile asks for (HEFYN_SEED, src/cli-agents/profiles.ts: the base URL on the bridge,
# a dummy key, no telemetry; the real key never enters the sandbox), then execs the command. The environment comes from the caller.
port="${HEFYN_BRIDGE_PORT:-47000}"
if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
  # env -u: the bridge must outlive this attach (the runner kills a closed attach by its HEFYN_ATTACH marker)
  env -u HEFYN_ATTACH setsid node /opt/hefyn/bridge.mjs </dev/null >/dev/null 2>&1 &
  for _ in $(seq 40); do (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && break; sleep 0.05; done
fi
if [ -n "$HEFYN_SEED" ]; then node /opt/hefyn/seed.mjs || exit 70; fi
unset HEFYN_SEED
exec "$@"
