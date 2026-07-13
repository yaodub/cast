/**
 * BusHandler implementation for AgentManager.
 *
 * Owns: dispatch on inbound bus payload type (message, ingested, push,
 * request, response, rejection, approval_response)
 * and the per-type handlers — ACL gating, request bookkeeping, pairing
 * flow, approval routing. Lives in its own file so AgentManager stays
 * focused on owning state and the "what happens on each inbound message"
 * concept has one home.
 */
import { randomInt } from 'crypto';

import { z } from 'zod';

import { aclVerdict, checkAcl, gateInbound, membershipVerdict } from '../auth/acl.js';
import {
  extractIdentity,
  isAgent,
  isAuthoringSender,
  isUser,
} from '../auth/address.js';
import type { IdentityProvider } from '../auth/identity.js';
import type { Bus } from '../gateway/bus.js';
import { conversationPkt } from '../gateway/packets.js';
import { escapeXml, formatMessages, formatParticipantMessage } from '../lib/format.js';
import { logger } from '../logger.js';
import type { Attachment, RouteResult } from '../types.js';

import type { AgentDb } from './agent-db.js';
import {
  AgentBusPayloadSchema,
  type AgentBusPayload,
  type Routing,
} from './agent-bus-payload.js';
import type { ApprovalHandler } from './approval-handler.js';
import type { DeliverKind } from './conversation-runner.js';
import { handleOwnerClaim } from './owner-claim-handler.js';
import { pushTierAttrs } from './agent-route.js';

export interface BusHandlerDeps {
  agentId: string;
  folder: string;
  bus: Bus;
  agentDb: AgentDb;
  idp: IdentityProvider | undefined;
  /** Approval handler. Function form because it's initialized in init(), after BusHandler wiring. */
  getApprovals: () => ApprovalHandler;
  getTimezone: () => string;
  /** True when the agent's manifest has `status: 'draft'`. Read-through so the
   *  operator's draft↔ready toggle takes effect on the next inbound message. */
  isDraft: () => boolean;
  route: (
    address: string,
    senderId: string,
    text: string,
    routing?: Routing,
    rawText?: string,
    declaredName?: string,
    attachments?: Attachment[],
    kind?: DeliverKind,
    attrs?: Record<string, string>,
  ) => Promise<RouteResult>;
}

