/**
 * Config Manager strategy — server-scope cross-agent auditor + intra-surface
 * mutation dispatcher.
 *
 * Channel is `default` (not `__config-manager`) because CM is a standalone
 * console with no user traffic to coexist with. The `__`-prefix convention
 * applies to per-agent infra channels (`__design`, `__configure`); it doesn't
 * extend to the console's own session channel.
 *
 * Network policy is `sdk-only`: CM sees PII in cross-agent reads and in
 * operator chat; internet access would be an exfiltration vector.
 *
 * Registered in `CONSOLE_REGISTRY` so `startConsoleMcpServer` can look it up
 * for tool registration (admin__navigate + shared delegate live in shared
 * console tools). CM is NOT dispatched by per-agent `ConsoleManager` — it
 * owns its own `ConfigManagerConsole` on its own Conversations scope
 * (`serverscope:configure`).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { DEFAULT_IDLE_TIMEOUT_MS, type AgentChannel } from '../../conversations/types.js';
import type { ConsoleMcpContext, ConsoleMcpDeps, ConsoleStrategy } from '../strategy.js';

import { CONFIG_MANAGER_HEADER } from './prompt.js';
import { buildConfigManagerMountAdditions } from './mounts.js';

const CONFIG_MANAGER_CHANNEL: AgentChannel = {
  idle_timeout: DEFAULT_IDLE_TIMEOUT_MS,
  bootstrapEnabled: false,
  cleanupEnabled: false,
  log_messages: true,
  use_sharding: false,
  disabled_tools: [],
};

function registerConfigManagerTools(
  _server: McpServer,
  _ctx: ConsoleMcpContext,
  _deps: ConsoleMcpDeps,
): void {
  // CM has no CM-specific MCP tools today. Shared tools — admin__navigate,
  // expire, push — are registered by the shared console-tools
  // dispatcher. `conversation__push_to_channel` activates only when
  // `deps.onDelegate` is provided (see config-manager-console.ts wiring in
  // src/index.ts).
  // Out-of-scope asks are refused verbally per the CM manual and prompt
  // header; no tool-backed redirect.
  //
  // Future: cross-agent read tools (routes__summary, idp__list_users)
  // register here.
}

export const configManagerStrategy: ConsoleStrategy = {
  name: 'config-manager',
  channelName: 'default',
  channel: CONFIG_MANAGER_CHANNEL,
  workdir: '/ref',
  containerNetwork: 'sdk-only',
  promptHeader: CONFIG_MANAGER_HEADER,
  buildMountAdditions: (agent) => buildConfigManagerMountAdditions(agent.folder),
  registerTools: registerConfigManagerTools,
  // Stream intermediates: CM delegates mutations cross-agent + often narrates
  // surveys. Silent multi-step turns were noted as a gap in the polish pass.
  showSteps: true,
};
