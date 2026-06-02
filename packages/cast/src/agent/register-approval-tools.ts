/**
 * approval__list tool registrar — extracted from mcp-server.ts.
 *
 * Registered when the agent has a per-agent DB wired (`agentDb`).
 * Lets the LLM see what's pending decision so it can prompt the human
 * or otherwise nudge the flow forward.
 */
import { z } from 'zod';

import { isToolDisabled } from '@getcast/agent-schema/v1';

import { textResult } from '../extensions/registry.js';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpAgentContext } from './mcp-server.js';

export function registerApprovalTools(server: McpServer, ctx: McpAgentContext): void {
  if (!ctx.agentDb) return;
  if (isToolDisabled('approval__list', ctx.disabledTools ?? [])) return;

  const db = ctx.agentDb;
  server.tool(
    'approval__list',
    'List pending tool call approvals awaiting human decision. Use to check if any approvals need attention.',
    {
      status: z.enum(['pending', 'all']).default('pending').describe('Filter by status: "pending" (default) or "all"'),
    },
    async (args) => {
      const rows = args.status === 'all'
        ? db.listPendingApprovals()  // status='all' currently maps to pending — full audit listing is intentionally deferred until a reader exists for it.
        : db.listPendingApprovals(ctx.participant ?? undefined);

      if (rows.length === 0) return textResult('No pending approvals.');

      const lines = rows.map((r) => {
        const expiry = r.expires_at ? ` (expires ${new Date(r.expires_at).toLocaleString()})` : '';
        return `[${r.id}] ${r.tool}: ${r.summary} — ${r.status}${expiry}`;
      });
      return textResult(lines.join('\n'));
    },
  );
}
