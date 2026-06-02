/**
 * Configure-specific mount additions — config/ (rw), blueprint/ (ro),
 * state/ (ro), logs/ (ro). Layered on top of `buildBaseMounts` by
 * `ConsoleManager` via the strategy.
 *
 * `config/` is mounted as a whole directory (not per-file) because Apple
 * Container rejects single-file bind mounts. `agent.key` lives at
 * `secrets/agent.key` (outside `config/`) and is never mounted in any
 * console.
 *
 * Per-extension config + secrets live under `config/ext/<name>/` and are
 * reachable through the single `config/` mount. The dedicated `ext/`
 * layer (extension private runtime) is intentionally NOT mounted — it
 * would expose `shared/ext/service/agent-context.md` as an injection seam.
 */
import fs from 'fs';

import { agentPath } from '../../config.js';
import type { VolumeMount } from '../../container/container-mounts.js';
import type { Host } from '../../types.js';

export function buildConfigureMountAdditions(agent: Host, _conversationKey: string): VolumeMount[] {
  const mounts: VolumeMount[] = [];

  // Apple Container requires the bind-mount source to exist as a directory
  // at mount time. All four dirs are standard layers (INSTANCE_LAYERS +
  // EPHEMERAL_LAYERS in @getcast/agent-schema) but mkdir-recursive is a cheap
  // defence against hand-assembled agent folders missing one.
  const configDir = agentPath(agent.folder, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  mounts.push({ hostPath: configDir, containerPath: '/agent/config', readonly: false });

  const blueprintDir = agentPath(agent.folder, 'blueprint');
  fs.mkdirSync(blueprintDir, { recursive: true });
  mounts.push({ hostPath: blueprintDir, containerPath: '/agent/blueprint', readonly: true });

  const stateDir = agentPath(agent.folder, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  mounts.push({ hostPath: stateDir, containerPath: '/agent/state', readonly: true });

  const logsDir = agentPath(agent.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  mounts.push({ hostPath: logsDir, containerPath: '/agent/logs', readonly: true });

  // manifest.json is NOT mounted — single-file bind mounts fail on Apple
  // Container. Its fields reach the prompt via ConsoleContext → dynamic
  // snapshot.

  return mounts;
}
