/**
 * Manager-console classification primitives.
 *
 *   - `MANAGER_CONSOLES` / `isManagerConsole` — predicate the rest of the
 *     console layer uses to short-circuit out of view-dir / manager-tool
 *     paths for non-manager consoles (Design, Configure).
 *   - `readableSurfaces` — derives a manager's `Surface[]` from `POLICIES`
 *     in `read-policy.ts`. Adding a third surface (beyond blueprint/config)
 *     requires only a `read-policy.ts` edit.
 *   - `viewDirForConsole` — single source of truth for `mnt/agents/.<console>/view/`.
 *     Used by view-dir maintenance to write summary files, and by per-console
 *     `mounts.ts` to bind-mount the dir into the container at `/ref/agents`.
 *
 * Single-consumer helpers (manifest reading, identifier resolution) live next
 * to their consumer in `view-dir-maintenance.ts` / `manager-tools.ts`.
 */
import path from 'path';

import { AGENTS_DIR } from '../../config.js';

import type { ConsoleName } from '../index.js';

import { POLICIES, type ManagerConsole } from './read-policy.js';
import type { Surface } from './surface-summary.js';

const MANAGER_CONSOLES: readonly ManagerConsole[] = [
  'design-manager',
  'config-manager',
  'security-manager',
];

export function isManagerConsole(name: ConsoleName): name is ManagerConsole {
  return (MANAGER_CONSOLES as readonly string[]).includes(name);
}

/**
 * Map `ManagerConsole` → the list of surfaces it can read. Derived from
 * `POLICIES` so adding a third surface later only requires updating
 * read-policy.ts.
 */
export function readableSurfaces(consoleName: ManagerConsole): Surface[] {
  const patterns = POLICIES[consoleName];
  const surfaces: Surface[] = [];
  if (patterns.some((p) => p.startsWith('blueprint/'))) surfaces.push('blueprint');
  if (patterns.some((p) => p.startsWith('config/'))) surfaces.push('config');
  return surfaces;
}

/** `.<console>/view/` directory on the host. Created on demand. */
export function viewDirForConsole(consoleName: ManagerConsole): string {
  return path.join(AGENTS_DIR, `.${consoleName}`, 'view');
}
