/**
 * Volume mount table construction for agent containers.
 *
 * Two entry points:
 * - `mountTable(...)` — pure lookup; returns the mount records without touching disk.
 *   Consumed by both the spawn path (via `buildVolumeMounts`) and the host-side
 *   path resolver in `lib/agent-paths.ts` for translating container paths.
 * - `buildVolumeMounts(...)` — spawn-path entry; ensures every host directory
 *   exists, then returns `mountTable(...)`. Same public contract as before.
 *
 * Lives separately from `container-runner.ts` so the spawn loop stays focused
 * on lifecycle / IPC, and the mount layout (which is the most-edited part
 * when adding new layers) has its own home.
 */
import fs from 'fs';
import path from 'path';

import type { ResourceEntry } from '@getcast/agent-schema/v1';

import {
  agentPath,
  mcpDir,
  sessionCastSocketPath,
  sessionClaudePath,
} from '../config.js';
import { mcpTransport } from './mcp-transport.js';
import { conversationKeyToPath } from '../lib/utils.js';
import { logger } from '../logger.js';
import type { Host } from '../types.js';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
  /** Framework-managed mount (Claude session, MCP socket). Excluded from agent-watchable surface. */
  isSystem?: boolean;
}

/**
 * Resolve .claude/ dir — session-scoped when conversationKey provided,
 * agent-scoped fallback for callers without session context (e.g. scheduled tasks).
 */
function resolveClaudeDir(agentFolder: string, conversationKey?: string): string {
  if (conversationKey) return sessionClaudePath(agentFolder, conversationKey);
  return agentPath(agentFolder, 'sessions', '_agent', '.claude');
}

/**
 * Pure mount-record construction. No filesystem mutation — does not create
 * directories. Skips operator-resource entries whose host path does not
 * exist on disk (logging a warning), since those are configured externally
 * and a missing path is operator error rather than something we should mkdir.
 */
