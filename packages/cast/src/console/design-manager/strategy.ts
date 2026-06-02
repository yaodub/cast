/**
 * Design Manager strategy — server-scope orchestrator.
 *
 * Structural sibling of Config Manager:
 *   - Channel `default` (not `__design-manager`) because DM is a standalone
 *     svc entity with no user traffic. Console-prefix rules don't apply.
 *   - `full` network: DM is an orchestrator — WebFetch of docs/references
 *     when proposing decompositions. CM and SM stay on `sdk-only` because
 *     they read local config/blueprint only.
 *   - Registered in `CONSOLE_REGISTRY` so `startConsoleMcpServer` can look
 *     up tool registration. DM is NOT dispatched by per-agent
 *     `ConsoleManager` — it owns its own `DesignManagerConsole` on its own
 *     Conversations scope (`serverscope:design`).
 *
 * DM-specific tool `design_manager__create_agents` registers here; shared
 * tools (conversation__push_to_channel, admin__navigate, redirect) register
 * via `registerConsoleTools` auto-dispatch. The push tool activates because
 * the server wires `onDelegate` into DM's deps at construction time.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { DEFAULT_IDLE_TIMEOUT_MS, type AgentChannel } from '../../conversations/types.js';
import type { ConsoleMcpContext, ConsoleMcpDeps, ConsoleStrategy } from '../strategy.js';

import { DESIGN_MANAGER_HEADER } from './prompt.js';
import { buildDesignManagerMountAdditions } from './mounts.js';
import { registerCreateAgentsTool } from './tools.js';

const DESIGN_MANAGER_CHANNEL: AgentChannel = {
  idle_timeout: DEFAULT_IDLE_TIMEOUT_MS,
  bootstrapEnabled: false,
  cleanupEnabled: false,
  log_messages: true,
  use_sharding: false,
  disabled_tools: [],
};

function registerDesignManagerTools(
  server: McpServer,
  ctx: ConsoleMcpContext,
  deps: ConsoleMcpDeps,
): void {
  registerCreateAgentsTool(server, ctx, deps);
}

export const designManagerStrategy: ConsoleStrategy = {
  name: 'design-manager',
  channelName: 'default',
  channel: DESIGN_MANAGER_CHANNEL,
  workdir: '/ref',
  containerNetwork: 'full',
  promptHeader: DESIGN_MANAGER_HEADER,
  buildMountAdditions: (agent) => buildDesignManagerMountAdditions(agent.folder),
  registerTools: registerDesignManagerTools,
  // Stream intermediates: DM narrates multi-step decompositions (batch-create
  // + N Design delegations) which otherwise silently run for a full minute.
  showSteps: true,
};
