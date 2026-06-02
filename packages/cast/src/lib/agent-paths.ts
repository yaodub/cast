/**
 * Host-side path resolution for agent file-watch tools.
 *
 * Translates container paths (e.g. `/memory/foo.jsonl`) to host paths
 * (e.g. `mnt/agents/<name>/memory/foo.jsonl`) using the same `mountTable`
 * the spawn path consumes — single source of truth for the container ↔ host
 * mapping. Enforces the mount-surface invariant (RO/RW) at the tool boundary
 * because host-side processes have full RW on every mounted disk path
 * regardless of the container's mount mode.
 *
 * Path-must-exist contract: chokidar can't watch non-existent paths
 * (chokidar issues #346, #639, #1201). Tools fail closed on ENOENT;
 * the agent creates the path first via `file__append_feed` (which creates
 * the feed file on first call) and retries.
 */
import fs from 'fs';
import path from 'path';

import type { ResourceEntry } from '@getcast/agent-schema/v1';

import { mountTable, type VolumeMount } from '../container/container-mounts.js';
import type { Host } from '../types.js';

export type ResolveResult =
  | { ok: true; hostPath: string; mode: 'ro' | 'rw' }
  | { ok: false; kind: 'invalid-path'; message: string }
  | { ok: false; kind: 'no-mount'; containerPath: string }
  | { ok: false; kind: 'enoent'; hostPath: string }
  | { ok: false; kind: 'symlink'; hostPath: string }
  | { ok: false; kind: 'traversal'; hostPath: string; mountRoot: string }
  | { ok: false; kind: 'wrong-mode'; required: 'rw'; actual: 'ro' };

// `system-mount` is intentionally absent from this union: the resolver factory
// strips system mounts (`/home/node/.claude`, `/mcp/*.sock`) from the lookup
// table upfront, so requests against those paths surface as `no-mount` —
// indistinguishable from any other unmatched container path. That's the right
// behavior; the agent doesn't need to know about framework-internal mounts.

export interface PathResolver {
  resolveReadable(containerPath: string): ResolveResult;
  resolveWritable(containerPath: string): ResolveResult;
}

/**
 * Validate the input shape of a container path. Adapted from
 * `console/shared/read-policy.ts:101-120`, but for absolute container paths
 * (must start with `/`) rather than agent-root-relative paths.
 */
function validateContainerPath(containerPath: string): { ok: true; normalized: string } | { ok: false; kind: 'invalid-path'; message: string } {
  if (typeof containerPath !== 'string' || containerPath.length === 0) {
    return { ok: false, kind: 'invalid-path', message: 'Container path must be a non-empty string' };
  }
  if (!containerPath.startsWith('/')) {
    return { ok: false, kind: 'invalid-path', message: `Container path must be absolute (start with '/'), got: ${containerPath}` };
  }
  // Reject literal `..` segments BEFORE normalization. `path.posix.normalize`
  // would fold `/memory/..` to `/`, hiding the traversal attempt — checking raw
  // input keeps the rejection explicit (caller learns "you tried to traverse"
  // rather than the misleading "no-mount").
  if (containerPath.split('/').includes('..')) {
    return { ok: false, kind: 'invalid-path', message: `Container path contains '..' traversal: ${containerPath}` };
  }
  const normalized = path.posix.normalize(containerPath);
  if (normalized === '/' || normalized === '.') {
    return { ok: false, kind: 'invalid-path', message: `Container path must reference a target inside a mount, got: ${containerPath}` };
  }
  return { ok: true, normalized };
}

/**
 * Find the longest-prefix-matching mount for a normalized container path.
 * Mounts are sorted by `containerPath.length` desc so nested mounts (e.g.
 * `/home/agent` under `/home`) match the more specific entry first.
 */
function findMount(mounts: VolumeMount[], normalized: string): VolumeMount | undefined {
  for (const m of mounts) {
    if (normalized === m.containerPath || normalized.startsWith(m.containerPath + '/')) {
      return m;
    }
  }
  return undefined;
}

export function createPathResolver(
  agent: Host,
  conversationKey?: string,
  resources?: Record<string, ResourceEntry>,
): PathResolver {
  const watchable = mountTable(agent, conversationKey, resources)
    .filter((m) => !m.isSystem)
    .sort((a, b) => b.containerPath.length - a.containerPath.length);

  function resolveReadable(containerPath: string): ResolveResult {
    const validated = validateContainerPath(containerPath);
    if (!validated.ok) return validated;

    const mount = findMount(watchable, validated.normalized);
    if (!mount) return { ok: false, kind: 'no-mount', containerPath };

    const tail = validated.normalized.slice(mount.containerPath.length);
    const hostPath = path.join(mount.hostPath, tail);

    const stat = fs.lstatSync(hostPath, { throwIfNoEntry: false });
    if (!stat) return { ok: false, kind: 'enoent', hostPath };
    if (stat.isSymbolicLink()) return { ok: false, kind: 'symlink', hostPath };

    // Both sides realpath'd — operator-configured /resources/<name> hostPaths
    // may themselves be symlinks; comparing to the un-realpath'd mount.hostPath
    // would falsely reject legitimate reads inside that resource.
    const resolvedTarget = fs.realpathSync(hostPath);
    const resolvedRoot = fs.realpathSync(mount.hostPath);
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
      return { ok: false, kind: 'traversal', hostPath: resolvedTarget, mountRoot: resolvedRoot };
    }

    return { ok: true, hostPath: resolvedTarget, mode: mount.readonly ? 'ro' : 'rw' };
  }

  function resolveWritable(containerPath: string): ResolveResult {
    const result = resolveReadable(containerPath);
    if (result.ok && result.mode === 'ro') {
      return { ok: false, kind: 'wrong-mode', required: 'rw', actual: 'ro' };
    }
    return result;
  }

  return { resolveReadable, resolveWritable };
}
