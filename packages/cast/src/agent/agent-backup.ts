/**
 * Agent backup — init tarball migration and runtime snapshots.
 *
 * Dot-prefix convention: directories starting with '.' are system/meta
 * artifacts excluded from runtime snapshots.
 *
 *   .stamps/   — restamp tarballs from agent provisioning
 *   .backups/  — runtime snapshots (created by the host server)
 *   .composer/ — composer metadata and authoring backups
 */
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { agentPath } from '../config.js';
import { logger } from '../logger.js';
import type { LogEventFn } from './agent-db.js';

/** SHA-256 hash of a file. */
function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** List snapshot tarballs sorted chronologically (oldest first). */
function listSnapshots(backupsDir: string): string[] {
  try {
    return fs
      .readdirSync(backupsDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Build the tar exclude flags for dot-prefixed directories.
 * Scans the agent dir for dot-dirs and returns --exclude flags.
 */
function buildExcludes(agentDir: string): string[] {
  try {
    return fs
      .readdirSync(agentDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('.'))
      .map((e) => `--exclude=./${e.name}`);
  } catch {
    return [];
  }
}

/**
 * Check whether a backup is due and create a snapshot if so.
 * Called on a 60s poll interval. Only fires after the configured UTC hour
 * and when no snapshot exists for today (or the relevant interval date).
 *
 * Skips dot-prefixed directories. Deduplicates against the most recent
 * existing snapshot by SHA-256 — if identical, the new tarball is deleted.
 * Prunes oldest snapshots exceeding `retain` count.
 *
 * Returns true if a new snapshot was kept, false if skipped.
 */
export function snapshotAgent(agentFolder: string, retain: number, hour = 3, logEvent?: LogEventFn): boolean {
  const now = new Date();
  if (now.getUTCHours() < hour) return false;

  const agentDir = agentPath(agentFolder);
  const backupsDir = path.join(agentDir, '.backups');
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const snapshotPath = path.join(backupsDir, `${today}.tar.gz`);

  if (fs.existsSync(snapshotPath)) return false;

  fs.mkdirSync(backupsDir, { recursive: true });

  const excludes = buildExcludes(agentDir);
  try {
    execFileSync('tar', [
      'czf', snapshotPath,
      ...excludes,
      '-C', path.dirname(agentDir),
      path.basename(agentDir),
    ], { stdio: 'pipe' });
  } catch (err) {
    logger.error({ agentFolder, err }, 'Snapshot tar failed');
    logEvent?.('error', 'backup', 'snapshot_failed', `tar exited non-zero for ${today}`, {
      context: { date: today, error: String(err) },
    });
    return false;
  }

  // Deduplicate: compare hash against most recent existing snapshot
  const existing = listSnapshots(backupsDir).filter((name) => name !== `${today}.tar.gz`);
  if (existing.length > 0) {
    const prevPath = path.join(backupsDir, existing[existing.length - 1]!);
    if (hashFile(snapshotPath) === hashFile(prevPath)) {
      fs.unlinkSync(snapshotPath);
      logger.debug({ agentFolder }, 'Snapshot skipped — no changes since last backup');
      return false;
    }
  }

  logger.info({ agentFolder, snapshot: today }, 'Agent snapshot created');
  logEvent?.('info', 'backup', 'completed', `Daily snapshot created: ${today}`, {
    context: { date: today },
  });

  // Prune oldest snapshots beyond retain count
  const all = listSnapshots(backupsDir);
  const excess = all.length - retain;
  if (excess > 0) {
    for (const name of all.slice(0, excess)) {
      fs.unlinkSync(path.join(backupsDir, name));
      logger.info({ agentFolder, pruned: name }, 'Pruned old snapshot');
    }
  }

  return true;
}
