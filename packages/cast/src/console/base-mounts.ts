/**
 * Mount contributions shared across every console — manuals, per-session
 * `.claude` dir, MCP socket. Each `ConsoleStrategy` adds its own on top via
 * `buildMountAdditions`.
 */
import fs from 'fs';

import { agentPath, sessionCastSocketPath, sessionClaudePath } from '../config.js';
import { mcpTransport } from '../container/mcp-transport.js';
import type { VolumeMount } from '../container/container-mounts.js';
import type { Host } from '../types.js';

import { resolveManualsDir } from './index.js';

export function buildBaseMounts(agent: Host, conversationKey: string): VolumeMount[] {
  const mounts: VolumeMount[] = [];

  const manualsDir = resolveManualsDir();
  if (manualsDir) {
    mounts.push({ hostPath: manualsDir, containerPath: '/ref/manuals', readonly: true });
  }

  const claudeDir = sessionClaudePath(agent.folder, conversationKey);
  fs.mkdirSync(claudeDir, { recursive: true });
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // MCP socket mount: add unconditionally in socket mode. The socket file
  // won't exist yet at mount-build time (it's created later by
  // startConsoleMcpServer in conversation-runner), but we await mcp.ready
  // before launching the container — so by the time Apple Container reads
  // the mount flags, the file is on disk. TCP mode skips this; the agent
  // container connects via host.docker.internal using CAST_MCP_PORTS.
  if (mcpTransport().mode === 'socket') {
    const sockPath = sessionCastSocketPath(agent.folder, conversationKey);
    mounts.push({ hostPath: sockPath, containerPath: '/mcp/cast.sock', readonly: false });
  }

  return mounts;
}

/**
 * Persistent home mount for server-scope consoles (DM, CM, SM).
 *
 * Host path: `mnt/agents/<dotfolder>/home/` — rw, survives container respawn,
 * server restart, and conversationKey rotation. Console-private; not mounted
 * cross-console. Per-agent consoles (Design, Configure) do not opt in — their
 * workspace is the target agent's blueprint.
 *
 * Container path `/home/agent/` mirrors the regular-agent convention
 * (`container/container-runner.ts:buildVolumeMounts`) so prompts can speak one
 * shape regardless of whether they're running in an agent or a console.
 */
export function buildConsoleHomeMount(agentFolder: string): VolumeMount {
  const homePath = agentPath(agentFolder, 'home');
  fs.mkdirSync(homePath, { recursive: true });
  return { hostPath: homePath, containerPath: '/home/agent', readonly: false };
}
