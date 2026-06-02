/**
 * Admin change audit log — `state/admin-changelog.jsonl`.
 *
 * Every mutating console MCP tool appends one entry here. Single-process
 * localhost use — `fs.appendFileSync` is safe. Secret values are never
 * logged (only key names). Config file changes are tracked by the existing
 * backup system — not duplicated here.
 *
 * Readers: the Configure console surfaces "what changed recently" on demand
 * via chat; no separate UI widget for alpha.
 */
import fs from 'fs';
import path from 'path';

import { agentPath } from '../../config.js';
import { logger } from '../../logger.js';

export interface ChangelogEntry {
  /** Actor — agent-label-ish string. `'local'` for admin-UI-originated calls. */
  actor: string;
  /** Action name — e.g. `set_lifecycle`, `pair_user`, `revoke_user`. */
  action: string;
  /** Optional action-specific fields. Keep primitives; no secret values. */
  [field: string]: unknown;
}

/**
 * Append a changelog entry for the given agent. Creates the `state/` dir and
 * the file if needed. Failures are logged but don't throw — callers shouldn't
 * fail a user-visible action because the audit log couldn't be written.
 */
export function appendChangelog(agentFolder: string, entry: ChangelogEntry): void {
  const filePath = agentPath(agentFolder, 'state', 'admin-changelog.jsonl');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(filePath, line);
  } catch (err) {
    logger.warn({ agentFolder, action: entry.action, err }, 'Failed to append changelog entry');
  }
}
