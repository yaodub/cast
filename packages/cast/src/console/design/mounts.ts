/**
 * Design-specific mount additions — blueprint (rw) and the read-only
 * blueprint snapshot at `/ref/snapshot/`. Layered on top of
 * `buildBaseMounts` by `ConsoleManager` via the strategy.
 *
 * Side effect: lazy-creates `blueprint/` and `blueprint/.design/` so the bind
 * mount has a directory target and the curated notes directory exists for
 * scratch work (shape described in the Design manual).
 */
import fs from 'fs';
import path from 'path';

import { agentPath } from '../../config.js';
import type { VolumeMount } from '../../container/container-mounts.js';
import type { Host } from '../../types.js';
import { snapshotPath } from '../snapshot.js';

export function buildDesignMountAdditions(agent: Host, conversationKey: string): VolumeMount[] {
  const mounts: VolumeMount[] = [];

  const blueprintDir = agentPath(agent.folder, 'blueprint');
  fs.mkdirSync(blueprintDir, { recursive: true });
  // Curated scratch space that travels with the blueprint. Shape/contents
  // are advisory (see the Design manual). Mounted implicitly as part of
  // blueprint/.
  fs.mkdirSync(path.join(blueprintDir, '.design'), { recursive: true });
  mounts.push({ hostPath: blueprintDir, containerPath: '/agent/blueprint', readonly: false });

  // manifest.json is NOT mounted. Apple Container's bind mounts require
  // directory sources — single-file binds fail with "path ... is not a
  // directory". The manifest's relevant fields (name, description, template,
  // status) are already injected into Claude's system prompt via
  // ConsoleContext → dynamic snapshot, so there's no need for filesystem
  // access. To modify the status field, Design uses `design__set_lifecycle`,
  // which writes server-side via writeAtomic.

  const snapDir = snapshotPath(agent.folder, conversationKey);
  if (fs.existsSync(snapDir)) {
    mounts.push({ hostPath: snapDir, containerPath: '/ref/snapshot', readonly: true });
  }

  return mounts;
}