export async function handleBusMessage(
  deps: BusHandlerDeps,
  from: string,
  to: string,
  payload: unknown,
): Promise<void> {
  const parsed: AgentBusPayload = AgentBusPayloadSchema.parse(payload);

  // Draft-mode auto-reply. The agent owns its own readiness check — the
  // gateway stays generic about per-agent status. Senders outside the
  // operator's authoring envelope get a friendly bounce so they aren't left
  // wondering at silence; the operator (cli/admin) and the authoring
  // consoles (Design/Config/Security Managers) bypass so the agent can
  // still be exercised and composed while drafting. Reply types
  // (response/rejection/approval_response) and pairing pass through: we
  // don't want to break our own outbound flows or block a code the
  // operator already handed out.
  if (deps.isDraft() && !isAuthoringSender(from)) {
    if (bounceForDraft(deps, from, parsed)) return;
  }

  // route() is synchronous — all work (deliver to runner, kick off spawn) completes
  // before returning. The returned resultPromise blocks until the container exits,
  // which is only useful for onDelegate (MCP tool). handleMessage never needs it,
  // and awaiting it deadlocks the caller's outputChain on cross-agent flows.

  switch (parsed.type) {
    case 'message': {
      const channel = parsed.routing?.channel ?? 'default';
      const { bits, rejectMessage } = checkAcl(deps.bus, deps.folder, from, channel);
      const { allowed, verb } = gateInbound(bits, 'message');
      if (!allowed) {
        if (isAgent(extractIdentity(from))) {
          logger.info(
            { agentFolder: deps.folder, from, channel, requiredBit: verb },
            'Inbound agent message blocked (missing required bit)',
          );
        } else {
          handleUnauthorizedInboundMessage(deps, from, channel, verb, rejectMessage, {
            msgType: 'message', from, to, text: parsed.text, channel, routing: parsed.routing,
          });
        }
        return;
      }
      deliverInboundMessage(deps, from, to, 'message', parsed.text, parsed.routing);
      return;
    }

    case 'ingested': {
      const channel = parsed.routing?.channel ?? 'default';
      const { bits, rejectMessage } = checkAcl(deps.bus, deps.folder, from, channel);
      const { allowed, verb } = gateInbound(bits, 'message');
      if (!allowed) {
        if (isAgent(extractIdentity(from))) {
          logger.info(
            { agentFolder: deps.folder, from, channel, requiredBit: verb },
            'Inbound agent ingested message blocked (missing required bit)',
          );
        } else {
          handleUnauthorizedInboundMessage(deps, from, channel, verb, rejectMessage, {
            msgType: 'ingested', from, to, text: parsed.text, channel,
            declaredName: parsed.declaredName, routing: parsed.routing, attachments: parsed.attachments,
          });
        }
        return;
      }
      deliverInboundMessage(deps, from, to, 'ingested', parsed.text, parsed.routing, parsed.declaredName, parsed.attachments);
      return;
    }

    case 'push': {
      const channel = parsed.routing?.channel ?? 'default';
      // The push principal: a console/user sender is itself the principal and holds
      // its own grant; an agent sender is a pure conduit (the agent-bit restriction
      // reserves i/o for user/console identities), so access binds to the carried
      // user it hands over (`returnToParticipant`), never the relay. Hosting the
      // handed-over user is an `i`-bit delivery.
      const senderIsAgent = isAgent(extractIdentity(from));
      const carriedUser = parsed.returnToParticipant;
      const held: HeldPushDelivery = {
        carry: 'push',
        to,
        from,
        text: parsed.text,
        channel,
        requestId: parsed.requestId,
        returnToParticipant: carriedUser,
        returnToChannel: parsed.returnToChannel,
        returnToQualifier: parsed.returnToQualifier,
        routing: parsed.routing,
      };

      if (senderIsAgent) {
        // Agent-conduit ACCESS, three-state on the carried user's
        // CONCRETE `i` (`membershipVerdict` — never god-mode `checkAcl`, so a
        // compromised conduit cannot ferry an unplaced operator/owner into a room).
        // granted → host; askable → hold + raise an `io` approval to THIS agent's
        // owner; rejected (tombstone / no acl.json) → decline to the sender. The
        // grant is `io` and obeys the io-invariant in `resolveAclEdge` (approve
        // persists — a pushed-in user who replies needs the agent to hold `o`).
        const verdict = membershipVerdict(deps.bus, deps.folder, carriedUser, channel, 'i');
        if (verdict === 'rejected') {
          logger.warn(
            { agentFolder: deps.folder, from, returnToParticipant: carriedUser, channel },
            'Inbound push denied — carried user access rejected',
          );
          deps.agentDb.logEvent(
            'warn', 'conversation', 'push_denied_origin_user',
            `Push from ${from} rejected: ${carriedUser} is not authorized on channel "${channel}"`,
            { context: { from, returnToParticipant: carriedUser, channel } },
          );
          routePushRejection(
            deps, from, channel, parsed.requestId, parsed.returnToChannel,
            carriedUser, parsed.returnToQualifier,
            `Push from ${from} rejected: ${carriedUser} is not authorized on channel "${channel}"`,
          );
          return;
        }
        if (verdict === 'askable') {
          // Mirror the q/r inbound askable path: one owner decision per edge. A
          // duplicate push while a decision is in flight is dropped (bounce-capped
          // notice); the first held push replays on grant.
          const pendingId = deps.getApprovals().pendingAclEdge(carriedUser, channel, ['io']);
          if (pendingId) {
            if (recordBounce(`aclpush:${pendingId}`) === 1) {
              routePushRejection(
                deps, from, channel, parsed.requestId, parsed.returnToChannel,
                carriedUser, parsed.returnToQualifier, ALREADY_PENDING_NOTICE,
              );
            }
            return;
          }
          const ref = mintCorrelationCode();
          raiseAclEdgePushApproval(deps, carriedUser, channel, held, ref);
          // Held-notice back to the conduit over the rejection rail (v1 reuse, same
          // as q/r) so it learns the push is pending the destination owner, not
          // lost. The push replays as a fresh delivery on grant.
          routePushRejection(
            deps, from, channel, parsed.requestId, parsed.returnToChannel,
            carriedUser, parsed.returnToQualifier, pendingNotice(ref),
          );
          return;
        }
        // granted — concrete member, fall through to deliver.
      } else {
        // Console/user sender is the push principal itself — binary, as before:
        // BOTH the sender's own `i` (host authorization) AND the carried user's `i`
        // must hold. The carried-user read stays god-mode-inclusive `checkAcl` (the
        // sender is operator-trust or a direct principal, not a relaying conduit —
        // the concrete-membership floor only guards the agent-conduit ferry).
        const { bits } = checkAcl(deps.bus, deps.folder, from, channel);
        const senderGate = gateInbound(bits, 'message');
        if (!senderGate.allowed) {
          routePushRejection(
            deps, from, channel, parsed.requestId, parsed.returnToChannel,
            carriedUser, parsed.returnToQualifier,
            `Push from ${from} rejected: ${from} lacks required bit '${senderGate.verb}' on channel "${channel}"`,
          );
          return;
        }
        const { bits: userBits } = checkAcl(deps.bus, deps.folder, carriedUser, channel);
        if (!gateInbound(userBits, 'message').allowed) {
          routePushRejection(
            deps, from, channel, parsed.requestId, parsed.returnToChannel,
            carriedUser, parsed.returnToQualifier,
            `Push from ${from} rejected: originating user ${carriedUser} lacks 'i' on channel "${channel}"`,
          );
          return;
        }
      }
      deliverHeldPush(deps, held);
      return;
    }

    case 'request': {
      handleInboundRequest(deps, from, to, parsed);
      return;
    }

    case 'response': {
      // The open outbound row IS the round-trip authorization the query was
      // emitted under (standing grant, allow-once, or allow-always all land
      // here). The answer redeems that capability — no re-check of the standing
      // edge bit, which is what blackholed allow-once answers. A fire-and-forget
      // `request` authorized no answer into the sender's session (the r-bit anti-
      // injection promise), so a stray answer for one is dropped, row left open.
      const req = deps.agentDb.getOutboundRequest(parsed.requestId);
      if (!req || req.status !== 'open' || req.kind !== 'query') return;
      deps.agentDb.updateRequestStatus('outbound', parsed.requestId, 'fulfilled');
      const respTag = requestReplyTag('answer', from, parsed.requestId, parsed.text);
      routeRequestReply(
        deps,
        to,
        from,
        parsed.requestId,
        respTag,
        parsed.originChannel,
        parsed.originParticipant,
        parsed.originQualifier,
      );
      return;
    }

    case 'rejection': {
      // Dispatch on which table owns the requestId — queries live in
      // `outbound_requests`, pushes in `outbound_pushes`. The two share the
      // `<cast:rejection>` delivery tag but differ in receiver-side bookkeeping.
      // A rejection (bounce) is delivered for either request kind: both a query
      // and a fire-and-forget request want to learn their call did not land. The
      // open row authorizes the bounce — no standing-edge re-check.
      const req = deps.agentDb.getOutboundRequest(parsed.requestId);
      if (req && req.status === 'open') {
        deps.agentDb.updateRequestStatus('outbound', parsed.requestId, 'rejected');
        const rejTag = requestReplyTag('rejection', from, parsed.requestId, parsed.reason);
        routeRequestReply(
          deps,
          to,
          from,
          parsed.requestId,
          rejTag,
          parsed.originChannel,
          parsed.originParticipant,
          parsed.originQualifier,
        );
        return;
      }
      const push = deps.agentDb.getOutboundPush(parsed.requestId);
      if (push && push.status === 'open') {
        deps.agentDb.updateOutboundPushStatus(parsed.requestId, 'rejected');
        const rejTag = requestReplyTag('rejection', from, parsed.requestId, parsed.reason);
        routeRequestReply(
          deps,
          to,
          from,
          parsed.requestId,
          rejTag,
          parsed.originChannel,
          parsed.originParticipant,
          parsed.originQualifier,
        );
        return;
      }
      return;
    }

    case 'pending': {
      // Non-terminal status notice for a held q/r request — the askable edge's
      // owner hasn't decided yet. Crucially, do NOT transition the outbound
      // request: it stays `open` so the eventual owner-approved `<cast:answer>`
      // (which returns on this same `requestId` rail) still lands on a live row.
      // Conflating this with the terminal `rejection` packet was the
      // q/a-answer-orphaned bug. Delivered for either request kind: it is
      // framework-authored status, not peer data, so the r-bit reply restriction
      // does not apply.
      const req = deps.agentDb.getOutboundRequest(parsed.requestId);
      if (!req || req.status !== 'open') return;
      const pendTag = requestReplyTag('pending', from, parsed.requestId, parsed.reason);
      routeRequestReply(
        deps,
        to,
        from,
        parsed.requestId,
        pendTag,
        parsed.originChannel,
        parsed.originParticipant,
        parsed.originQualifier,
      );
      return;
    }

    case 'approval_response': {
      deps.getApprovals().handleResponse(from, parsed);
      return;
    }

    case 'owner-claim': {
      // Host-side terminal — validate the bearer code against the owner_claims
      // store and bind the owner. Never spawns the runner (the `/claim` secret
      // is already off the LLM path, intercepted at the gateway).
      handleOwnerClaim(
        { agentId: deps.agentId, folder: deps.folder, bus: deps.bus, agentDb: deps.agentDb },
        from, parsed,
      );
      return;
    }
  }
}

