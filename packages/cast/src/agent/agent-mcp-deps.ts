/**
 * Build the McpServerDeps object that AgentManager passes to the MCP server.
 *
 * Lives here so the inline construction (with all its ACL/lifecycle wiring) doesn't
 * crowd the AgentManager constructor. The deps object captures references to the
 * caller's owned state — call this once during construction and stash the result.
 */
import { checkAcl, hasBit, listChannelMembers, listPlacedChannels, membershipBits } from '../auth/acl.js';
import { extractIdentity, isAgent, isMember, isReadTier } from '../auth/address.js';
import { canPushCrossConversation, channelAuthDenial } from '../auth/conversation-context.js';
import { loadChannelsConfig } from '../conversations/channel-config.js';
import type { Bus } from '../gateway/bus.js';
import { escapeXml } from '../lib/format.js';
import { logger } from '../logger.js';
import type { RouteResult } from '../types.js';
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
  ) => Promise<RouteResult>;
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
 * For user-agent actors the cross-conversation push gate runs through the
 * `canPushCrossConversation` chokepoint (caller membership, target user
 * membership, room posture — see `auth/conversation-context.ts`). A self-fire
 * (`schedule.txt` / self-task) carries the agent's own address as caller, which
 * the chokepoint classifies as system context and allows unconditionally — the
 * agent owns all its own conversations, including those with the operator
 * (`local`), who is deliberately a member of nothing. Operator-trust actors
 * (per-agent consoles) carry the admin handle, which resolves to identity
 * `local`; they are not user-agents, so the membership gate is skipped for them
 * (their authorization is god-mode by identity). The self-loop guard still
 * applies to both tiers — it's a runtime-correctness check, not a trust check.
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
    //
    // Cross-conversation push gate — one verdict owns caller standing, target
    // membership, and room posture (see auth/conversation-context.ts). A
    // self-fire (caller = the agent's own address) is system context and is
    // allowed; a peer or non-member caller is denied; a member caller may only
    // reach a USER who is a co-member of the room, when posture permits. This
    // replaces the former scattered caller-standing + target `i` checks and
    // closes the system-context masquerade — a peer's `a:` address no longer
    // slips through `!isUser` to inherit the agent's own org-wide reach.
    const verdict = canPushCrossConversation({
      caller: callerParticipant ?? null,
      target: participant,
      channel,
      ownAgentId: ctx.agentId,
      bus: ctx.bus,
      agentFolder: ctx.folder,
      channelConfig: loadChannelsConfig(ctx.folder)[channel],
    });
    if (!verdict.allowed) {
      return Promise.resolve({ ok: false as const, reason: verdict.reason });
    }
    // Existence is a typo-catch, not a trust gate — checked AFTER the verdict
    // so a denial above reveals nothing about the target roster.
    if (!ctx.agentDb.participantExists(participant)) {
      return Promise.resolve({ ok: false as const, reason: `Unknown participant: ${participant}` });
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
  // dispatch. The row anchors the `<cast:rejection>` echo: sender-side
  // rejection handling tries `outbound_requests` first and falls back
  // to `outbound_pushes`. Intra-agent failures (the local dispatch below
  // settling not-ok or rejecting) mark this row and echo directly.
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
  // At-most-once stays (no await — verbs return after queueing), but the
  // failure must be observable: a spawn-time error settles the deliver
  // resolver with {ok:false} (it does not reject), so both legs are handled.
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
  ).then((result) => {
    if (!result.ok) {
      handleLocalPushFailure(ctx, requestId, callerChannel, callerParticipant, callerQualifier, result.error);
    }
  }).catch((err: unknown) => {
    handleLocalPushFailure(
      ctx, requestId, callerChannel, callerParticipant, callerQualifier,
      err instanceof Error ? err.message : String(err),
    );
  });
  return Promise.resolve({ ok: true as const, requestId });
}

/**
 * Intra-agent push failure path. The cross-agent rail surfaces failures via a
 * bus `type:'rejection'` round-trip; local dispatch has no bus hop, so the
 * same `<cast:rejection request="…">` contract is produced directly: mark the
 * outbound row, then echo the tag into the caller's cell so the LLM that
 * received "queued for delivery" learns the delivery died.
 */
