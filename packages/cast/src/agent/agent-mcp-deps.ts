/**
 * Build the McpServerDeps object that AgentManager passes to the MCP server.
 *
 * Lives here so the inline construction (with all its ACL/lifecycle wiring) doesn't
 * crowd the AgentManager constructor. The deps object captures references to the
 * caller's owned state — call this once during construction and stash the result.
 */
import { z } from 'zod';

import { aclVerdict, listChannelMembers, listPlacedChannels, membershipBits } from '../auth/acl.js';
import { extractIdentity, isAgent, isMember, isReadTier, isUser } from '../auth/address.js';
import { canPushCrossConversation, channelAuthDenial, resolveCallerContext } from '../auth/conversation-context.js';
import { userPushVerdict } from '../auth/user-push-store.js';
import { loadChannelsConfig } from '../conversations/channel-config.js';
import type { Bus } from '../gateway/bus.js';
import { escapeXml } from '../lib/format.js';
import { logger } from '../logger.js';
import type { RouteResult } from '../types.js';
import { generateId } from '../lib/utils.js';

import type { AgentDb } from './agent-db.js';
import { mintCorrelationCode } from './agent-bus-handler.js';
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
 * A held cross-agent push. On an askable `p`-containment edge the
 * would-be push is stashed in the owner approval's payload and re-emitted verbatim
 * (`emitPush`) once the SENDER's owner grants `p`. The push analogue of
 * `HeldOutboundRequest` (q/r) — the resume re-runs the push dispatch, not a request.
 * `channel`/`qualifier` address the TARGET; `participant` is the carried user;
 * `caller*` is the sender's own cell (where a decline notice lands).
 */
export const HeldPushSchema = z.object({
  target: z.string(),
  channel: z.string(),
  qualifier: z.string().optional(),
  text: z.string(),
  requestId: z.string(),
  participant: z.string(),
  callerChannel: z.string().optional(),
  callerQualifier: z.string().optional(),
});
export type HeldPush = z.infer<typeof HeldPushSchema>;

/**
 * Record + dispatch a cross-agent push — the shared emit tail used by the granted
 * path in `deliverToAgent` and by the owner-grant re-emit. Idempotent on
 * the caller's `requestId` (minted once at hold/emit time so the re-emit reuses it).
 */
export function emitPush(
  deps: { agentId: string; bus: Bus; agentDb: AgentDb },
  held: HeldPush,
): void {
  deps.agentDb.recordOutboundPush({
    requestId: held.requestId,
    targetAgent: held.target,
    targetChannel: held.channel,
    channel: held.callerChannel ?? '',
    participant: held.participant,
    qualifier: held.callerQualifier,
  });
  // Fire-and-forget — bus dispatch is a fast queue handoff. Log failures so silent
  // drops are visible in dogfood (mirrors the inline dispatch this replaced).
  void deps.bus.routeMessage(deps.agentId, held.target, {
    type: 'push' as const,
    text: held.text,
    requestId: held.requestId,
    returnToParticipant: held.participant,
    returnToChannel: held.callerChannel ?? '',
    returnToQualifier: held.callerQualifier,
    routing: { channel: held.channel, qualifier: held.qualifier },
  }).catch((err) => {
    logger.error(
      { err, source: deps.agentId, target: held.target, requestId: held.requestId },
      'emitPush dispatch failed',
    );
  });
}

/**
 * Hold an askable cross-agent push and raise an owner-directed acl-edge approval for
 * the `p`-containment edge `this-agent → target` — the push analogue of
 * the q/r `raiseOutboundContainmentApproval`. Routes to THIS agent's owner; on grant
 * `resolveAclEdge` re-emits the held push (and on always persists `p`). Dedups per
 * outbound edge so a retrying agent doesn't stack approvals. Returns the held
 * `DeliveryResult` the push tool renders back to the agent.
 */