/**
 * Per-type bounce for inbound traffic on a draft agent. Returns `true` when
 * the payload was bounced (caller should stop dispatch); `false` when the
 * payload type passes through to the normal handlers (replies, pairing).
 *
 * Single home for the bounce-packet shape — adding a new bouncable type
 * means one switch arm, not three nearly-duplicate `if` blocks.
 */
const DRAFT_BOUNCE_REASON = 'Target agent is in draft mode — not yet ready to respond.';

function bounceForDraft(deps: BusHandlerDeps, from: string, parsed: AgentBusPayload): boolean {
  switch (parsed.type) {
    case 'message':
    case 'ingested':
      deps.bus.routeMessage(deps.agentId, from, {
        pkt: conversationPkt(deps.agentId, from, DRAFT_BOUNCE_REASON),
      });
      return true;
    case 'push':
      deps.bus.routeMessage(deps.agentId, from, {
        type: 'rejection' as const,
        requestId: parsed.requestId,
        reason: DRAFT_BOUNCE_REASON,
        originChannel: parsed.returnToChannel,
        originParticipant: parsed.returnToParticipant,
        originQualifier: parsed.returnToQualifier,
      });
      return true;
    case 'request':
      deps.bus.routeMessage(deps.agentId, parsed.returnToAgent, {
        type: 'rejection' as const,
        requestId: parsed.requestId,
        reason: DRAFT_BOUNCE_REASON,
        originChannel: parsed.returnToChannel,
        originParticipant: parsed.returnToParticipant,
      });
      return true;
    default:
      return false;
  }
}