function handleLocalPushFailure(
  ctx: AgentMcpDepsContext,
  requestId: string,
  callerChannel: string | undefined,
  callerParticipant: string | undefined,
  callerQualifier: string | undefined,
  reason: string,
): void {
  logger.warn({ agentId: ctx.agentId, requestId, reason }, 'Intra-agent push delivery failed');
  ctx.agentDb.updateOutboundPushStatus(requestId, 'rejected');
  if (callerChannel === undefined || callerParticipant === undefined) {
    // Self-fire origin (scheduler/service) — no caller cell to echo into.
    logger.warn({ agentId: ctx.agentId, requestId }, 'Push failure has no caller cell; echo skipped');
    return;
  }
  const tag = `<cast:rejection from="${escapeXml(ctx.agentId)}" request="${escapeXml(requestId)}">${escapeXml(reason)}</cast:rejection>`;
  void ctx.route(
    ctx.agentId,
    ctx.agentId,
    tag,
    { channel: callerChannel, qualifier: callerQualifier, targetParticipant: callerParticipant },
  ).catch((err) => {
    // Echo is best-effort — a rejection is not a push, so this cannot recurse.
    logger.error({ err, agentId: ctx.agentId, requestId }, 'Push failure echo could not be delivered');
  });
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
      // bit (push), keyed on the originating user (`participant`), per the
      // user-keyed p/h model in acl.ts. NOT `q` (q/a pair) and NOT `i` (a
      // receiver-side check the receiver runs itself when bus.routeMessage
      // dispatches into its handleBusMessage — the receiver's `case 'push'`
      // branch, for an agent sender, gates on the originating user's `h`
      // and `i` on the target channel). See agent-bus-handler.ts for the
      // three-check.
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
    // Discovery deps — the scoping boundary for the two list tools. Both
    // mirror the push verdict's caller standing: the read tier (system context
    // ∥ operator surface — `isReadTier`) sees everything, a placed member sees
    // its own rooms, everyone else gets the verdict's uniform denial. The
    // configured acl `owner` is deliberately member-tier here: read ⊂ write —
    // enumeration is a silent oracle, push is noisy.
    listChannelsFor: (caller) => {
      const channelsConfig = loadChannelsConfig(ctx.folder);
      if (isReadTier(caller, ctx.agentId)) {
        // Every user channel (config keys are user-shaped by construction —
        // `__*` is unrepresentable). Standing is the tier, not a placement.
        return Object.entries(channelsConfig).map(([name, ch]) => ({
          name,
          bits: 'owner',
          ...(ch.use_sharding ? { sharded: true } : {}),
          postureOpen: ch.show_co_participants !== false,
        }));
      }
      if (caller == null) return [];
      return listPlacedChannels(ctx.bus, ctx.folder, caller).map(({ channel, bits }) => {
        const ch = channelsConfig[channel];
        return {
          name: channel,
          bits,
          ...(ch?.use_sharding ? { sharded: true } : {}),
          postureOpen: ch ? ch.show_co_participants !== false : true,
          // Placement naming a channel with no config dir — operator-authored
          // ACL intent, surfaced rather than silently dropped.
          ...(ch ? {} : { missingConfig: true }),
        };
      });
    },
    listRoomMembers: (caller, channel) => {
      const readTier = isReadTier(caller, ctx.agentId);
      if (channel == null) {
        // No channel in context (agent-level socket) and none named: the
        // read-tier registry view, exact timestamps — self-fires run on
        // member-less channels, so "omitted = current" would blind the
        // scheduler's notify flows. Conversation cells always carry a
        // channel, so the non-read-tier arm is defensive.
        if (!readTier) return { ok: false, reason: 'No channel in context.' };
        return {
          ok: true,
          scope: 'registry',
          members: ctx.agentDb.getAllParticipants().map((p) => ({
            identity: p.address,
            kind: isAgent(p.address) ? ('peer' as const) : ('user' as const),
            lastActive: p.last_active,
          })),
        };
      }
      if (!readTier) {
        const callerBits = caller == null ? '' : membershipBits(ctx.bus, ctx.folder, caller, channel);
        if (!isMember(callerBits)) {
          // Non-member and nonexistent channel take the SAME branch with the
          // verdict's wording — channel existence is not an oracle.
          return { ok: false, reason: channelAuthDenial(channel) };
        }
      }
      const placed = listChannelMembers(ctx.bus, ctx.folder, channel);
      const postureOff = loadChannelsConfig(ctx.folder)[channel]?.show_co_participants === false;
      // Posture is a member↔member visibility control: posture-off hides
      // co-members from member-tier callers (own rows + population-blind
      // note), never from the read tier — the agent hosting the room and the
      // machine-trusted operator are not co-participants.
      const visible = postureOff && !readTier
        ? placed.filter((m) => caller != null && m.identity === extractIdentity(caller))
        : placed;
      const recency = new Map(ctx.agentDb.getAllParticipants().map((p) => [p.address, p.last_active]));
      return {
        ok: true,
        scope: 'room',
        members: visible.map((m) => {
          const last = recency.get(m.identity);
          return {
            identity: m.identity,
            kind: isAgent(m.identity) ? ('peer' as const) : ('user' as const),
            // Day granularity in room scope — presence-oracle trim. Absent
            // for identities with no session yet (placed via ACL only) and
            // for peers (never registry rows).
            ...(last ? { lastActive: last.slice(0, 10) } : {}),
          };
        }),
        ...(postureOff
          ? {
              postureNote: readTier
                ? 'Note: co-participant visibility is disabled on this channel for member-tier callers.'
                : "Co-participant visibility is disabled on this channel; other members' rows are not shown.",
            }
          : {}),
      };
    },
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
