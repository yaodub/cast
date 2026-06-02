#!/bin/bash
set -e

# Network isolation via iptables/ip6tables.
# CAST_NETWORK controls the base policy:
#   "sdk-only" (default) — allow only pinned allowlist endpoints on port 443.
#                          Allowlisted names are resolved at boot and pinned into
#                          /etc/hosts, and DNS (port 53) is CLOSED, so the
#                          container resolves without a reachable resolver — this
#                          shuts the DNS-exfiltration channel. The allowlist pins
#                          live in the reconcilable CAST_EGRESS chain, which the
#                          host refreshes live (see update-egress.sh).
#   "full"               — no firewall, full internet access
#   "none"               — block all egress (container has no network)
#
# CAST_ALLOWED_ENDPOINTS adds extra allowed destinations for sdk-only mode.
# Format: comma-separated "domain_or_ip:port" pairs. Port defaults to 443.
# Examples: "api.openweathermap.org:443,hooks.slack.com:443,192.168.1.100:5432"
#
# Runs as root to apply iptables, then drops to node user.
# MCP communication uses Unix domain sockets (filesystem), unaffected by network rules.

NETWORK_MODE="${CAST_NETWORK:-sdk-only}"

# Default-route gateway IP, read from /proc/net/route (the image ships no iproute2,
# so `ip route` is unavailable). The default route is the row whose hex destination
# is 00000000; its gateway field is a little-endian hex quad. Prints nothing when
# there is no default route.
default_gateway() {
  local _if dest gw _rest
  while read -r _if dest gw _rest; do
    [ "$dest" = "00000000" ] || continue
    printf '%d.%d.%d.%d\n' \
      "$(( 0x${gw} & 255 ))" \
      "$(( (0x${gw} >> 8) & 255 ))" \
      "$(( (0x${gw} >> 16) & 255 ))" \
      "$(( (0x${gw} >> 24) & 255 ))"
    return 0
  done < /proc/net/route
}

# MCP TCP carve-out. The runner connects to ${CAST_MCP_HOST:-host.docker.internal}
# (agent-runner src/index.ts), a name pinned into /etc/hosts via
# --add-host host.docker.internal:host-gateway (container-runner.ts, present whenever
# CAST_MCP_PORTS is set). Resolve that exact name and ACCEPT TCP to the resolved IP(s)
# on the MCP ports ONLY — narrow, no wide fallback. On Docker Desktop host.docker.internal
# is a NAT address distinct from the bridge default gateway, so we must NOT pin
# default_gateway() here. Rules go on the static OUTPUT chain (not CAST_EGRESS), so a live
# update-egress refresh never drops them. Caller guards with [ -n "$CAST_MCP_PORTS" ].
allow_mcp_host() {
  local mcp_host="${CAST_MCP_HOST:-host.docker.internal}"

  # CAST_MCP_PORTS is "name=port,name=port" (container-runner builds it from numeric
  # ports). Extract a unique list of numeric ports; non-numeric entries are dropped.
  local ports="" entry p
  local IFS=','
  for entry in $CAST_MCP_PORTS; do
    p="${entry##*=}"
    case "$p" in ''|*[!0-9]*) continue ;; esac
    case " $ports " in *" $p "*) ;; *) ports="${ports:+$ports }$p" ;; esac
  done
  unset IFS

  # Resolve from /etc/hosts (port 53 is closed; same getent path allow_endpoint uses).
  local v4 v6 ip
  v4=$(getent ahostsv4 "$mcp_host" 2>/dev/null | awk '{print $1}' | sort -u)
  v6=$(getent ahostsv6 "$mcp_host" 2>/dev/null | awk '{print $1}' | sort -u)

  for ip in $v4; do
    for p in $ports; do
      iptables -A OUTPUT -p tcp -d "$ip" --dport "$p" -j ACCEPT
    done
  done
  for ip in $v6; do
    # Skip IPv4-mapped addresses (::ffff:a.b.c.d) — the v4 rules above already cover them.
    case "$ip" in ::ffff:*) continue ;; esac
    for p in $ports; do
      ip6tables -A OUTPUT -p tcp -d "$ip" --dport "$p" -j ACCEPT
    done
  done
}

# Ensure 'casthost' resolves to the host machine.
# Docker variants: container-runner.ts passes --add-host casthost:host-gateway,
# so Docker has already written the entry to /etc/hosts before this runs.
# Apple Container has no --add-host equivalent; the host appears as the
# default-route gateway on the bridge, so inject the mapping ourselves.
# This entry lives outside the CAST-EGRESS block and survives host refreshes.
if ! grep -qE '[[:space:]]casthost([[:space:]]|$)' /etc/hosts 2>/dev/null; then
  CASTHOST_IP=$(default_gateway)
  if [ -n "$CASTHOST_IP" ]; then
    echo "$CASTHOST_IP casthost" >> /etc/hosts 2>/dev/null || true
  fi
fi

