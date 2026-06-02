/**
 * Config Manager mount table.
 *
 * Composition (each session open):
 *   1. Persistent home — `mnt/agents/.config-manager/home/` → `/home/agent/` rw.
 *      Cross-session memory for CM (standing preferences, notes, deferred
 *      follow-ups). Shared pattern with DM + SM via `buildConsoleHomeMount`.
 *   2. Summary view dir — `mnt/agents/.config-manager/view/` → `/ref/agents/`
 *      ro. Single stable mount regardless of agent count; replaces the
 *      per-agent fanout (`1 + 2N` mounts) that bumped against Apple
 *      Container's 22-mount VirtIO-FS ceiling around 10 agents. Contents:
 *      `<folder>.blueprint.md` + `<folder>.config.md` summary files,
 *      maintained by `initializeViewDir` + `maintainViewDir` in
 *      `console/shared/view-dir-maintenance.ts`.
 *
 * Explicitly NOT mounted:
 *   - secrets/ — private keypairs (cryptographic material; never to LLM context)
 *   - ext per-extension .env files — extension credentials
 *   - <CAST_CONFIG_DIR>/routes.json — inline transport tokens
 *   - state/ — conversation logs are PII-heavy and cross-agent read alongside
 *     mutation capability is a context-leakage footgun. State-browser endpoint
 *     recovers debuggability without LLM-in-the-loop.
 *   - service/ — agent service code is host-executable. Layer 1 of the
 *     console security policy keeps it unmounted in any console.
 *
 * View-dir stays fresh via `agent-registry.changed` event wiring in
 * `ServerScopeConsole.onAgentRegistryChange` — no container respawn required.
 */
import type { VolumeMount } from '../../container/container-mounts.js';

import { buildConsoleHomeMount } from '../base-mounts.js';
import { viewDirForConsole } from '../shared/manager-consoles.js';

export function buildConfigManagerMountAdditions(agentFolder: string): VolumeMount[] {
  return [
    buildConsoleHomeMount(agentFolder),
    {
      hostPath: viewDirForConsole('config-manager'),
      containerPath: '/ref/agents',
      readonly: true,
    },
  ];
}
