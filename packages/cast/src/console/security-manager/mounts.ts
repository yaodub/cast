/**
 * Security Manager mount table.
 *
 * Composition (each session open):
 *   1. Persistent home — `mnt/agents/.security-manager/home/` → `/home/agent/` rw.
 *      Cross-session memory for SM (standing review patterns, audit narrative
 *      notes, operator-acknowledged-but-deferred findings).
 *   2. Summary view dir — `mnt/agents/.security-manager/view/` → `/ref/agents/`
 *      ro. Single stable mount regardless of agent count; replaces the
 *      per-agent fanout (`1 + 2N` mounts) that bumped against Apple
 *      Container's 22-mount VirtIO-FS ceiling. Contents:
 *      `<folder>.blueprint.md` + `<folder>.config.md` summary files,
 *      maintained by `initializeViewDir` + `maintainViewDir` in
 *      `console/shared/view-dir-maintenance.ts`.
 *
 * NOT mounted (per the console security policy):
 *   - `state/` — conversation PII; fanout across all agents would be a leak.
 *   - `secrets/` — cryptographic material; values never enter LLM context.
 *   - `config/ext/<name>/secrets.json` — extension credentials.
 *   - `service/` at the sibling path — there is no sibling `service/` in the
 *     current layout; service code lives under `blueprint/service/` and is
 *     reachable via the blueprint summary. Read-only, no sandbox escape.
 *
 * SM's posture: blueprint + config summaries are enough for all eight finding
 * buckets (blueprint_injection_risk, new_outbound_path, pii_surface_change,
 * paired_user_granted, extension_activated, mcp_server_added,
 * service_code_staged, cross_surface_leak). When a summary stubs something,
 * fall back to `manager__read` for the full file.
 *
 * View-dir stays fresh via `agent-registry.changed` event wiring in
 * `ServerScopeConsole.onAgentRegistryChange` — no container respawn required.
 */
import type { VolumeMount } from '../../container/container-mounts.js';

import { buildConsoleHomeMount } from '../base-mounts.js';
import { viewDirForConsole } from '../shared/manager-consoles.js';

export function buildSecurityManagerMountAdditions(agentFolder: string): VolumeMount[] {
  return [
    buildConsoleHomeMount(agentFolder),
    {
      hostPath: viewDirForConsole('security-manager'),
      containerPath: '/ref/agents',
      readonly: true,
    },
  ];
}
