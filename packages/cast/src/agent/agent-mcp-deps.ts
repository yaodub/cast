/**
 * Build the McpServerDeps object that AgentManager passes to the MCP server.
 *
 * Lives here so the inline construction (with all its ACL/lifecycle wiring) doesn't
 * crowd the AgentManager constructor. The deps object captures references to the
 * caller's owned state — call this once during construction and stash the result.
 */
import { checkAcl, gateInbound, hasBit } from '../auth/acl.js';
import { isUser } from '../auth/address.js';
import type { Bus } from '../gateway/bus.js';
import { logger } from '../logger.js';
import { generateId } from '../lib/utils.js';

import type { AgentDb } from './agent-db.js';
import type { DeliveryResult, McpServerDeps } from './mcp-server.js';
import type { ApprovalHandler } from './approval-handler.js';
import type { Routing, SiblingAgentInfo } from './agent-bus-payload.js';
import type { FileWatchService } from './file-watch-service.js';
import type { DeliverKind } from './conversation-runner.js';
import { pushTierAttrs } from './agent-route.js';
import type { LocalPushActor, PushActor } from './push-actor.js';

export interface AgentMcpDepsContext {
  agentId: string;
  folder: string;
  bus: Bus;
  agentDb: AgentDb;
  /**
   * Self-route into the agent's normal pipeline. Same signature as
   * AgentManager.route but as a callback so this module doesn't depend on
   * the class. `kind` and `attrs` ride through to `runner.deliver()` so
   * push-originated deliveries can wrap as `<cast:push fromParticipant="..." fromChannel="...">`.
   */
  route: (
    address: string,
    senderId: string,
    text: string,
    routing?: Routing,
    rawText?: string,
    declaredName?: string,
    attachments?: undefined,
    kind?: DeliverKind,
    attrs?: Record<string, string>,
  ) => Promise<unknown>;
  /** Returns the approval handler. Function form so we can defer to runtime — handler is initialized in init(). */
  getApprovals: () => ApprovalHandler;
  /** Sibling agent enumerator for cross-agent peer listings. */
  listSiblingAgents: (() => SiblingAgentInfo[]) | undefined;
  /** End a conversation by key (TTL cooldown). */
  requestConversationEnd: (
    conversationKey: string,
    cooldownMs?: number,
  ) => { accepted: boolean; cooldownSeconds: number; reason?: string };
  /** Per-agent file-watch service. Late-bound via getter — initialized after AgentManager.init(). */
  getFileWatchService: () => FileWatchService;
}

/**
 * Local intra-agent push dispatch. Shared between `deliverToChannel` (omitted
 * `target_agent`) and the self-target branch of `deliverToAgent` (caller
 * resolved their own label) — same routing semantics either way.
 *
 * Trust-tier gates: `participantExists` and `gateInbound` are user-trust
 * checks (validate that a paired user is a known peer with the inbound `i`
 * bit on the target channel). For operator-trust actors (per-agent consoles)
 * the participant is the admin handle, which resolves to identity `local` —
 * `checkAcl` already grants `ALL_BITS` for that identity (`acl.ts:124`), and
 * the admin handle is not auto-registered in the agent's `participants`
 * table by design (it's a session handle, not a paired peer). Both gates
 * therefore reject operator-trust callers incorrectly; skip them when the
 * actor isn't a user-agent. The self-loop guard still applies — it's a
 * runtime-correctness check, not a trust check.
 */
