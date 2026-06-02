#!/bin/bash
# Idempotent egress reconciler for sdk-only containers.
#
# Invoked by the Cast host (root, via `container exec -i <name>`):
#   container exec -i <name> /app/update-egress.sh reconcile   # desired set on stdin
#
# The HOST is the brain: it resolves the allowlist, applies grace-window aging,
# and computes the full desired pin-set. This script is a dumb applier — it makes
# the container's CAST_EGRESS chain and the /etc/hosts CAST-EGRESS block MATCH the
# desired set, idempotently. Re-running with the same input is a no-op.
#
# Desired set on stdin, one pin per line, tab-separated:
#   <host>\t<ip>\t<family: 4|6>\t<port>
# For a literal-IP allowlist entry, host == ip (no /etc/hosts line is written).
#
# Only CAST_EGRESS is touched; OUTPUT's base rules (lo, ESTABLISHED, the MCP
# gateway, the chain jump, and the final REJECT) are never modified here.
set -u

MODE="${1:-}"
if [ "$MODE" != "reconcile" ]; then
  echo "usage: update-egress.sh reconcile  (desired set on stdin)" >&2
  exit 2
fi

payload="$(cat)"

# Refuse an empty desired set: it would flush egress to nothing, which is almost
# certainly a host-side bug rather than an intended "block all". Fail loudly and
# leave the existing rules in place.
if [ -z "${payload//[$'\n\t ']/}" ]; then
  echo "update-egress: empty desired set, refusing to wipe egress" >&2
  exit 3
fi

# Reconcile the firewall: flush the chain, then repopulate from the desired set.
iptables -F CAST_EGRESS || exit 1
ip6tables -F CAST_EGRESS || exit 1

hosts_block=""
while IFS=$'\t' read -r host ip family port; do
  [ -z "$ip" ] && continue
  if [ "$family" = "6" ]; then
    ip6tables -A CAST_EGRESS -p tcp -d "$ip" --dport "$port" -j ACCEPT || exit 1
  else
    iptables -A CAST_EGRESS -p tcp -d "$ip" --dport "$port" -j ACCEPT || exit 1
  fi
  # Pin a name only when it differs from the IP (literal-IP entries need none).
  if [ "$host" != "$ip" ]; then
    hosts_block="${hosts_block}${ip} ${host}"$'\n'
  fi
done <<< "$payload"

# Reconcile /etc/hosts: strip the existing CAST-EGRESS block (preserving every
# other line, e.g. casthost), then append the fresh block. Write back IN PLACE
# (truncate + write, same inode) — Docker bind-mounts /etc/hosts, so a rename or
# `sed -i` would break the mount with "Device or resource busy".
preserved="$(awk '
  /^# CAST-EGRESS-BEGIN$/ { skip = 1 }
  !skip                   { print }
  /^# CAST-EGRESS-END$/   { skip = 0 }
' /etc/hosts)"

{
  printf '%s\n' "$preserved"
  printf '# CAST-EGRESS-BEGIN\n'
  printf '%s' "$hosts_block"
  printf '# CAST-EGRESS-END\n'
} > /etc/hosts
