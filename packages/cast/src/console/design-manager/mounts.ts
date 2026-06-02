/**
 * Design Manager mount table.
 *
 * Composition (each session open):
 *   1. Persistent home — `mnt/agents/.design-manager/home/` → `/home/agent/` rw.
 *      Cross-session memory for DM (decompositions, notes, preferences).
 *      Shared pattern with CM + SM via `buildConsoleHomeMount`.
 *   2. Summary view dir — `mnt/agents/.design-manager/view/` → `/ref/agents/`
 *      ro. Single stable mount regardless of agent count; replaces the
 *      per-agent fanout that bumped against Apple Container's 22-mount
 *      VirtIO-FS ceiling. Contents: `<folder>.blueprint.md` summary files,
 *      maintained by `initializeViewDir` + `maintainViewDir` in
 *      `console/shared/view-dir-maintenance.ts`.
 *
 * NOT mounted (per the console security policy):
 *   - `config/` — Config Manager's domain
 *   - `state/` — conversation PII
 *   - `secrets/` — cryptographic material
 *   - `service/` — host-executable code
 *   - `config/ext/<name>/secrets.json` — extension credentials
 *   - `<CAST_CONFIG_DIR>/routes.json` — transport tokens
 *
 * View-dir stays fresh via `agent-registry.changed` event wiring in
 * `ServerScopeConsole.onAgentRegistryChange` — no container respawn required.
 */
import type { VolumeMount } from '../../container/container-mounts.js';

import { buildConsoleHomeMount } from '../base-mounts.js';
import { viewDirForConsole } from '../shared/manager-consoles.js';

export function buildDesignManagerMountAdditions(agentFolder: string): VolumeMount[] {
  return [
    buildConsoleHomeMount(agentFolder),
    {
      hostPath: viewDirForConsole('design-manager'),
      containerPath: '/ref/agents',
      readonly: true,
    },
  ];
}
