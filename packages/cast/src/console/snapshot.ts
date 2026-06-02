/**
 * Blueprint snapshot for console sessions.
 *
 * Created at session start, mounted read-only at /ref/snapshot/ so Claude can
 * diff against it and restore files via standard Read/Write tools. Deleted on
 * session end.
 *
 * Excludes node_modules — large, reproducible via `npm install`. The snapshot
 * captures source and config, not installed dependencies.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { agentPath } from '../config.js';
import { logger } from '../logger.js';

/** Deterministic short hash of a conversation key — same scheme as sessionCastSocketPath. */
export function keyHash(conversationKey: string): string {
  return createHash('sha256').update(conversationKey).digest('hex').slice(0, 12);
}

/** Host-side snapshot directory for a given conversation. */
export function snapshotPath(agentFolder: string, conversationKey: string): string {
  return agentPath(agentFolder, 'blueprint-snapshots', keyHash(conversationKey));
}

/**
 * Copy blueprint/ to the snapshot directory. Uses `rsync --exclude` when
 * available, falls back to `cp -R` + manual node_modules prune.
 *
 * Idempotent: if the snapshot already exists (e.g. console session resumed after
 * container idle-out) we keep the original snapshot — it represents the
 * *session-start* state, not the most-recent-spawn state.
 */
export function createSnapshot(agentFolder: string, conversationKey: string): string {
  const dest = snapshotPath(agentFolder, conversationKey);
  if (fs.existsSync(dest)) {
    return dest;
  }

  const blueprintDir = agentPath(agentFolder, 'blueprint');
  if (!fs.existsSync(blueprintDir)) {
    fs.mkdirSync(dest, { recursive: true });
    return dest;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  try {
    execFileSync('rsync', ['-a', '--exclude=node_modules', `${blueprintDir}/`, `${dest}/`], {
      stdio: 'ignore',
    });
  } catch {
    execFileSync('cp', ['-R', blueprintDir, dest], { stdio: 'ignore' });
    const nm = path.join(dest, 'node_modules');
    if (fs.existsSync(nm)) {
      fs.rmSync(nm, { recursive: true, force: true });
    }
  }

  return dest;
}

/** Remove the snapshot directory. Best-effort — log and continue on failure. */
export function cleanupSnapshot(agentFolder: string, conversationKey: string): void {
  const dir = snapshotPath(agentFolder, conversationKey);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ agentFolder, conversationKey, err }, 'Failed to clean up console snapshot');
  }
}

/**
 * Startup sweep — delete any snapshot directories that don't correspond to
 * a live runner. Handles crash-recovery: if cast was killed mid-session
 * (SIGKILL, panic, power loss) the snapshot never got cleaned up. Called
 * once at AgentManager.init().
 *
 * `activeKeys` is the set of `keyHash(conversationKey)` values currently
 * tracked by the session host. Anything in `sessions/snapshots/` not in
 * that set is an orphan.
 */
export function sweepOrphanSnapshots(agentFolder: string, activeKeys: Set<string>): void {
  const base = agentPath(agentFolder, 'blueprint-snapshots');
  if (!fs.existsSync(base)) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(base);
  } catch (err) {
    logger.warn({ agentFolder, err }, 'Failed to list snapshot directory — skipping sweep');
    return;
  }
  let removed = 0;
  for (const name of entries) {
    if (activeKeys.has(name)) continue;
    const dir = path.join(base, name);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch (err) {
      logger.warn({ agentFolder, name, err }, 'Failed to remove orphan snapshot');
    }
  }
  if (removed > 0) {
    logger.info({ agentFolder, removed }, 'Swept orphan console snapshots');
  }
}