function dispatchLocalPush(
  actor: LocalPushActor,
  ctx: AgentMcpDepsContext,
  channel: string,
  text: string,
  participant: string,
  callerChannel: string | undefined,
  callerParticipant: string | undefined,
  qualifier: string | undefined,
  callerQualifier: string | undefined,
): Promise<DeliveryResult> {
  if (actor.kind === 'user-agent') {
    // Sync validation — surface immediate errors to the LLM. Async
    // lifecycle (runner spawn, target reply) flows back through SSE.

    // Caller-standing gate — the cross-channel injection guard. The
    // originating participant must itself be authorized on the TARGET channel.
    // `push_to_participant` can move both axes at once (different participant
    // AND different channel); without this a user with rights only on channel
    // X could have the agent inject into channel Y — where the caller has no
    // standing — by naming a target who does. Mirrors the cross-agent
    // three-check, which already requires the originating user's `i` on the
    // target channel; this makes the intra-agent path consistent.
    //
    // Checked BEFORE the target gate so a denial reveals nothing about the
    // target's existence or channel membership (the caller can already
    // enumerate participant addresses via agent__list_participants — don't
    // also hand them other channels' rosters through an error oracle).
    //
    // Scoped to `isUser` callers. A `schedule.txt` / self-task fire runs with
    // the agent's own address as caller; that is not a user, and `a:`
    // identities structurally cannot hold `i` (acl.ts agent-bit restriction),
    // so a literal `i` check would black-hole the legitimate scheduled-fire →
    // push_to_participant flow. The agent owns all its own channels.
    if (isUser(callerParticipant ?? '')) {
      const { bits: callerBits } = checkAcl(ctx.bus, ctx.folder, callerParticipant!, channel);
      if (!gateInbound(callerBits, 'message').allowed) {
        return Promise.resolve({ ok: false as const, reason: `You are not authorized on channel "${channel}".` });
      }
    }

    if (!ctx.agentDb.participantExists(participant)) {
      return Promise.resolve({ ok: false as const, reason: `Unknown participant: ${participant}` });
    }
    // Channel-level authorization: target participant must be allowed to
    // occupy the target channel. Paired users get `i` via `*: io` from
    // pairing; operators can revoke per-channel via acl.json.
    const { bits } = checkAcl(ctx.bus, ctx.folder, participant, channel);
    if (!gateInbound(bits, 'message').allowed) {
      return Promise.resolve({ ok: false as const, reason: `Participant ${participant} is not authorized on channel "${channel}"` });
    }
  }
  // Self-loop guard (both trust tiers): pushing into the caller's own
  // active cell would create a runtime loop (the runner triggering the
  // push is the same one that would receive it). When in conversation
  // (channel, participant), the agent should output directly instead.
  if (callerChannel !== undefined && callerParticipant !== undefined
      && callerChannel === channel && callerParticipant === participant) {
    return Promise.resolve({
      ok: false as const,
      reason: 'Cannot push to your own active conversation. Output the text directly as your response — it will be delivered to the participant automatically.',
    });
  }
  // Mint correlation ID and persist the outbound push row before
  // dispatch. The row anchors any future `<cast:rejection>` echo:
  // sender-side rejection handling tries `outbound_requests` first
  // and falls back to `outbound_pushes`. Intra-agent push has no
  // async drop path today; the row ages out via TTL, but persisting
  // it keeps the dispatch shape uniform across intra/cross-agent.
  const requestId = generateId('req');
  ctx.agentDb.recordOutboundPush({
    requestId,
    targetAgent: ctx.agentId,
    targetChannel: channel,
    channel: callerChannel ?? '',
    participant: callerParticipant ?? '',
    qualifier: callerQualifier,
  });
  // Fire-and-forget — route into our own pipeline on the target channel.
  // Tier attrs derived by the shared helper from raw origin inputs.
  const attrs = pushTierAttrs({
    receiverAgent: ctx.agentId,
    senderAgent: ctx.agentId,
    callerParticipant,
    callerChannel,
    targetChannel: channel,
  });
  // At-most-once: log dispatch failure so silent drops are visible in dogfood.
  void ctx.route(
    ctx.agentId,
    ctx.agentId,
    text,
    { channel, qualifier, targetParticipant: participant },
    undefined,
    undefined,
    undefined,
    'push',
    attrs,
  ).catch((err) => {
    logger.error({ err, agentId: ctx.agentId, channel, participant, requestId }, 'dispatchLocalPush failed');
  });
  return Promise.resolve({ ok: true as const, requestId });
}