# Resolve a domain (or accept a literal IP) and pin it: add ACCEPT rules to the
# CAST_EGRESS chain for both IPv4 and IPv6, and — for domains — pin name->IP into
# /etc/hosts so the container can resolve it without DNS.
# Usage: allow_endpoint "domain_or_ip" "port"
allow_endpoint() {
  local host="$1"
  local port="$2"

  # Literal IPv4 — rule only, no name to pin
  if echo "$host" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(/[0-9]+)?$'; then
    iptables -A CAST_EGRESS -p tcp -d "$host" --dport "$port" -j ACCEPT
  # Literal IPv6 — rule only, no name to pin
  elif echo "$host" | grep -qE '^[0-9a-fA-F:]+(/[0-9]+)?$'; then
    ip6tables -A CAST_EGRESS -p tcp -d "$host" --dport "$port" -j ACCEPT
  else
    # Domain — resolve and pin each IP into CAST_EGRESS + /etc/hosts
    local ips
    ips=$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u)
    for ip in $ips; do
      iptables -A CAST_EGRESS -p tcp -d "$ip" --dport "$port" -j ACCEPT
      echo "$ip $host" >> /etc/hosts
    done
    local ip6s
    ip6s=$(getent ahostsv6 "$host" 2>/dev/null | awk '{print $1}' | sort -u)
    for ip in $ip6s; do
      # Skip IPv4-mapped addresses (::ffff:a.b.c.d) — getent synthesizes these
      # for v4-only hosts; the v4 rule + /etc/hosts line above already cover them.
      case "$ip" in ::ffff:*) continue ;; esac
      ip6tables -A CAST_EGRESS -p tcp -d "$ip" --dport "$port" -j ACCEPT
      echo "$ip $host" >> /etc/hosts
    done
  fi
}

if [ "$NETWORK_MODE" = "sdk-only" ]; then
  # Reconcilable egress chain — holds the resolved-allowlist pins (Anthropic +
  # CAST_ALLOWED_ENDPOINTS). The host refreshes it live via update-egress.sh, so
  # OUTPUT's base rules below are never disturbed by an update.
  iptables -N CAST_EGRESS
  ip6tables -N CAST_EGRESS

  # Static OUTPUT base rules (never reconciled)
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  ip6tables -A OUTPUT -o lo -j ACCEPT
  ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  # Port 53 is deliberately NOT opened: allowlisted names are pinned into
  # /etc/hosts below, so the container resolves without DNS. Closing 53 shuts the
  # DNS-exfiltration channel (no resolver reachable for arbitrary names).

  # MCP TCP carve-out — static rules on OUTPUT, kept out of the reconcilable chain so a
  # refresh never drops them. (CAST_MCP_PORTS is set when the runtime can't mount Unix
  # sockets, e.g. Docker Desktop macOS.)
  if [ -n "$CAST_MCP_PORTS" ]; then
    allow_mcp_host
  fi

  # Boot pin: resolve the allowlist into CAST_EGRESS rules + a fenced /etc/hosts
  # block. DNS still works here because the final REJECT is appended afterward.
  echo "# CAST-EGRESS-BEGIN" >> /etc/hosts
  allow_endpoint "api.anthropic.com" 443
  allow_endpoint "claude.ai" 443
  allow_endpoint "platform.claude.com" 443
  if [ -n "$CAST_ALLOWED_ENDPOINTS" ]; then
    IFS=',' read -ra ENDPOINTS <<< "$CAST_ALLOWED_ENDPOINTS"
    for entry in "${ENDPOINTS[@]}"; do
      # Parse "host:port" — default port 443
      ep_host="${entry%%:*}"
      ep_port="${entry##*:}"
      if [ "$ep_port" = "$ep_host" ]; then
        ep_port=443
      fi
      # casthost is the host bridge gateway — an alias only the container knows.
      # Pin it on the static OUTPUT chain (not CAST_EGRESS) so a host refresh never
      # drops it, and so the host controller — which can't resolve a container-only
      # name — leaves it alone. The name->IP mapping is injected above, outside the
      # fence; read it back here so this works on both runtimes (Docker --add-host
      # and the Apple Container self-injection write the same /etc/hosts entry).
      if [ "$ep_host" = "casthost" ]; then
        # ahostsv4 (not `hosts`) so we deterministically take the IPv4 address: the
        # rule below is iptables (v4), and a v6 literal here would fail it under set -e.
        ch_ip=$(getent ahostsv4 casthost 2>/dev/null | awk '{print $1; exit}')
        if [ -n "$ch_ip" ]; then
          iptables -A OUTPUT -p tcp -d "$ch_ip" --dport "$ep_port" -j ACCEPT
        fi
        continue
      fi
      allow_endpoint "$ep_host" "$ep_port"
    done
  fi
  echo "# CAST-EGRESS-END" >> /etc/hosts

  # Route OUTPUT through the egress chain, then block everything else.
  iptables -A OUTPUT -j CAST_EGRESS
  iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable
  ip6tables -A OUTPUT -j CAST_EGRESS
  ip6tables -A OUTPUT -j REJECT --reject-with icmp6-port-unreachable

elif [ "$NETWORK_MODE" = "none" ]; then
  iptables -A OUTPUT -o lo -j ACCEPT
  ip6tables -A OUTPUT -o lo -j ACCEPT
  # MCP is the agent's own tooling, not policy egress — keep it reachable even under
  # "none" so TCP-transport agents match socket-runtime agents (which keep MCP via the
  # unix socket). Same narrow carve-out as sdk-only, appended before the REJECTs.
  if [ -n "$CAST_MCP_PORTS" ]; then
    allow_mcp_host
  fi
  iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable
  ip6tables -A OUTPUT -j REJECT --reject-with icmp6-port-unreachable
fi
# "full" — no rules applied, full internet access

# Fix MCP socket permissions — virtio-fs strips permissions on mounted socket files.
# Entrypoint runs as root so we can chmod before dropping to node user.
if [ -d /mcp ]; then
  chmod 777 /mcp/*.sock 2>/dev/null || true
fi

# Python packages — host installs via pip MCP tool into home/.python-packages/
export PYTHONPATH="/home/agent/.python-packages${PYTHONPATH:+:$PYTHONPATH}"

# Drop to node user and run the agent
exec runuser -u node -- node /app/dist/index.js