function raisePushContainmentApproval(
  ctx: AgentMcpDepsContext,
  displayTarget: string,
  held: HeldPush,
): DeliveryResult {
  const approvals = ctx.getApprovals();
  if (approvals.pendingAclEdge(held.target, held.channel, ['p'])) {
    return {
      ok: false as const,
      held: true as const,
      reason: `A push to ${displayTarget} on "${held.channel}" is already awaiting your owner's approval. The push goes through once they grant it; no need to retry.`,
    };
  }
  const ref = mintCorrelationCode();
  approvals.createRequest({
    type: 'acl-edge',
    approver: 'owner',
    participant: held.target,
    channel: held.channel,
    summary: `This agent (ref ${ref}) wants to route a user into ${displayTarget} on "${held.channel}".`,
    details: held.text,
    payload: JSON.stringify({ bit: 'p', ref, held }),
  });
  return {
    ok: false as const,
    held: true as const,
    reason: `Push held (ref ${ref}). Your owner must approve routing a user into ${displayTarget} on "${held.channel}" before the first push goes through. You'll be notified on a later turn.`,
  };
}

/** TTL for a pending user↔user push approval: 1 day. After this the
 *  pushee can no longer act on it; the held push is dropped and the pusher gets a
 *  decline. Longer than the default approval expiry — a person, not a synchronous
 *  caller, is on the other end. */
const USER_PUSH_TTL_SECONDS = 86400;

/** The minimal context an intra-agent push delivery needs — the receiving agent's
 *  id, its db (outbound-push bookkeeping), and the self-route callback. A subset of
 *  `AgentMcpDepsContext` so the emit/decline helpers can also be driven from
 *  `agent-manager` (the user-push approval resume) without the full deps object. */
type LocalPushDeps = Pick<AgentMcpDepsContext, 'agentId' | 'agentDb' | 'route'>;

/**
 * A held intra-agent push. On an askable user↔user edge the would-be
 * push is stashed in the pushee-approval payload and replayed verbatim
 * (`emitLocalPush`) once the pushee consents. `participant` is the pushee;
 * `caller*` is the pusher's own cell (where the answer/decline lands). `requestId`
 * is minted once at hold time so the replay reuses it.
 */
export const HeldLocalPushSchema = z.object({
  channel: z.string(),
  text: z.string(),
  participant: z.string(),
  callerChannel: z.string().optional(),
  callerParticipant: z.string().optional(),
  qualifier: z.string().optional(),
  callerQualifier: z.string().optional(),
  requestId: z.string(),
});
export type HeldLocalPush = z.infer<typeof HeldLocalPushSchema>;

/**
 * Record + self-route an intra-agent push — the shared emit tail used by the
 * granted path in `dispatchLocalPush` and by the user-push approval resume.
 * Idempotent on `requestId`. Fire-and-forget; a delivery failure echoes a
 * `<cast:rejection>` back into the pusher's cell (the intra-agent analogue of the
 * cross-agent bus rejection round-trip).
 */
export function emitLocalPush(deps: LocalPushDeps, held: HeldLocalPush): void {
  deps.agentDb.recordOutboundPush({
    requestId: held.requestId,
    targetAgent: deps.agentId,
    targetChannel: held.channel,
    channel: held.callerChannel ?? '',
    participant: held.callerParticipant ?? '',
    qualifier: held.callerQualifier,
  });
  const attrs = pushTierAttrs({
    receiverAgent: deps.agentId,
    senderAgent: deps.agentId,
    callerParticipant: held.callerParticipant,
    callerChannel: held.callerChannel,
    targetChannel: held.channel,
  });
  void deps.route(
    deps.agentId, deps.agentId, held.text,
    { channel: held.channel, qualifier: held.qualifier, targetParticipant: held.participant },
    undefined, undefined, undefined, 'push', attrs,
  ).then((result) => {
    if (!result.ok) handleLocalPushFailure(deps, held, result.error);
  }).catch((err: unknown) => {
    handleLocalPushFailure(deps, held, err instanceof Error ? err.message : String(err));
  });
}

/** Echo a `<cast:rejection>` into the pusher's own cell. Shared by a live push that
 *  fails delivery (`handleLocalPushFailure`) and a held user-push the pushee
 *  declined or let lapse (`declineLocalPush`). */