/** Route a `<cast:rejection>` back to the push sender carrying the requestId. */
function routePushRejection(
  deps: BusHandlerDeps,
  from: string,
  channel: string,
  requestId: string,
  returnToChannel: string,
  returnToParticipant: string,
  returnToQualifier: string | undefined,
  reason: string,
): void {
  logger.info(
    { agentFolder: deps.folder, from, channel, requestId },
    'Inbound push rejected — routing rejection back to sender',
  );
  deps.bus.routeMessage(deps.agentId, from, {
    type: 'rejection' as const,
    requestId,
    reason,
    originChannel: returnToChannel,
    originParticipant: returnToParticipant,
    originQualifier: returnToQualifier,
  });
}

/**
 * Build a request-rail reply tag — the `<cast:answer>` / `<cast:rejection>` /
 * `<cast:pending>` family that returns to a requester on the `requestId` rail.
 * All three share one wire shape (sender attribution via `from`, correlation
 * via `request`); only the verb and the request lifecycle differ, so the
 * construction lives in one place. The body is framework- or operator-authored,
 * never peer-LLM text — these tags are minted host-side, never parsed from
 * agent output.
 */
function requestReplyTag(
  kind: 'answer' | 'rejection' | 'pending',
  from: string,
  requestId: string,
  body: string,
): string {
  return `<cast:${kind} from="${escapeXml(from)}" request="${escapeXml(requestId)}">${escapeXml(body)}</cast:${kind}>`;
}

/** Format and route a request reply (answer, rejection, or pending) to the original conversation. */
function routeRequestReply(
  deps: BusHandlerDeps,
  to: string,
  sender: string,
  requestId: string,
  content: string,
  originChannel: string,
  originParticipant: string,
  originQualifier: string | undefined,
): void {
  const formatted = formatMessages(
    [
      {
        id: requestId,
        address: to,
        sender,
        sender_name: sender,
        content,
        timestamp: new Date().toISOString(),
      },
    ],
    deps.getTimezone(),
  );
  deps.route(to, deps.agentId, formatted, {
    channel: originChannel,
    qualifier: originQualifier,
    targetParticipant: originParticipant,
  });
}

/**
 * The full context of an inbound cross-agent request, captured so the request
 * can be held pending an owner's acl-edge approval and replayed verbatim on
 * grant. Carried opaquely through the approval's `payload`, re-validated on the
 * way back.
 */
export const HeldInboundRequestSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(['query', 'request']),
  requestId: z.string(),
  text: z.string(),
  channel: z.string(),
  qualifier: z.string().optional(),
  returnToAgent: z.string(),
  returnToChannel: z.string(),
  returnToParticipant: z.string(),
  returnToQualifier: z.string().optional(),
  upstreamSet: z.array(z.string()),
  originParticipant: z.string(),
});
export type HeldInboundRequest = z.infer<typeof HeldInboundRequestSchema>;

/**
 * A first-contact user *message* (not an agent request) held pending an owner's
 * acl-edge approval (2B, single-store). A stranger with no grant gets an owner
 * approval raised instead of a silent "Not authorized." On grant the message is
 * replayed verbatim (ingested re-runs framework-tag sanitization). Carried
 * opaquely through the approval `payload`, re-validated on the way back. The
 * required `msgType` is what distinguishes this from a `HeldInboundRequest` when
 * the resume path re-parses the opaque carry.
 */
export const HeldMessageSchema = z.object({
  msgType: z.enum(['message', 'ingested']),
  from: z.string(),
  to: z.string(),
  text: z.string(),
  channel: z.string(),
  declaredName: z.string().optional(),
  routing: z.unknown().optional(),
  attachments: z.unknown().optional(),
});
export type HeldMessage = z.infer<typeof HeldMessageSchema>;

/** Receiver-side held push: a pushed-in turn held while the destination
 *  owner decides the carried user's `io` access. Distinct from `HeldMessage` (a
 *  first-contact plain message) and `HeldInboundRequest` (q/r) — the `carry` literal
 *  disambiguates the three when the `io`/access resume parses the payload. Replays
 *  via `deliverHeldPush` (push tier + attrs), not as a plain message. */
export const HeldPushDeliverySchema = z.object({
  carry: z.literal('push'),
  to: z.string(),
  from: z.string(),
  text: z.string(),
  channel: z.string(),
  requestId: z.string(),
  returnToParticipant: z.string(),
  returnToChannel: z.string(),
  returnToQualifier: z.string().optional(),
  routing: z.unknown().optional(),
});
export type HeldPushDelivery = z.infer<typeof HeldPushDeliverySchema>;

/**
 * Handle an inbound agent-to-agent request: ACL gate, then deliver / hold / reject.
 *
 * The access gate is origin-keyed and three-state: granted → deliver;
 * askable (the origin could be granted, the operator just hasn't spoken to the
 * edge) → raise an owner-directed acl-edge approval and hold the request;
 * rejected (explicit tombstone, or no acl.json) → the hard deny it always was.
 *
 * Q/A creates a stateful cell on this agent keyed to the *sender agent* (not
 * the originating user). That is the right shape — agents talk to agents.
 * The `returnToParticipant` field is response-routing metadata only (so the
 * answer can be delivered back into the originating user's conversation on
 * the calling agent), never an attribution claim or cell-key contributor.
 */