export function mountTable(
  agent: Host,
  conversationKey?: string,
  resources?: Record<string, ResourceEntry>,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];

  // Layer 1: blueprint/identity/ (read-only — system prompt, skills)
  mounts.push({
    hostPath: agentPath(agent.folder, 'blueprint', 'identity'),
    containerPath: '/identity',
    readonly: true,
  });

  // Layer 2: memory/ (read-write — agent's learned knowledge, memory)
  mounts.push({
    hostPath: agentPath(agent.folder, 'memory'),
    containerPath: '/memory',
    readonly: false,
  });

  // Layer 3: home/ (read-write — agent's working directory, CWD)
  mounts.push({
    hostPath: agentPath(agent.folder, 'home'),
    containerPath: '/home/agent',
    readonly: false,
  });

  // Layer 3b: blueprint/assets/ (read-only — static reference data)
  mounts.push({
    hostPath: agentPath(agent.folder, 'blueprint', 'assets'),
    containerPath: '/assets',
    readonly: true,
  });

  // Layer 3c: shared/ext/ (read-only — extension-published context)
  // Agent sees `/shared/<N>/…`; source path separates extension private
  // runtime from agent-visible published output.
  mounts.push({
    hostPath: agentPath(agent.folder, 'shared', 'ext'),
    containerPath: '/shared',
    readonly: true,
  });

  // Layer 4: sessions/{k}/.claude/ → per-session Claude settings
  mounts.push({
    hostPath: resolveClaudeDir(agent.folder, conversationKey),
    containerPath: '/home/node/.claude',
    readonly: false,
    isSystem: true,
  });

  // Layer 5: MCP connections.
  // Socket mode: mount each .sock file individually (Apple Container, Docker on Linux).
  // TCP mode: skip mounts — container connects via host.docker.internal.
  if (mcpTransport().mode === 'socket') {
    if (conversationKey) {
      const sockPath = sessionCastSocketPath(agent.folder, conversationKey);
      if (fs.existsSync(sockPath)) {
        mounts.push({
          hostPath: sockPath,
          containerPath: '/mcp/cast.sock',
          readonly: false,
          isSystem: true,
        });
      }
      const sockDir = mcpDir(agent.folder);
      if (fs.existsSync(sockDir)) {
        const agentSocks = fs.readdirSync(sockDir).filter(
          (f) => f.endsWith('.sock') && f !== 'cast.sock',
        );
        for (const sockFile of agentSocks) {
          const sockPath2 = path.join(sockDir, sockFile);
          if (fs.existsSync(sockPath2)) {
            mounts.push({
              hostPath: sockPath2,
              containerPath: `/mcp/${sockFile}`,
              readonly: false,
              isSystem: true,
            });
          }
        }
      }
    } else {
      const sockDir = mcpDir(agent.folder);
      if (fs.existsSync(sockDir)) {
        const sockFiles = fs.readdirSync(sockDir).filter((f) => f.endsWith('.sock'));
        for (const sockFile of sockFiles) {
          mounts.push({
            hostPath: path.join(sockDir, sockFile),
            containerPath: `/mcp/${sockFile}`,
            readonly: false,
            isSystem: true,
          });
        }
      }
    }
  }

  // Layer 6: persistent attachment store (read-only, content-addressed blobs)
  mounts.push({
    hostPath: agentPath(agent.folder, 'state', 'attachments'),
    containerPath: '/attachments',
    readonly: true,
  });

  // Layer 7: staging — per-conversation outbox + web-fetch results
  if (conversationKey) {
    const stagingDirPath = path.join(agentPath(agent.folder, 'staging'), conversationKeyToPath(conversationKey));
    mounts.push({
      hostPath: stagingDirPath,
      containerPath: '/staging',
      readonly: false,
    });
  }

  // Layer 8: operator-configured resources (config/agent.json)
  if (resources) {
    for (const [name, entry] of Object.entries(resources)) {
      const hostPath = typeof entry === 'string' ? entry : entry.path;
      const readonly = typeof entry === 'string' ? true : entry.access !== 'rw';
      if (!fs.existsSync(hostPath)) {
        logger.warn({ agent: agent.name, resource: name, hostPath }, 'Resource path does not exist, skipping mount');
        continue;
      }
      mounts.push({ hostPath, containerPath: `/resources/${name}`, readonly });
    }
  }

  return mounts;
}

/**
 * SIDE EFFECT: Creates every agent-side host directory referenced by `mountTable`.
 * Called from `buildVolumeMounts` before returning records to the spawn path so
 * `container run` finds existing directories to bind. Idempotent (`recursive: true`).
 *
 * Skipped: MCP socket files (created by the MCP server process) and operator-resource
 * paths (configured externally; warned and skipped if missing).
 */
function ensureAgentMountDirs(agent: Host, conversationKey?: string): void {
  fs.mkdirSync(agentPath(agent.folder, 'blueprint', 'identity'), { recursive: true });
  fs.mkdirSync(agentPath(agent.folder, 'memory'), { recursive: true });
  fs.mkdirSync(agentPath(agent.folder, 'home'), { recursive: true });
  fs.mkdirSync(agentPath(agent.folder, 'blueprint', 'assets'), { recursive: true });
  fs.mkdirSync(agentPath(agent.folder, 'shared', 'ext'), { recursive: true });
  fs.mkdirSync(resolveClaudeDir(agent.folder, conversationKey), { recursive: true });
  fs.mkdirSync(agentPath(agent.folder, 'state', 'attachments'), { recursive: true });
  if (conversationKey) {
    const stagingDirPath = path.join(agentPath(agent.folder, 'staging'), conversationKeyToPath(conversationKey));
    fs.mkdirSync(path.join(stagingDirPath, 'in'), { recursive: true });
    fs.mkdirSync(path.join(stagingDirPath, 'out'), { recursive: true });
  }
}

export function buildVolumeMounts(
  agent: Host,
  conversationKey?: string,
  resources?: Record<string, ResourceEntry>,
): VolumeMount[] {
  ensureAgentMountDirs(agent, conversationKey);
  return mountTable(agent, conversationKey, resources);
}