function echoPushRejection(deps: LocalPushDeps, held: HeldLocalPush, reason: string): void {
  if (held.callerChannel === undefined || held.callerParticipant === undefined) {
    // Self-fire origin (scheduler/service) — no caller cell to echo into.
    logger.warn({ agentId: deps.agentId, requestId: held.requestId }, 'Push rejection has no caller cell; echo skipped');
    return;
  }
  const tag = `<cast:rejection from="${escapeXml(deps.agentId)}" request="${escapeXml(held.requestId)}">${escapeXml(reason)}</cast:rejection>`;
  void deps.route(
    deps.agentId, deps.agentId, tag,
    { channel: held.callerChannel, qualifier: held.callerQualifier, targetParticipant: held.callerParticipant },
  ).catch((err) => {
    // Echo is best-effort — a rejection is not a push, so this cannot recurse.
    logger.error({ err, agentId: deps.agentId, requestId: held.requestId }, 'Push rejection echo could not be delivered');
  });
}

/** Decline a held user↔user push (pushee rejected, or the 1-day TTL lapsed) — echo
 *  a rejection into the pusher's cell so its held turn resolves. No outbound-row
 *  update: a held push was never recorded (the row is minted only on emit). */
export function declineLocalPush(deps: LocalPushDeps, held: HeldLocalPush, reason: string): void {
  echoPushRejection(deps, held, reason);
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
      // Reactive user↔user consent: a non-member USER pusher reaching a
      // member USER pushee may REQUEST the pushee's in-band consent (the per-edge
      // user-push store). Owner-tier never reaches here; only the caller-standing
      // (non-member) denial is pushee-overridable — posture/structural denials stay
      // hard. granted (a prior allow-always) → deliver; askable → hold + raise to
      // the pushee; rejected (tombstone) → hard deny.
      if (isReactiveUserPushCandidate(ctx, channel, participant, callerParticipant)) {
        const held: HeldLocalPush = {
          channel, text, participant,
          callerChannel, callerParticipant, qualifier, callerQualifier,
          requestId: generateId('req'),
        };
        const uv = userPushVerdict(ctx.folder, channel, callerParticipant ?? '', participant);
        if (uv === 'granted') {
          emitLocalPush(ctx, held);
          return Promise.resolve({ ok: true as const, requestId: held.requestId });
        }
        if (uv === 'askable') {
          return Promise.resolve(raiseUserPushApproval(ctx, held));
        }
        return Promise.resolve({ ok: false as const, reason: `${participant} has declined pushes from you on "${channel}".` });
      }
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
  const held: HeldLocalPush = {
    channel, text, participant,
    callerChannel, callerParticipant, qualifier, callerQualifier,
    requestId: generateId('req'),
  };
  emitLocalPush(ctx, held);
  return Promise.resolve({ ok: true as const, requestId: held.requestId });
}

/**
 * Intra-agent push failure path. The cross-agent rail surfaces failures via a bus
 * `type:'rejection'` round-trip; local dispatch has no bus hop, so the same
 * `<cast:rejection request="…">` contract is produced directly: mark the outbound
 * row, then echo into the caller's cell so the LLM that received "queued for
 * delivery" learns the delivery died.
 */
function handleLocalPushFailure(deps: LocalPushDeps, held: HeldLocalPush, reason: string): void {
  logger.warn({ agentId: deps.agentId, requestId: held.requestId, reason }, 'Intra-agent push delivery failed');
  deps.agentDb.updateOutboundPushStatus(held.requestId, 'rejected');
  echoPushRejection(deps, held, reason);
}

/** Is this denied push a reactive user↔user candidate? Only a non-member
 *  USER pusher reaching a concrete-member USER pushee — the one denial the pushee's
 *  consent may override. Posture/structural denials (target-not-user, posture
 *  isolation) keep the hard deny; the operator's channel config is not pushee-
 *  overridable, and a non-member pushee has no conversation to push into. */
function isReactiveUserPushCandidate(
  ctx: AgentMcpDepsContext,
  channel: string,
  pushee: string,
  pusher: string | undefined,
): boolean {
  if (!pusher || !isUser(pusher) || !isUser(pushee)) return false;
  if (resolveCallerContext(pusher, channel, ctx.agentId, ctx.bus, ctx.folder).class !== 'non-member') return false;
  return membershipBits(ctx.bus, ctx.folder, pushee, channel).includes('i');
}

/**
 * Hold an askable user↔user push and raise a pushee-directed approval —
 * the participant analogue of the owner-directed acl-edge approval. The PUSHEE is
 * the controller (decides in-band, in their own conversation); on allow-always the
 * `(channel, pusher → pushee)` grant persists to the user-push store, on
 * allow-once the single push delivers, on reject it is declined back to the pusher.
 * Dedups per edge. Returns the held `DeliveryResult` the push tool renders back.
 */
