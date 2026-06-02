/**
 * Summary view-dir maintenance for manager consoles (DM/CM/SM).
 *
 * Each manager console has a single bind-mount at `.<console>/view/` →
 * `/ref/agents/` (ro). Contents: `<folder>.<surface>.md` summary files that
 * the walker emits via `surface-summary.ts`. This module owns writing those
 * files at the right times:
 *
 *   - `initializeViewDir`  — populate at startup / console open.
 *   - `maintainViewDir`    — add/remove summary files on agent-registry
 *                            `added` / `removed` events.
 *   - `refreshViewDirFolder` — re-emit one folder's summaries when an
 *                              upstream blueprint edit lands (debounced
 *                              from `ServerScopeConsole`'s file-watcher).
 *
 * The single stable mount replaces the per-agent fanout (`1 + 2N` mounts)
 * that bumped against Apple Container's 22-mount VirtIO-FS ceiling.
 *
 * `writeSurfaceIfChanged` is exported because `manager__resurvey` is
 * conceptually a view-dir refresh exposed as an MCP tool — same primitive,
 * just driven by the LLM on demand.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { AGENTS_DIR, agentPath, listSubdirectories } from '../../config.js';

/** Agent set-membership change shape, fed in by callers that translate
 *  whatever upstream signal they have (Bus lifecycle events today) into
 *  this normalized payload before calling `maintainViewDir`. */
export type AgentSetChange =
  | { kind: 'added'; folder: string }
  | { kind: 'removed'; folder: string };
import { logger } from '../../logger.js';

import { readableSurfaces, viewDirForConsole } from './manager-consoles.js';
import type { ManagerConsole } from './read-policy.js';
import { walkSurface, type Surface, type SurfaceIdentity } from './surface-summary.js';

/**
 * Read identity metadata (alias, address) from an agent's manifest for
 * inclusion in the surface summary header. Unreadable manifests → empty
 * identity; the walker still emits a useful summary keyed on folder alone.
 *
 * Lives here because the manifest read is part of "what goes into a summary
 * header" — single consumer is `writeSurfaceIfChanged` below. Exported so
 * the unit tests can exercise it directly.
 */
export function readIdentity(folder: string, issuer?: string): SurfaceIdentity {
  try {
    const raw = JSON.parse(fs.readFileSync(agentPath(folder, 'manifest.json'), 'utf-8')) as {
      name?: string;
      pubkey?: string;
    };
    return {
      alias: raw.name,
      address: raw.pubkey
        ? issuer
          ? `a:${raw.pubkey}@${issuer}`
          : `a:${raw.pubkey}`
        : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Walk every agent the console can see and write summary files under
 * `.<console>/view/`. Called once at console registration (ServerScopeConsole.
 * register) and safe to call repeatedly — summary bytes are deterministic modulo
 * the `rev:` header line, and we only write when the content hash differs.
 *
 * Returns the count of files written — useful for startup log lines.
 */
export function initializeViewDir(consoleName: ManagerConsole): { written: number; total: number } {
  const viewDir = viewDirForConsole(consoleName);
  fs.mkdirSync(viewDir, { recursive: true });

  const folders = listSubdirectories(AGENTS_DIR).filter((f) => !f.startsWith('.'));
  const surfaces = readableSurfaces(consoleName);
  let written = 0;
  let total = 0;

  for (const folder of folders) {
    for (const surface of surfaces) {
      total++;
      if (writeSurfaceIfChanged(consoleName, folder, surface, viewDir)) written++;
    }
  }
  return { written, total };
}

/**
 * Re-run `writeSurfaceIfChanged` for a single folder — used by the
 * blueprint-change watcher in `ServerScopeConsole` to keep summaries fresh
 * while per-agent Design is authoring. Write-if-changed semantics make this
 * safe to call under a debounce without thrashing disk.
 *
 * Deliberately separate from `maintainViewDir` to keep the add/remove
 * (agent-set lifecycle) and refresh (blueprint-edit) paths distinct.
 */
export function refreshViewDirFolder(consoleName: ManagerConsole, folder: string): void {
  try {
    const viewDir = viewDirForConsole(consoleName);
    fs.mkdirSync(viewDir, { recursive: true });
    const surfaces = readableSurfaces(consoleName);
    for (const surface of surfaces) {
      writeSurfaceIfChanged(consoleName, folder, surface, viewDir);
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), consoleName, folder },
      'view-dir refresh failed',
    );
  }
}

/**
 * Add/remove summary files on agent-registry lifecycle events. With a
 * single stable mount per console, we don't need to respawn containers on
 * agent-set changes — just keep the view dir in sync.
 *
 * Exceptions are logged, not thrown — maintenance runs in event handlers and
 * a crash here would block subsequent handlers.
 */
export function maintainViewDir(consoleName: ManagerConsole, change: AgentSetChange): void {
  try {
    const viewDir = viewDirForConsole(consoleName);
    fs.mkdirSync(viewDir, { recursive: true });

    if (change.kind === 'added') {
      const surfaces = readableSurfaces(consoleName);
      for (const surface of surfaces) {
        writeSurfaceIfChanged(consoleName, change.folder, surface, viewDir);
      }
    } else if (change.kind === 'removed') {
      const surfaces = readableSurfaces(consoleName);
      for (const surface of surfaces) {
        const target = path.join(viewDir, `${change.folder}.${surface}.md`);
        try {
          fs.unlinkSync(target);
        } catch {
          /* already gone — no-op */
        }
      }
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), consoleName, change },
      'view-dir maintenance failed',
    );
  }
}

export function writeSurfaceIfChanged(
  consoleName: ManagerConsole,
  folder: string,
  surface: Surface,
  viewDir: string,
): boolean {
  const identity = readIdentity(folder);
  const { content, hash } = walkSurface(folder, surface, consoleName, identity);
  const target = path.join(viewDir, `${folder}.${surface}.md`);

  let priorHash: string | undefined;
  try {
    const prior = fs.readFileSync(target, 'utf-8');
    // Strip the `rev:` line to match the canonicalization in
    // `walkSurface` — idempotency requires hashing over identical bytes,
    // and the timestamp rev line would otherwise differ every call.
    const priorCanonical = prior.replace(/^rev: .*$/m, '');
    priorHash = crypto.createHash('sha1').update(priorCanonical).digest('hex');
  } catch {
    /* no prior file */
  }
  if (priorHash === hash) return false;

  fs.writeFileSync(target, content);
  return true;
}
