/**
 * Security Manager strategy — server-scope paranoid read-only auditor with
 * one privileged mutation: `security__finalize_agent`, the only path for the
 * `draft → ready` flip when the operator goes through the review flow.
 *
 *   - Channel `default` (not `__security-manager`) because SM is a standalone
 *     svc entity with no user traffic. Console-prefix rules don't apply.
 *   - `sdk-only` network: SM sees PII (blueprint prose, config ACL, access grants)
 *     and must not have an exfil path.
 *   - Audit surface is the mount tree (blueprint + config cross-agent RO);
 *     stock `Read`, `Glob`, and `Grep` do the work. Shared tools (including
 *     `admin__navigate`) register via the shared dispatcher.
 *   - `security__finalize_agent` is the one and only SM-owned mutation —
 *     registered here. Reverts (ready → draft) live with Design or the
 *     admin Settings override; SM never reverts.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { DEFAULT_IDLE_TIMEOUT_MS, type AgentChannel } from '../../conversations/types.js';
import type { ConsoleMcpContext, ConsoleMcpDeps, ConsoleStrategy } from '../strategy.js';

import { SECURITY_MANAGER_HEADER } from './prompt.js';
import { buildSecurityManagerMountAdditions } from './mounts.js';
import { registerSecurityManagerMcpTools } from './tools.js';

const SECURITY_MANAGER_CHANNEL: AgentChannel = {
  idle_timeout: DEFAULT_IDLE_TIMEOUT_MS,
  bootstrapEnabled: false,
  cleanupEnabled: false,
  log_messages: true,
  use_sharding: false,
  disabled_tools: [],
};

function registerSecurityManagerTools(
  server: McpServer,
  ctx: ConsoleMcpContext,
  _deps: ConsoleMcpDeps,
): void {
  registerSecurityManagerMcpTools(server, ctx);
}

export const securityManagerStrategy: ConsoleStrategy = {
  name: 'security-manager',
  channelName: 'default',
  channel: SECURITY_MANAGER_CHANNEL,
  workdir: '/ref',
  containerNetwork: 'sdk-only',
  promptHeader: SECURITY_MANAGER_HEADER,
  buildMountAdditions: (agent) => buildSecurityManagerMountAdditions(agent.folder),
  registerTools: registerSecurityManagerTools,
  // Explicit false: SM's deliverable is a single clean structured reply
  // (recognizer-tagged findings or `none`). Streaming intermediates would
  // muddy that output; DM/CM flip it on because they're action-oriented.
  showSteps: false,
};