// ── Reactive-gate bounce accounting ────────────────────────────────────
// Caps how many non-delivery replies the gate routes back to a sender per
// standing condition before going silent: an askable edge's duplicate inbounds
// (keyed by the in-flight approval id, fresh per decision cycle) and a rejected
// edge's hammering (keyed by the edge + window). The notice asks the sender not
// to resend; this enforces it when the sender — an LLM, or a buggy loop —
// ignores the ask. In-memory and window-expiring, mirroring panic-registry's
// prune-on-write shape (a stale key is simply never read again once the edge
// resolves, so no cross-module cleanup is needed).
const BOUNCE_WINDOW_MS = 5 * 60_000;
const bounceCounts = new Map<string, { windowStart: number; count: number }>();

/** Record a bounce for `key`; return its attempt number within the current
 *  window (1 = first). Lazy-resets when the window elapses. Shared with the
 *  outbound containment gate (agent-spawn-hooks.ts, 2B.5) so one registry caps
 *  both directions. */
export function recordBounce(key: string, now: number = Date.now()): number {
  const prev = bounceCounts.get(key);
  if (!prev || now - prev.windowStart >= BOUNCE_WINDOW_MS) {
    bounceCounts.set(key, { windowStart: now, count: 1 });
    return 1;
  }
  prev.count += 1;
  return prev.count;
}

/** Test-only: clear bounce accounting between tests. */
export function _resetBounceStateForTest(): void {
  bounceCounts.clear();
}

/** A short, non-secret correlation code for an acl-edge approval. Surfaced to
 *  BOTH the requester (in
 *  the held-notice) and the owner (in the approval summary) as a disambiguation
 *  join-key — the owner recognizing the human is the gate, this is not a
 *  credential, so a 4-digit visual code is enough. */
export function mintCorrelationCode(): string {
  return randomInt(0, 10_000).toString().padStart(4, '0');
}

export const pendingNotice = (ref: string): string =>
  `Your request is pending the owner's approval (reference ${ref}). You'll get a reply once it's decided. Please don't resend.`;
export const ALREADY_PENDING_NOTICE =
  'You already have a request pending with this agent. Please wait for it to be answered before sending another.';

function handleInboundRequest(
  deps: BusHandlerDeps,
  from: string,
  to: string,
  req: {
    /** Wire-format kind chosen by the sender — used to render the matching
     *  `<cast:query>` / `<cast:request>` tag on the receiver's side so the
     *  receiving agent sees the sender's actual intent. */
    kind: 'query' | 'request';
    requestId: string;
    text: string;
    channel: string;
    qualifier?: string;
    returnToAgent: string;
    returnToChannel: string;
    returnToParticipant: string;
    returnToQualifier?: string;
    upstreamSet: string[];
  },
): void {
  // Two-axis access gate, origin-keyed. An agent sender is a relay carrying a
  // principal, so the access check binds to the carried *origin*
  // (`returnToParticipant`) — never the relay — and "Alice cannot reach Y"
  // holds on every path. A direct user/console sender is its own origin. This
  // mirrors the push arm's `hostPrincipal` derivation. Containment (may this
  // relay reach Y at all) was already gated at the sender's outbound `canEmit`.
  const originParticipant = isAgent(extractIdentity(from)) ? req.returnToParticipant : from;
  const held: HeldInboundRequest = {
    from, to, kind: req.kind, requestId: req.requestId, text: req.text,
    channel: req.channel, qualifier: req.qualifier,
    returnToAgent: req.returnToAgent, returnToChannel: req.returnToChannel,
    returnToParticipant: req.returnToParticipant, returnToQualifier: req.returnToQualifier,
    upstreamSet: req.upstreamSet, originParticipant,
  };

  const { bits, rejectMessage } = checkAcl(deps.bus, deps.folder, originParticipant, req.channel);
  if (gateInbound(bits, 'request').allowed) {
    deliverHeldInboundRequest(deps, held);
    return;
  }

  // Denied. Three-state: an *askable* edge — the origin could be granted,
  // the operator just hasn't spoken to it — raises an owner-directed acl-edge
  // approval and holds the request in the approval payload; a *rejected* edge
  // (explicit tombstone, or no acl.json) stays the hard deny it always was. Both
  // paths rate-limit the non-delivery replies they route back (a sender that
  // ignores the bounce and keeps retrying gets one or two informative replies,
  // then silence) so a retry loop can't amplify into owner-spam or a bounce storm.
  if (aclVerdict(deps.bus, deps.folder, originParticipant, req.channel, 'a') === 'askable') {
    const pendingId = deps.getApprovals().pendingAclEdge(originParticipant, req.channel, ['a']);
    if (pendingId) {
      // A decision for this edge is already in flight. Don't raise a second
      // approval — the owner decides the edge, not each message, and on grant
      // only the first held request is released (queuing later ones would
      // release messages the owner never saw). Tell the sender once it's already
      // pending, then go silent.
      if (recordBounce(`aclpend:${pendingId}`) === 1) {
        rejectHeldInboundRequest(deps, held, ALREADY_PENDING_NOTICE);
      }
      return;
    }
    // One correlation code for this decision cycle, surfaced to both sides: the
    // owner sees it on the approval card, the requester gets it in the held-
    // notice, so the owner can disambiguate which human the request is from.
    const ref = mintCorrelationCode();
    raiseAclEdgeApproval(deps, held, ref);
    // Non-terminal pending notice over the dedicated `pending` rail: ack the held
    // request so the sender learns it's parked (and stops resending) while leaving
    // its outbound row `open`. On grant the query is delivered and the real
    // `<cast:answer>` returns on this same `requestId` — which only works because
    // pending, unlike a rejection, never closed the row.
    pendingHeldInboundRequest(deps, held, pendingNotice(ref));
    return;
  }

  // Rejected (explicit tombstone, or no acl.json). Hard deny — bounce the reason
  // at most once per window, then blackhole, so a hammering sender can't turn the
  // denial into a reply amplifier. The reason is generic (the operator's
  // reject_message, or a default) — identical for tombstone and unlisted, so it
  // leaks neither.
  if (recordBounce(`acldeny:${deps.folder}|${originParticipant}|${req.channel}`) === 1) {
    rejectHeldInboundRequest(deps, held, rejectMessage ?? 'Not authorized.');
  }
}

