#!/usr/bin/env python3
"""
agent-snapshot.py — pre-mutation whole-agent snapshot with bounded rotation.

A safety net for advanced-mode sessions (/cast-refine, /cast-build) that may
touch an agent's blueprint OR its runtime data (memory, state, sessions).
Captures the whole agent folder so a bad change can be rolled back.

    usage: agent-snapshot.py <agent-dir> [--label pre-edit] [--retain 5]

Lane model: snapshots land in <agent-dir>/.backups/<label>-<UTC-ts>.tar.gz.
This lane is independent of the server's daily YYYY-MM-DD.tar.gz snapshots —
the daily pruner only matches the date regex, so it never touches this lane,
and this script only prunes its own <label>-* files. Each lane self-rotates to
its own retain bound; nothing here needs manual deletion.

Recursion guard: every dot-prefixed entry at the agent root is excluded
(.backups/, .stamps/, .composer/, .admin, .DS_Store, ...). Since snapshots live
in the dot-prefixed .backups/, a snapshot never contains prior snapshots.
node_modules (large, reproducible) and .DS_Store are excluded everywhere.
Sockets are skipped natively by tarfile.

Dedup is intentionally omitted: a pre-mutation marker is wanted even when little
changed since the last one, and the retain bound caps the cost. Cross-platform
(Linux server + macOS host) — pure stdlib, no shell-out to tar.
"""
import argparse
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path


def make_filter(agent_dir: Path):
    """Return a tarfile add-filter that drops excluded paths (return None = skip).

    Skipping a directory's TarInfo prevents tarfile from recursing into it, so
    excluded subtrees cost nothing to walk.
    """
    def _filter(ti: tarfile.TarInfo):
        comps = [p for p in ti.name.split("/") if p not in ("", ".")]
        if not comps:
            return ti  # the agent-root entry itself
        # Exclude any dot-prefixed entry at the agent root (.backups, .stamps, ...).
        if comps[0].startswith("."):
            return None
        # Exclude node_modules anywhere; drop .DS_Store litter anywhere.
        if "node_modules" in comps or comps[-1] == ".DS_Store":
            return None
        return ti

    return _filter


def prune_lane(backups: Path, label: str, retain: int) -> None:
    """Keep the newest `retain` snapshots in this label's lane; delete the rest.

    Timestamped names sort lexically == chronologically.
    """
    snaps = sorted(backups.glob(f"{label}-*.tar.gz"))
    excess = len(snaps) - retain
    for old in snaps[:max(0, excess)]:
        old.unlink()
        print(f"agent-snapshot: pruned {old}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Pre-mutation whole-agent snapshot.")
    ap.add_argument("agent_dir", help="absolute path to the agent folder")
    ap.add_argument("--label", default="pre-edit", help="snapshot lane name (default: pre-edit)")
    ap.add_argument("--retain", type=int, default=5, help="snapshots kept in lane (default: 5)")
    args = ap.parse_args()

    agent_dir = Path(args.agent_dir).expanduser().resolve()
    if not agent_dir.is_dir():
        print(f"agent-snapshot: not a directory: {agent_dir}", file=sys.stderr)
        return 1

    backups = agent_dir / ".backups"
    backups.mkdir(exist_ok=True)

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = backups / f"{args.label}-{ts}.tar.gz"

    with tarfile.open(out, "w:gz") as tar:
        tar.add(str(agent_dir), arcname=".", filter=make_filter(agent_dir))
    print(f"agent-snapshot: wrote {out}")

    prune_lane(backups, args.label, args.retain)
    return 0


if __name__ == "__main__":
    sys.exit(main())
