#!/usr/bin/env bash
# Required on a real server when HEFYN_SANDBOX_EGRESS=internet: stop sandbox containers from reaching the host and the
# private network behind it. Sandboxes keep access to the public internet only.
#
# Run as root AFTER the first sandbox has been started (the runner creates the `hefyn-sandbox` bridge lazily), and again
# if that network is ever recreated. Idempotent. Usage: sudo scripts/sandbox-egress-rules.sh [network-name]
#
# Blocks traffic from the bridge to: RFC1918 (10/8, 172.16/12, 192.168/16), link-local incl. cloud metadata
# (169.254/16), CGNAT (100.64/10), loopback-ish 127/8 and the host itself (INPUT chain). IPv6: see the end of the script.
set -euo pipefail

NET="${1:-hefyn-sandbox}"
ID="$(docker network inspect -f '{{.Id}}' "$NET")"
BR="$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$NET")"
[ -n "$BR" ] && [ "$BR" != "<no value>" ] || BR="br-${ID:0:12}"
echo "network $NET -> bridge $BR"

add() { # chain, then iptables args; insert at the top unless the rule exists
  local chain="$1"; shift
  iptables -C "$chain" "$@" 2>/dev/null || iptables -I "$chain" 1 "$@"
}

# Forwarded traffic (to other networks, other hosts, the internet): DOCKER-USER runs before Docker's own rules.
for dst in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8; do
  add DOCKER-USER -i "$BR" -d "$dst" -j DROP
done
# Traffic to the host itself (any of its addresses) arrives on INPUT: allow replies, drop new connections.
add INPUT -i "$BR" -j DROP
add INPUT -i "$BR" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# IPv6 (only if Docker has ipv6 enabled): drop everything that is not global unicast.
if command -v ip6tables >/dev/null && ip6tables -S DOCKER-USER >/dev/null 2>&1; then
  ip6tables -C DOCKER-USER -i "$BR" -d fc00::/7 -j DROP 2>/dev/null || ip6tables -I DOCKER-USER 1 -i "$BR" -d fc00::/7 -j DROP
  ip6tables -C DOCKER-USER -i "$BR" -d fe80::/10 -j DROP 2>/dev/null || ip6tables -I DOCKER-USER 1 -i "$BR" -d fe80::/10 -j DROP
fi
echo "done. verify from a sandbox: curl -m3 http://169.254.169.254/ must fail; curl -m3 https://example.com must work."
