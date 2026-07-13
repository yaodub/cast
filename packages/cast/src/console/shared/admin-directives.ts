/**
 * admin__navigate — shared across all consoles (Configure, Design, Config Manager, Design Manager).
 *
 * The bot moves the operator's attention to an admin-UI surface by emitting
 * a `ui_directive` Evt with a `show` directive. The wire payload uses
 * intent-words (`target`, `within`) — cast doesn't pick render; the admin
 * UI maps `target` to a route push, drawer tab, modal, or anchor scroll
 * as it sees fit. `ConsoleTransport.sendEvent` dispatches to SSE
 * subscribers; non-browser transports (CLI, Telegram) render a plain-text
 * fallback in their `sendEvent`.
 *
 * The MCP tool keeps the name `admin__navigate` because that's what the
 * operator asks for in chat ("navigate me to the access page"). The wire
 * format is the part that needed cleaning up.
 *
 * Not a state mutation — no changelog entry.
 *
 * Scope capped at target + within — no per-field directives.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { textResult } from '../../extensions/registry.js';
import type { ToolResult } from '../../extensions/registry.js';
import type { ConsoleMcpContext, ConsoleMcpDeps } from '../strategy.js';

export function registerAdminNavigateTool(
  server: McpServer,
  ctx: ConsoleMcpContext,
  deps: ConsoleMcpDeps,
): void {
  if (!deps.emitUiDirective) return;
  const emit = deps.emitUiDirective;

  server.tool(
    'admin__navigate',
    'Move the operator\'s attention to an admin-UI surface. The admin-page index in your system prompt is the catalogue of valid `target` values. `reason` narrates WHY. `operator_takeaways` (required when the destination is a different console than this one) is the departure map — what\'s decided, what\'s pending, which surfaces hold what. Not a mutation; no changelog entry.',
    {
      target: z.string().min(1).describe('Logical destination key from the admin-page index in your prompt. May be a page key (e.g. "/agents/foo/access", "/routes") or a server-scope console (e.g. "config-manager", "design-manager", "security-manager"). The admin UI decides how to render — route push, drawer-tab switch, etc.'),
      within: z.string().optional().describe('Optional sub-location within the target (e.g. a section anchor like "users"). Must match an entry listed for the target in the admin-page index.'),
      reason: z.string().min(1).describe('One short sentence on why you\'re sending the operator here. Rendered verbatim for transports without a browser.'),
      operator_takeaways: z
        .string()
        .optional()
        .describe(
          'Required when sending the operator to a different console (e.g. Design → Configure, DM → per-agent Design). ' +
          'The departure map the operator carries: what\'s built, what\'s pending, which surfaces hold what. ' +
          'Example: "content-writer agent created; you\'ll enter IMAP creds in Configure\'s email secrets; prompt tweaks go back here in Design." ' +
          'Omit only for same-console navigation (e.g. Configure → Configure sub-page).',
        ),
    },
    async (args): Promise<ToolResult> => {
      if (!ctx.participant) {
        return textResult('Cannot navigate — no participant address on this session.', true);
      }
      emit(ctx.agentId, ctx.participant, ctx.channelName, {
        type: 'show',
        target: args.target,
        ...(args.within ? { within: args.within } : {}),
        reason: args.reason,
      });
      const suffix = args.within ? `#${args.within}` : '';
      const lines = [`Sent the operator to \`${args.target}${suffix}\`. (${args.reason})`];
      if (args.operator_takeaways) {
        lines.push(`**What you're carrying with you:** ${args.operator_takeaways}`);
      }
      return textResult(lines.join('\n'));
    },
  );
}