/**
 * Deliver an inbound request into the receiver's conversation — record it, render
 * the wire-format tag, route it origin-keyed. Used on the happy path and on a
 * resume after an owner grants the held acl-edge approval.
 */
export function deliverHeldInboundRequest(deps: BusHandlerDeps, held: HeldInboundRequest): void {
  deps.agentDb.recordInboundRequest({
    requestId: held.requestId,
    fromAgent: held.from,
    returnToAgent: held.returnToAgent,
    returnToChannel: held.returnToChannel,
    returnToParticipant: held.returnToParticipant,
    returnToQualifier: held.returnToQualifier,
    channel: held.channel,
    // Origin-keyed cell: the carried query belongs to the origin's square
    // `[origin, Y, channel]`, not the relay's. Must equal `targetParticipant`
    // on the route below — the by-participant request queries (cycle detector,
    // list/close) key on this column, so it has to track the live cell key.
    participant: held.originParticipant,
    upstreamSet: JSON.stringify(held.upstreamSet),
    queryText: held.text,
  });

  // Render the matching tag — `<cast:query>` for q-bit senders (expect
  // answer), `<cast:request>` for r-bit senders (fire-and-forget). The
  // receiver agent sees the sender's actual wire-format intent; the
  // channel-contract prompt block teaches it that incoming `<cast:request>`
  // is fire-and-forget (no answer envelope required).
  const tagName = held.kind === 'request' ? 'cast:request' : 'cast:query';
  const tag = `<${tagName} from="${escapeXml(held.from)}" request="${escapeXml(held.requestId)}">${escapeXml(held.text)}</${tagName}>`;
  const formatted = formatMessages(
    [
      {
        id: held.requestId,
        address: held.to,
        sender: held.from,
        sender_name: held.from,
        content: tag,
        timestamp: new Date().toISOString(),
      },
    ],
    deps.getTimezone(),
  );
  // Origin-keyed routing: land the carried query in the origin's own
  // conversation with the target, not a relay-keyed `[X, Y]` square.
  // `resolveConversation` keys on `targetParticipant` (else it defaults to the
  // relay sender) — the same bridge the push arm uses for `returnToParticipant`.
  deps.route(held.to, held.from, formatted, {
    channel: held.channel,
    qualifier: held.qualifier,
    targetParticipant: held.originParticipant,
  });
}

/**
 * Route an outcome packet for a (possibly held) inbound request back to its
 * sender's originating cell — the shared envelope for the terminal and the
 * non-terminal outcomes below. `type` selects which: `rejection` closes the
 * sender's outbound row, `pending` deliberately does not.
 */
function routeHeldInboundOutcome(
  deps: BusHandlerDeps,
  held: HeldInboundRequest,
  type: 'rejection' | 'pending',
  reason: string,
): void {
  deps.bus.routeMessage(deps.agentId, held.returnToAgent, {
    type,
    requestId: held.requestId,
    reason,
    originChannel: held.returnToChannel,
    originParticipant: held.returnToParticipant,
    originQualifier: held.returnToQualifier,
  });
}

/** Terminally reject a (possibly held) inbound request — the sender's outbound
 *  row is closed as `rejected`. */
export function rejectHeldInboundRequest(deps: BusHandlerDeps, held: HeldInboundRequest, reason: string): void {
  routeHeldInboundOutcome(deps, held, 'rejection', reason);
}

/** Notify the sender that a held q/r request is pending the owner's approval —
 *  non-terminal, so the sender's outbound row stays `open` and the eventual
 *  owner-approved `<cast:answer>` still lands on the same `requestId` rail. The
 *  askable-edge counterpart to `rejectHeldInboundRequest`. */
