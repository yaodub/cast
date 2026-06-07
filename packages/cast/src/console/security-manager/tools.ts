/**
 * Security Manager MCP tool: `security__finalize_agent`.
 *
 * SM is the gate for `draft → ready`. The mechanical review path is:
 *   1. Operator clicks "Request review" in the agent banner (or Design calls
 *      `design__request_review`) — primed message lands in SM's `default`.
 *   2. SM reads the agent (resurvey + summaries), converses with the operator,
 *      surfaces posture concerns using the recognizer vocabulary.
 *   3. On explicit operator approval, SM calls `security__finalize_agent` —
 *      this tool flips `manifest.status` from draft to ready.
 *
 * The mechanical Settings → Lifecycle override (in the admin UI) bypasses SM
 * entirely. SM should not assume every flip went through this tool — when the
 * operator goes via the override, the audit row's `via` field reads
 * `manual_override`, not `sm_review`.
 *
 * One-way: this tool only finalizes (draft → ready). Reverting ready → draft
 * is not SM's concern — Design owns that direction via `design__revert_to_draft`
 * (or the operator can flip the bit themselves through Settings).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { textResult } from '../../extensions/registry.js';
import type { ToolResult } from '../../extensions/registry.js';
import { setLifecycle } from '../shared/lifecycle.js';
import { resolveAgentToFolder } from '../shared/manager-tools.js';
import type { ConsoleMcpContext } from '../strategy.js';

function handleFinalizeAgent(
  ctx: ConsoleMcpContext,
  alias: string,
  postureSummary: string,
): ToolResult {
  const resolved = resolveAgentToFolder(alias);
  if (!resolved.folder) {
    return textResult(resolved.error ?? `unknown agent: ${alias}`, true);
  }

  const result = setLifecycle(resolved.folder, 'ready', {
    actor: ctx.participant ?? 'security-manager',
    via: 'sm_review',
    requested_by: 'operator',
    posture_summary: postureSummary,
  });

  if ('error' in result) return textResult(result.error, true);
  if (result.noop) {
    return textResult(
      `Agent **${resolved.folder}** is already **ready** — no flip needed. If the operator wants you to re-review, treat it as a fresh audit; they retain the Settings override.`,
      true,
    );
  }

  return textResult(
    [
      `Agent **${resolved.folder}** is now **ready**. The draft banner is gone; transport users and peer agents can reach it.`,
      '',
      `**Posture summary (recorded in audit):**`,
      postureSummary,
    ].join('\n'),
  );
}

export function registerSecurityManagerMcpTools(
  server: McpServer,
  ctx: ConsoleMcpContext,
): void {
  server.tool(
    'security__finalize_agent',
    'Finalize a drafted agent — flip `manifest.status` from draft to ready. Only call this after the operator has explicitly approved shipping in the conversation. One-way: this tool does NOT revert ready agents to draft. Pass `posture_summary` describing what you reviewed and any caveats — it lands in the agent\'s audit log alongside `via: sm_review` and `requested_by: local`.',
    {
      alias: z
        .string()
        .describe(
          'Target agent: folder name, alias (`manifest.name`), or `a:<pubkey>@<issuer>` address. Same resolution rules as `manager__read` and friends.',
        ),
      posture_summary: z
        .string()
        .min(1)
        .describe(
          'Short prose summary of the review: what you read, what findings (if any) you surfaced, what caveats the operator accepted. Lands in `state/admin-changelog.jsonl` so the trail records what was reviewed, not just that it was reviewed. ' +
          'Example: "Read blueprint + config. One `new_outbound_path` from the slack ext — operator confirmed the channel is private. No PII surface change; ACL unchanged from prior ready state."',
        ),
    },
    async (args) => handleFinalizeAgent(ctx, args.alias, args.posture_summary),
  );
}