export function buildAgentMcpDeps(
  base: McpServerDeps,
  ctx: AgentMcpDepsContext,
): McpServerDeps {
  return {
    ...base,
    deliverToChannel: (
      actor, channel, text, participant,
      callerChannel, callerParticipant, qualifier, callerQualifier,
    ) => dispatchLocalPush(actor, ctx, channel, text, participant, callerChannel, callerParticipant, qualifier, callerQualifier),
    deliverToAgent: (
      actor, targetAgent, channel, text, participant, qualifier,
      callerChannel, callerQualifier,
    ) => {
      // Self-target router: passing your own agent's address as `target_agent`
      // is equivalent to omitting it — both express an intra-agent push.
      // Route to local dispatch directly rather than the bus, which would
      // hit the infra ACL short-circuit (`acl.ts` SYSTEM_OWNED_CHANNELS)
      // and silently drop. Target participant is the caller's own participant
      // (intra-agent push keeps the conversation owner stable).
      if (targetAgent === ctx.agentId) {
        if (actor.kind === 'server-scope') {
          // Server-scope consoles never resolve to a local-dispatch shape —
          // their `currentAgentId` is `console:*` and any agent target is
          // strictly cross-agent. This branch is defensively unreachable
          // from the production flow (handlePushToChannel only registers
          // for LocalPushActor); reject explicitly if anyone wires it.
          return Promise.resolve({ ok: false as const, reason: 'Server-scope consoles cannot route through intra-agent dispatch.' });
        }
        return dispatchLocalPush(actor, ctx, channel, text, participant, callerChannel, participant, qualifier, callerQualifier);
      }
      // Per-agent consoles never push cross-agent directly — they route
      // such handoffs through the manager consoles (DM/CM) which hold the
      // OUTBOUND_ACLS grants. Reject synchronously rather than letting the
      // bus path silently drop on the receiver's ACL short-circuit.
      if (actor.kind === 'per-agent-console') {
        return Promise.resolve({
          ok: false as const,
          reason: 'Per-agent consoles cannot push directly to other agents. Route cross-agent handoffs through the Design Manager or Config Manager.',
        });
      }
      // User-agent cross-agent path. Source-side authorization is the `p`
      // bit (push) per the p/h pairing in acl.ts. NOT `q` (q/a pair) and
      // NOT `i` (a receiver-side check the receiver runs itself when
      // bus.routeMessage dispatches into its handleBusMessage — the
      // receiver's `case 'push'` branch gates on `h` for the sender and
      // `i` for the originating user on the target channel). See
      // agent-bus-handler.ts for the three-check.
      if (!ctx.agentDb.participantExists(participant)) {
        return Promise.resolve({ ok: false as const, reason: `Unknown participant: ${participant}` });
      }
      const { bits } = checkAcl(ctx.bus, ctx.folder, participant, channel);
      if (!hasBit(bits, 'p')) {
        return Promise.resolve({ ok: false as const, reason: `Participant "${participant}" not authorized to push to channel "${channel}"` });
      }
      // Mint correlation ID and persist the outbound push row before
      // dispatch. Receiver-side ACL deny will route a
      // `type: 'rejection'` back referencing this `requestId`; the
      // sender's rejection handler (`agent-bus-handler.ts` case
      // 'rejection') looks the ID up here.
      const requestId = generateId('req');
      ctx.agentDb.recordOutboundPush({
        requestId,
        targetAgent,
        targetChannel: channel,
        channel: callerChannel ?? '',
        participant,
        qualifier: callerQualifier,
      });
      // Fire-and-forget — bus dispatch is fast (queue handoff), no await.
      // At-most-once: log dispatch failure so silent drops are visible in dogfood.
      void ctx.bus.routeMessage(ctx.agentId, targetAgent, {
        type: 'push' as const,
        text,
        requestId,
        returnToParticipant: participant,
        returnToChannel: callerChannel ?? '',
        returnToQualifier: callerQualifier,
        routing: { channel, qualifier },
      }).catch((err) => {
        logger.error({ err, source: ctx.agentId, target: targetAgent, channel, participant, requestId }, 'deliverToAgent dispatch failed');
      });
      return Promise.resolve({ ok: true as const, requestId });
    },
    listParticipants: () => ctx.agentDb.getAllParticipants(),
    listPeerAgents: () => {
      const siblings = ctx.listSiblingAgents?.() ?? [];
      return siblings
        .filter((s) => s.channels.length > 0)
        .map((s) => ({
          canonical: s.canonical,
          alias: s.alias,
          description: s.description,
          channels: s.channels.map((ch) => ({
            name: ch.name,
            bits: ch.bits,
            ...(ch.sharded ? { sharded: true } : {}),
          })),
        }));
    },
    routeRejection: async (
      requestId,
      returnToAgent,
      returnToChannel,
      returnToParticipant,
      reason,
    ) => {
      ctx.bus.routeMessage(ctx.agentId, returnToAgent, {
        type: 'rejection' as const,
        requestId,
        reason,
        originChannel: returnToChannel,
        originParticipant: returnToParticipant,
      });
    },
    onEndConversation: (conversationKey, cooldownSeconds) => {
      const cooldownMs = cooldownSeconds ? cooldownSeconds * 1000 : undefined;
      return ctx.requestConversationEnd(conversationKey, cooldownMs);
    },
    requestApproval: (data) => {
      const approvalId = ctx.getApprovals().createRequest(data);
      const pendingCount = ctx.agentDb.listPendingApprovals(data.participant).length;
      logger.info(
        { agentFolder: ctx.folder, approvalId, tool: data.tool, pendingCount },
        'Approval requested',
      );
      return { id: approvalId, pendingCount };
    },
    getFileWatchService: ctx.getFileWatchService,
  };
}