export function pendingHeldInboundRequest(deps: BusHandlerDeps, held: HeldInboundRequest, reason: string): void {
  routeHeldInboundOutcome(deps, held, 'pending', reason);
}

/**
 * Raise an owner-directed acl-edge approval for an askable inbound edge, stashing
 * the full request in the approval payload so it can be replayed on grant.
 * Routes to the agent's owner (via `approver: 'owner'`); the four-option (approve
 * / reject / always) lets the owner persist a standing grant or tombstone. The
 * `ref` correlation code rides in the summary (and payload, for audit) so the
 * owner can match the card to the human who asked.
 */
function raiseAclEdgeApproval(deps: BusHandlerDeps, held: HeldInboundRequest, ref: string): void {
  const verb = held.kind === 'request' ? 'send a message to' : 'ask';
  deps.getApprovals().createRequest({
    type: 'acl-edge',
    approver: 'owner',
    participant: held.originParticipant,
    channel: held.channel,
    summary: `${held.originParticipant} (ref ${ref}) wants to ${verb} this agent on "${held.channel}".`,
    details: held.text,
    payload: JSON.stringify({ bit: 'a', ref, held }),
  });
}

// ── First-contact user messages (single-store reactive gate, 2B) ─────────────
// A plain message from a stranger (no grant) used to hard-deny with
// "Not authorized." Now the non-agent deny path is three-state, mirroring the
// agent-request gate: askable → raise an owner-directed acl-edge approval and
// hold the message (replayed on grant); rejected (tombstone / no acl.json) → the
// hard deny it always was. Agent senders are unchanged (they talk via requests,
// gated in handleInboundRequest). The owner-approved grant is 'io' — a two-way
// user conversation, matching what pairing used to grant.

/** Send a plain conversation reply to a user (notice / bounce / rejection). */
function replyToUser(deps: BusHandlerDeps, to: string, text: string): void {
  deps.bus.routeMessage(deps.agentId, to, { pkt: conversationPkt(deps.agentId, to, text) });
}

/**
 * Deliver an authorized inbound user message into the conversation — the single
 * delivery path for both the happy gate-pass and a resume after an owner grants
 * the held acl-edge approval. `ingested` re-runs the framework-tag sanitization
 * (a security step that must never be bypassed, including on resume).
 */
function deliverInboundMessage(
  deps: BusHandlerDeps,
  from: string,
  to: string,
  msgType: 'message' | 'ingested',
  text: string,
  routing: Routing | undefined,
  declaredName?: string,
  attachments?: Attachment[],
): void {
  const onErr = (kind: 'async' | 'sync') => (err: unknown) => {
    logger.error({ agentFolder: deps.folder, from, err }, `route() ${kind} error`);
    deps.agentDb.logEvent('error', 'conversation', 'route_failed', `route() ${kind} error: ${String(err)}`, {
      context: { from, kind, error: String(err) },
    });
  };
  try {
    if (msgType === 'message') {
      deps.route(to, from, text, routing).catch(onErr('async'));
      return;
    }
    // ingested — single chokepoint for untrusted participant text: strip the
    // forge-able framework family, then escape + wrap. `sanitized` is what the
    // agent sees AND what the log records (they no longer diverge).
    const { formatted, sanitized } = formatParticipantMessage(text, {
      sender: from,
      declaredName,
      timezone: deps.getTimezone(),
      timestamp: new Date().toISOString(),
    });
    // A strip means forged framework stimulus was removed before the agent saw
    // it. Record the verbatim attempt as a security event — the event log is
    // never re-injected into a prompt, unlike `message_log`.
    if (sanitized !== text.trim()) {
      deps.agentDb.logEvent('warn', 'conversation', 'framework_tag_stripped',
        `Stripped framework tag(s) from inbound participant text from ${from}`,
        { context: { from, channel: routing?.channel ?? 'default', raw: text } });
    }
    deps.route(to, from, formatted, routing, sanitized, declaredName, attachments).catch(onErr('async'));
  } catch (err) {
    onErr('sync')(err);
  }
}

/**
 * A non-agent sender failed the inbound message gate. Three-state: an *askable*
 * edge raises an owner-directed acl-edge approval and holds the message; a
 * *rejected* edge (tombstone / no acl.json) is the hard deny it always was. The
 * bounce machine caps the non-delivery replies a hammering sender can elicit
 * (the same accounting the request gate uses).
 */
