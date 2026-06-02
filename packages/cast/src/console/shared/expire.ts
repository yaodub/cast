/**
 * agent__expire_conversations — shared across all consoles.
 *
 * Tier-2 escape hatch: marks every active non-console conversation expired so
 * the next inbound message spawns a fresh runner with current prompt / channel
 * / capability state. Console sessions are never touched.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { textResult } from '../../extensions/registry.js';
import type { ConsoleMcpDeps } from '../strategy.js';

export function registerExpireTool(server: McpServer, deps: ConsoleMcpDeps): void {
  if (!deps.onExpireConversations) return;
  const onExpire = deps.onExpireConversations;

  server.tool(
    'agent__expire_conversations',
    "Expire all the agent's active user conversations so they refresh on the next message and pick up recent prompt / channel / capability changes. Console sessions are not affected.",
    {},
    async () => {
      const { expired } = onExpire();
      return textResult(`Expired ${expired} active conversation${expired === 1 ? '' : 's'}.`);
    },
  );
}
