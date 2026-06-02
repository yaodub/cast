/**
 * conversation__push_to_channel — server-scope console variant (DM/CM/SM).
 *
 * Server-scope consoles are free-floating bus entities (`console:*`) with no
 * implicit container, so the addressing model is two-coordinate: every push
 * names both `target_agent` and `channel`. Per-agent consoles (`__design`,
 * `__configure`) register a different verb shape (the agent-side push with
 * optional `target_agent`) wired up in `console/tools.ts`.
 *
 * Push rules (all cross-agent — server-scope consoles never resolve a target
 * to their own `console:*` address):
 *
 *   user channel target              → allowed (standard push)
 *   infra channel target             → gated by the active OUTBOUND_ACLS
 *                                       table (selected by isolation mode).
 *                                       DM gains `__configure` reach +
 *                                       DM → CM in normal mode.
 *
 * All paths route through the bus via `deliverToAgent` with the resolved
 * target bus address.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { hasBit, lookupDescriptorAcl } from '../../auth/acl.js';
import { getConsoleOutboundAcls } from '../../auth/console-grants.js';
import { readServerConfig } from '../../config.js';
import { textResult } from '../../extensions/registry.js';
import type { ToolResult } from '../../extensions/registry.js';
import type { PushActor } from '../../agent/push-actor.js';
import { isConsoleChannel } from '../index.js';
import type { ConsoleMcpContext, ConsoleMcpDeps } from '../strategy.js';

export type PushDecision =
  | { allow: true; targetAgentId: string }
  | { allow: false; reason: string };

/**
 * Pure rules evaluator — no side effects. Exported for testability.
 *
 * `currentAgentId` and the value returned by `resolveAgentByLabel` are both
 * bus addresses. Comparing them is how "is this the same agent?" is decided.
 */
export function evaluatePush(args: {
  currentAgentId: string;
  currentChannelName: string;
  targetAgentLabel: string;
  targetChannel: string;
  resolveAgentByLabel: ((label: string) => string | undefined) | undefined;
}): PushDecision {
  if (!args.resolveAgentByLabel) {
    return { allow: false, reason: 'Cross-agent push is not configured.' };
  }
  const targetAgentId = args.resolveAgentByLabel(args.targetAgentLabel);
  if (!targetAgentId) {
    return { allow: false, reason: `Unknown agent: "${args.targetAgentLabel}"` };
  }

  // Two distinct "console-ness" checks:
  //   - `targetIsConsoleChannel` — the target CHANNEL is an infra channel
  //     (`__design` / `__configure`). Triggers OUTBOUND_ACLS gating.
  //   - `targetIsConsoleEntity` — the target ENTITY is a server-scope
  //     console (`console:*` bus address). Pushes to other consoles must
  //     be in OUTBOUND_ACLS, regardless of whether their channel name
  //     happens to be `default`.
  const targetIsConsoleChannel = isConsoleChannel(args.targetChannel);
  const targetIsConsoleEntity = targetAgentId.startsWith('console:');

  // Server-scope consoles (DM/CM/SM) are the only callers of this evaluator.
  // Their bus address is `console:*` and never resolves equal to a target
  // agent's address, so a same-agent branch would be dead code. Per-agent
  // consoles (`__design`, `__configure`) register the agent-side push verb
  // in `console/tools.ts` and run through `handlePushToChannel`'s guards.

  // Two gated cases share one check:
  //   - infra channel target on any agent (`__design` / `__configure`)
  //   - any channel on a console entity target (`console:*` — manager-to-
  //     manager push on the `default` channel, etc.)
  // Both must appear in the sender's OUTBOUND_ACLS table. The receiver-
  // side gate (`getConsoleInfraGrants` for agent infra channels;
  // `getManagerReceiverGrants` for manager-as-receiver) fires later in
  // `checkAcl` and is the second of the two-table match.
  // Agent-to-agent cross-infra push has no path — agents have no entry
  // in any OUTBOUND_ACLS table so the lookup misses.
  if (targetIsConsoleChannel || targetIsConsoleEntity) {
    const senderAcl = getConsoleOutboundAcls()[args.currentAgentId];
    if (senderAcl) {
      const bits = lookupDescriptorAcl(senderAcl, targetAgentId, args.targetChannel);
      if (hasBit(bits, 'p')) {
        return { allow: true, targetAgentId };
      }
    }
    return {
      allow: false,
      reason:
        `Console isolation is currently \`${readServerConfig().consoleIsolation}\`. ` +
        `Push to \`${args.targetChannel}\` on \`${args.targetAgentLabel}\` ` +
        `is not permitted from this sender — route this handoff via the operator. ` +
        `The mode is operator-set and live; this rejection names the current setting.`,
    };
  }
  return { allow: true, targetAgentId };
}

export function registerDelegateTool(
  server: McpServer,
  ctx: ConsoleMcpContext,
  deps: ConsoleMcpDeps,
): void {
  if (!deps.deliverToAgent) return;
  const deliverToAgent = deps.deliverToAgent;

  server.tool(
    'conversation__push_to_channel',
    'Push a turn into another agent\'s channel (or another console\'s channel). Allowed paths depend on the server\'s console-isolation mode; if a push is blocked, the rejection names the current mode and what to do instead. Configure → Design (same agent) is never permitted in any mode (exfil carrier).',
    {
      channel: z.string().describe('Target channel name on the peer agent'),
      text: z.string().describe('Message content for the target conversation'),
      target_agent: z.string().describe('Target agent label'),
      handoff_brief: z
        .string()
        .min(1)
        .describe(
          'Context the receiving session needs that isn\'t in `text`: what the operator already agreed to, their register, caveats already surfaced, decisions already made. ' +
          'Separate from the operator-visible `text` — this warms the receiver so it doesn\'t cold-restart the conversation. ' +
          'Example: "operator is plain-register; agreed to approve-before-send flow; DM committed to Slack-via-web-fetch with rotation caveat named."',
        ),
    },
    async (args): Promise<ToolResult> => {
      // Participant is stamped by the transport (ADMIN_RESOLVED =
      // `local/admin:local` for admin consoles). Identifiers are never
      // LLM-supplied — runtime stamps `ctx.participant` before this tool
      // is reachable. If missing, the session is misconfigured.
      if (!ctx.participant) {
        return textResult('Cannot push — no participant address on this session.', true);
      }
      const decision = evaluatePush({
        currentAgentId: ctx.agentId,
        currentChannelName: ctx.channelName,
        targetAgentLabel: args.target_agent,
        targetChannel: args.channel,
        resolveAgentByLabel: deps.resolveAgentByLabel,
      });
      if (!decision.allow) return textResult(decision.reason, true);

      // Fire-and-forget delivery — verbs return after queueing, not after
      // lifecycle. Sync errors (unknown participant, ACL denied) surface as
      // `{ ok: false }`; the target's reply flows back through normal SSE.
      const actor: PushActor = {
        kind: 'server-scope',
        address: ctx.agentId,
        channel: ctx.channelName,
      };
      const result = await deliverToAgent(actor, decision.targetAgentId, args.channel, args.text, ctx.participant);

      if (!result.ok) return textResult(`Push failed: ${result.reason}`, true);
      const lines = [
        `Pushed to ${args.channel} via ${args.target_agent}.`,
        `**Handoff context:** ${args.handoff_brief}`,
        "The recipient's reply will arrive on its own channel; it does not come back as this tool's return value.",
      ];
      return textResult(lines.join('\n'));
    },
  );
}