function handleUnauthorizedInboundMessage(
  deps: BusHandlerDeps,
  from: string,
  channel: string,
  verb: string,
  rejectMessage: string | null,
  held: HeldMessage,
): void {
  // The askable→approval flip is the first-contact bootstrap for *people* (u:
  // identities — the operator god-modes the gate and never lands here). Console
  // and service principals keep the plain hard-deny: they have their own grant
  // paths, not an owner-approval bootstrap.
  if (!isUser(from)) {
    replyToUser(deps, from, rejectMessage ?? 'Not authorized.');
    return;
  }
  if (aclVerdict(deps.bus, deps.folder, from, channel, verb) === 'askable') {
    const pendingId = deps.getApprovals().pendingAclEdge(from, channel, ['io']);
    if (pendingId) {
      // A decision for this edge is already in flight — the owner decides the
      // edge, not each message. Tell the sender once, then go silent.
      if (recordBounce(`aclpend:${pendingId}`) === 1) replyToUser(deps, from, ALREADY_PENDING_NOTICE);
      return;
    }
    const ref = mintCorrelationCode();
    raiseAclEdgeMessageApproval(deps, from, channel, held, ref);
    // Ack the held message so a waiting sender stops; the real reply arrives when
    // the owner grants (the held message is then replayed).
    replyToUser(deps, from, pendingNotice(ref));
    return;
  }
  // Rejected (explicit tombstone, or no acl.json). Hard deny — bounce the reason
  // at most once per window, then blackhole.
  if (recordBounce(`acldeny:${deps.folder}|${from}|${channel}`) === 1) {
    replyToUser(deps, from, rejectMessage ?? 'Not authorized.');
  }
}

/**
 * Raise an owner-directed acl-edge approval for a first-contact user message,
 * stashing the message in the payload for replay on grant. Grants 'io' (a
 * two-way user conversation) on allow-always — what pairing used to confer.
 */
function raiseAclEdgeMessageApproval(deps: BusHandlerDeps, from: string, channel: string, held: HeldMessage, ref: string): void {
  deps.getApprovals().createRequest({
    type: 'acl-edge',
    approver: 'owner',
    participant: from,
    channel,
    summary: `${from} (ref ${ref}) wants to message this agent on "${channel}".`,
    details: held.text,
    payload: JSON.stringify({ bit: 'io', ref, held }),
  });
}

/** Replay a held first-contact message after the owner grants the acl-edge. */
export function deliverHeldMessage(deps: BusHandlerDeps, held: HeldMessage): void {
  deliverInboundMessage(
    deps, held.from, held.to, held.msgType, held.text,
    held.routing as Routing | undefined, held.declaredName, held.attachments as Attachment[] | undefined,
  );
}

/** Notify the user their held first-contact message was declined. */
export function rejectHeldMessage(deps: BusHandlerDeps, held: HeldMessage, reason: string): void {
  replyToUser(deps, held.from, reason);
}

/**
 * Deliver a pushed-in turn into the receiver's conversation — the happy
 * path (concrete member / console principal) and the resume after an owner grants
 * the held `io` access edge. Keys the cell on the carried user (`targetParticipant`)
 * and rides the push tier. Extracted from the inline `case 'push'` delivery so the
 * grant resume replays the exact same delivery.
 */
export function deliverHeldPush(deps: BusHandlerDeps, held: HeldPushDelivery): void {
  const attrs = pushTierAttrs({
    receiverAgent: deps.agentId,
    senderAgent: held.from,
    callerParticipant: held.returnToParticipant,
    callerChannel: held.returnToChannel,
    targetChannel: held.channel,
  });
  // Bridge the carried user into `routing.targetParticipant` so `resolveConversation`
  // keys the target cell on the user — not the pushing agent (else the agent's reply
  // addresses the sender, holds no `o`, and bounces). Mirrors the inline push path.
  const pushRouting = { ...(held.routing as Routing | undefined), targetParticipant: held.returnToParticipant };
  try {
    deps.route(held.to, held.from, held.text, pushRouting, undefined, undefined, undefined, 'push', attrs)
      .catch((err) => {
        logger.error({ agentFolder: deps.folder, from: held.from, err }, 'route() async error');
        deps.agentDb.logEvent('error', 'conversation', 'route_failed', `route() async error: ${String(err)}`, {
          context: { from: held.from, kind: 'async', error: String(err) },
        });
      });
  } catch (err) {
    logger.error({ agentFolder: deps.folder, from: held.from, err }, 'route() sync error');
    deps.agentDb.logEvent('error', 'conversation', 'route_failed', `route() sync error: ${String(err)}`, {
      context: { from: held.from, kind: 'sync', error: String(err) },
    });
  }
}

/** Decline a held pushed-in turn after the owner rejects the access edge — route a
 *  rejection back to the conduit sender referencing the original push. */
export function rejectHeldPush(deps: BusHandlerDeps, held: HeldPushDelivery, reason: string): void {
  routePushRejection(
    deps, held.from, held.channel, held.requestId, held.returnToChannel,
    held.returnToParticipant, held.returnToQualifier, reason,
  );
}

/** Raise an owner-directed acl-edge approval for a pushed-in user lacking access,
 *  stashing the push in the payload for replay on grant. Grants `io` on
 *  allow-always — the carried user becomes a conversant on this agent. */
function raiseAclEdgePushApproval(deps: BusHandlerDeps, carriedUser: string, channel: string, held: HeldPushDelivery, ref: string): void {
  deps.getApprovals().createRequest({
    type: 'acl-edge',
    approver: 'owner',
    participant: carriedUser,
    channel,
    summary: `${held.from} (ref ${ref}) wants to bring ${carriedUser} into a conversation on "${channel}".`,
    details: held.text,
    payload: JSON.stringify({ bit: 'io', ref, held }),
  });
}