function raiseUserPushApproval(ctx: AgentMcpDepsContext, held: HeldLocalPush): DeliveryResult {
  const pusher = held.callerParticipant ?? '';
  const pushee = held.participant;
  const approvals = ctx.getApprovals();
  if (approvals.pendingUserPush(held.channel, pusher, pushee)) {
    return {
      ok: false as const,
      held: true as const,
      reason: `Your push to ${pushee} on "${held.channel}" is already awaiting their approval. It goes through once they accept; no need to retry.`,
    };
  }
  approvals.createRequest({
    type: 'user-push',
    approver: 'participant',
    controller: pushee,
    participant: pusher,
    channel: held.channel,
    summary: `${pusher} wants to send a message into your conversation on "${held.channel}".`,
    details: held.text,
    payload: JSON.stringify({ channel: held.channel, pusher, pushee, held }),
    expiresIn: USER_PUSH_TTL_SECONDS,
  });
  return {
    ok: false as const,
    held: true as const,
    reason: `Push held — ${pushee} must approve it. They have 1 day to respond; if they don't, the push is dropped and you'll get a decline.`,
  };
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
      // User-agent cross-agent path. Containment is the sender's `p`-edge to the
      // TARGET AGENT, keyed on the agent axis like q/r — NOT the carried
      // user's `o`, which conflated "this user may drive X's outbound" with "X may
      // reach Y". Three-state: granted → push; askable → hold + raise to X's owner;
      // rejected → deny. The receiver runs its own ACCESS check (the carried user's
      // `io`) when `bus.routeMessage` dispatches into its `case 'push'` handler —
      // see agent-bus-handler.ts.
      if (!ctx.agentDb.participantExists(participant)) {
        return Promise.resolve({ ok: false as const, reason: `Unknown participant: ${participant}` });
      }
      // The would-be push, built once: emitted now (granted) or held in the owner-
      // approval payload and re-emitted on grant (askable). `requestId` is minted
      // here so a hold reuses the same id on re-emit; a receiver-side rejection
      // routes a `type: 'rejection'` back referencing it (sender's rejection handler
      // looks it up — `agent-bus-handler.ts` case 'rejection').
      const held: HeldPush = {
        target: targetAgent, channel, qualifier, text,
        requestId: generateId('req'), participant,
        callerChannel, callerQualifier,
      };
      const verdict = aclVerdict(ctx.bus, ctx.folder, targetAgent, channel, 'p');
      if (verdict === 'granted') {
        emitPush({ agentId: ctx.agentId, bus: ctx.bus, agentDb: ctx.agentDb }, held);
        return Promise.resolve({ ok: true as const, requestId: held.requestId });
      }
      if (verdict === 'askable') {
        return Promise.resolve(raisePushContainmentApproval(ctx, targetAgent, held));
      }
      // rejected (tombstone, or no acl / no `p`). Push containment is enforcement-
      // only — not a discoverable capability — so the decline carries no reach hint
      // (the agent learns its push reach by attempting).
      return Promise.resolve({
        ok: false as const,
        reason: `Not authorized to route users into ${targetAgent} on "${channel}". Your owner has not approved this push route.`,
      });
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
        // Phase 4 discovery: show a peer if it has any reachable (granted OR
        // askable) channel — not just granted ones (the old `channels.length > 0`
        // hid every ungranted sibling, so the agent could never discover a peer to
        // request reach to). A fully tombstoned peer is hard-denied everywhere, so
        // omit it and its rejected channels.
        .filter((s) => s.channels.some((ch) => ch.reach !== 'rejected'))
        .map((s) => ({
          canonical: s.canonical,
          alias: s.alias,
          description: s.description,
          channels: s.channels
            .filter((ch) => ch.reach !== 'rejected')
            .map((ch) => ({
              name: ch.name,
              bits: ch.bits,
              reach: ch.reach,
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
      const pendingCount = ctx.agentDb.approvals.listPendingApprovals(data.participant).length;
      logger.info(
        { agentFolder: ctx.folder, approvalId, tool: data.tool, pendingCount },
        'Approval requested',
      );
      return { id: approvalId, pendingCount };
    },
    getFileWatchService: ctx.getFileWatchService,
  };
}
