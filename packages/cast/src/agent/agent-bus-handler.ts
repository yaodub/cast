/**
 * BusHandler implementation for AgentManager.
 *
 * Owns: dispatch on inbound bus payload type (message, ingested, push,
 * request, response, rejection, pairing, pairing_request, approval_response)
 * and the per-type handlers — ACL gating, request bookkeeping, pairing
 * flow, approval routing. Lives in its own file so AgentManager stays
 * focused on owning state and the "what happens on each inbound message"
 * concept has one home.
 */
import { checkAcl, gateInbound, hasBit } from '../auth/acl.js';
import {
  extractHandle,
  extractIdentity,
  isAgent,
  isAuthoringSender,
} from '../auth/address.js';
import type { IdentityProvider } from '../auth/identity.js';
import { generatePairingCode, type PairingResult } from '../auth/pairing.js';
import type { Bus } from '../gateway/bus.js';
import { conversationPkt } from '../gateway/packets.js';
import { escapeXml, formatMessages } from '../lib/format.js';
import { updateRoster } from '../lib/identity-roster.js';
import { logger } from '../logger.js';
import { generateId } from '../lib/utils.js';
import type { Attachment, RouteResult } from '../types.js';

import type { AgentDb } from './agent-db.js';
import {
  AgentBusPayloadSchema,
  type AgentBusPayload,
  type Routing,
} from './agent-bus-payload.js';
import type { ApprovalHandler } from './approval-handler.js';
import type { DeliverKind } from './conversation-runner.js';
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
  /** Validate pairing code + grant ACL. Closure over AgentManager.pair, the
   *  sole writer of state/paired-users.json. */
  pair: (handle: string, code: string) => PairingResult;
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
    case 'pairing':
      handlePairingRequest(deps, from, parsed.code);
      return;

    case 'pairing_request':
      handlePairingCodeGeneration(deps, from);
      return;

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
          const replyText = rejectMessage ?? 'Not authorized.';
          deps.bus.routeMessage(deps.agentId, from, {
            pkt: conversationPkt(deps.agentId, from, replyText),
          });
        }
        return;
      }
      try {
        deps.route(to, from, parsed.text, parsed.routing).catch((err) => {
          logger.error({ agentFolder: deps.folder, from, err }, 'route() async error');
          deps.agentDb.logEvent('error', 'conversation', 'route_failed', `route() async error: ${String(err)}`, {
            context: { from, kind: 'async', error: String(err) },
          });
        });
      } catch (err) {
        logger.error({ agentFolder: deps.folder, from, err }, 'route() sync error');
        deps.agentDb.logEvent('error', 'conversation', 'route_failed', `route() sync error: ${String(err)}`, {
          context: { from, kind: 'sync', error: String(err) },
        });
      }
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
          const replyText = rejectMessage ?? 'Not authorized.';
          deps.bus.routeMessage(deps.agentId, from, {
            pkt: conversationPkt(deps.agentId, from, replyText),
          });
        }
        return;
      }
      const formatted = formatMessages(
        [
          {
            id: generateId('pkt'),
            address: to,
            sender: from,
            sender_name: parsed.declaredName ?? from,
            content: parsed.text,
            timestamp: new Date().toISOString(),
          },
        ],
        deps.getTimezone(),
      );
      try {
        deps.route(
          to,
          from,
          formatted,
          parsed.routing,
          parsed.text,
          parsed.declaredName,
          parsed.attachments,
        ).catch((err) => {
          logger.error({ agentFolder: deps.folder, from, err }, 'route() async error');
          deps.agentDb.logEvent('error', 'conversation', 'route_failed', `route() async error: ${String(err)}`, {
            context: { from, kind: 'async', error: String(err) },
          });
        });
      } catch (err) {
        logger.error({ agentFolder: deps.folder, from, err }, 'route() sync error');
        deps.agentDb.logEvent('error', 'conversation', 'route_failed', `route() sync error: ${String(err)}`, {
          context: { from, kind: 'sync', error: String(err) },
        });
      }
      return;
    }

    case 'push': {
      const channel = parsed.routing?.channel ?? 'default';
      const { bits } = checkAcl(deps.bus, deps.folder, from, channel);
      const { allowed, verb } = gateInbound(bits, 'push');
      if (!allowed) {
        routePushRejection(
          deps,
          from,
          channel,
          parsed.requestId,
          parsed.returnToChannel,
          parsed.returnToParticipant,
          parsed.returnToQualifier,
          `Push from ${from} rejected: missing required bit '${verb}' on channel "${channel}"`,
        );
        return;
      }
      // Three-check model for cross-agent push: sender agent already gated
      // on `h` above; now gate the originating user on `i` for the target
      // channel. Without this check, a peer agent's `h` grant effectively
      // means "you can introduce any of your users into my channel" — a
      // silent authorization expansion.
      const { bits: userBits } = checkAcl(deps.bus, deps.folder, parsed.returnToParticipant, channel);
      if (!gateInbound(userBits, 'message').allowed) {
        logger.warn(
          { agentFolder: deps.folder, from, returnToParticipant: parsed.returnToParticipant, channel, requiredBit: 'i' },
          'Inbound push blocked — originating user not authorized on channel',
        );
        deps.agentDb.logEvent(
          'warn', 'conversation', 'push_denied_origin_user',
          `Push from ${from} rejected: originating user ${parsed.returnToParticipant} lacks 'i' on channel "${channel}"`,
          { context: { from, returnToParticipant: parsed.returnToParticipant, channel } },
        );
        routePushRejection(
          deps,
          from,
          channel,
          parsed.requestId,
          parsed.returnToChannel,
          parsed.returnToParticipant,
          parsed.returnToQualifier,
          `Push from ${from} rejected: originating user ${parsed.returnToParticipant} lacks 'i' on channel "${channel}"`,
        );
        return;
      }
      const attrs = pushTierAttrs({
        receiverAgent: deps.agentId,
        senderAgent: from,
        callerParticipant: parsed.returnToParticipant,
        callerChannel: parsed.returnToChannel,
        targetChannel: channel,
      });
      try {
        // The push payload carries the originating user at top-level
        // (`returnToParticipant`). Bridge it into `routing.targetParticipant`
        // so `resolveConversation` keys the target conversation on the
        // operator/user — not on the pushing agent. Without this, the
        // conversation belongs to the sender (e.g. DM), the agent's reply
        // is addressed back to the sender (no `o` bit → bounces), and the
        // operator never sees it on the target's pill.
        const pushRouting = { ...parsed.routing, targetParticipant: parsed.returnToParticipant };
        deps.route(
          to,
          from,
          parsed.text,
          pushRouting,
          undefined,
          undefined,
          undefined,
          'push',
          attrs,
        ).catch((err) => {
          logger.error({ agentFolder: deps.folder, from, err }, 'route() async error');
          deps.agentDb.logEvent('error', 'conversation', 'route_failed', `route() async error: ${String(err)}`, {
            context: { from, kind: 'async', error: String(err) },
          });
        });
      } catch (err) {
        logger.error({ agentFolder: deps.folder, from, err }, 'route() sync error');
        deps.agentDb.logEvent('error', 'conversation', 'route_failed', `route() sync error: ${String(err)}`, {
          context: { from, kind: 'sync', error: String(err) },
        });
      }
      return;
    }

    case 'request': {
      handleInboundRequest(deps, from, to, parsed);
      return;
    }

    case 'response': {
      const req = deps.agentDb.getOutboundRequest(parsed.requestId);
      if (!req || req.status !== 'open') return;
      deps.agentDb.updateRequestStatus('outbound', parsed.requestId, 'fulfilled');
      if (!senderAcceptsReply(deps, req.target_agent, req.target_channel, parsed.requestId)) return;
      const respTag = `<cast:answer from="${escapeXml(from)}" request="${escapeXml(parsed.requestId)}">${escapeXml(parsed.text)}</cast:answer>`;
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
      // `<cast:rejection>` delivery tag but differ in receiver-side
      // bookkeeping and (for pushes) skip the q/r split re-check since
      // rejections carry no data flow.
      const req = deps.agentDb.getOutboundRequest(parsed.requestId);
      if (req && req.status === 'open') {
        deps.agentDb.updateRequestStatus('outbound', parsed.requestId, 'rejected');
        if (!senderAcceptsReply(deps, req.target_agent, req.target_channel, parsed.requestId)) return;
        const rejTag = `<cast:rejection from="${escapeXml(from)}" request="${escapeXml(parsed.requestId)}">${escapeXml(parsed.reason)}</cast:rejection>`;
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
        const rejTag = `<cast:rejection from="${escapeXml(from)}" request="${escapeXml(parsed.requestId)}">${escapeXml(parsed.reason)}</cast:rejection>`;
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

    case 'approval_response': {
      deps.getApprovals().handleResponse(from, parsed);
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
 * Re-check sender's ACL at reply-delivery time to honor the q/r split. With
 * `q`, the answer enters the sender's session; with `r` only (or no grant at
 * all — operator revoked between send and reply), the reply is blackholed.
 * The outbound row is marked fulfilled/rejected regardless so retries don't
 * accumulate. Hot-reloaded ACL is the live source of truth — no derived
 * `noReply` state cached anywhere.
 */
function senderAcceptsReply(
  deps: BusHandlerDeps,
  targetAgent: string,
  targetChannel: string,
  requestId: string,
): boolean {
  const { bits } = checkAcl(deps.bus, deps.folder, targetAgent, targetChannel);
  if (hasBit(bits, 'q')) return true;
  logger.info(
    { agentFolder: deps.folder, targetAgent, targetChannel, requestId },
    'Request reply suppressed (no `q` bit — r-only or revoked)',
  );
  return false;
}

/** Format and route a request reply (response or rejection) to the original conversation. */
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
 * Handle an inbound agent-to-agent request: ACL check, record, format, route.
 *
 * Q/A creates a stateful cell on this agent keyed to the *sender agent* (not
 * the originating user). That is the right shape — agents talk to agents.
 * The `returnToParticipant` field is response-routing metadata only (so the
 * answer can be delivered back into the originating user's conversation on
 * the calling agent), never an attribution claim or cell-key contributor.
 */
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
  const { bits, rejectMessage } = checkAcl(deps.bus, deps.folder, from, req.channel);
  if (!gateInbound(bits, 'request').allowed) {
    deps.bus.routeMessage(deps.agentId, req.returnToAgent, {
      type: 'rejection' as const,
      requestId: req.requestId,
      reason: rejectMessage ?? 'Not authorized.',
      originChannel: req.returnToChannel,
      originParticipant: req.returnToParticipant,
      originQualifier: req.returnToQualifier,
    });
    return;
  }

  deps.agentDb.recordInboundRequest({
    requestId: req.requestId,
    fromAgent: from,
    returnToAgent: req.returnToAgent,
    returnToChannel: req.returnToChannel,
    returnToParticipant: req.returnToParticipant,
    returnToQualifier: req.returnToQualifier,
    channel: req.channel,
    participant: from,
    upstreamSet: JSON.stringify(req.upstreamSet),
    queryText: req.text,
  });

  // Render the matching tag — `<cast:query>` for q-bit senders (expect
  // answer), `<cast:request>` for r-bit senders (fire-and-forget). The
  // receiver agent sees the sender's actual wire-format intent; the
  // channel-contract prompt block teaches it that incoming `<cast:request>`
  // is fire-and-forget (no answer envelope required).
  const tagName = req.kind === 'request' ? 'cast:request' : 'cast:query';
  const tag = `<${tagName} from="${escapeXml(from)}" request="${escapeXml(req.requestId)}">${escapeXml(req.text)}</${tagName}>`;
  const formatted = formatMessages(
    [
      {
        id: req.requestId,
        address: to,
        sender: from,
        sender_name: from,
        content: tag,
        timestamp: new Date().toISOString(),
      },
    ],
    deps.getTimezone(),
  );
  deps.route(to, from, formatted, { channel: req.channel, qualifier: req.qualifier });
}

/** Process a pairing request. Called when gateway dispatches /pair through bus. */
function handlePairingRequest(deps: BusHandlerDeps, from: string, code: string): void {
  if (!deps.idp) {
    logger.warn(
      { agentFolder: deps.folder },
      'Pairing request received but no identity provider',
    );
    return;
  }

  const handle = extractHandle(from);
  if (!handle) {
    logger.warn(
      { from },
      'Pairing request from address without transport handle',
    );
    return;
  }
  const result = deps.pair(handle, code);

  // Update identity roster on successful pairing
  if (result.success && result.identity) {
    updateRoster(deps.folder, result.identity);
  }

  deps.bus.routeMessage(deps.agentId, from, {
    pkt: conversationPkt(deps.agentId, from, result.message),
  });
}

/** Generate a pairing code for the requesting handle; tell user to get it from the operator. */
function handlePairingCodeGeneration(deps: BusHandlerDeps, from: string): void {
  const handle = extractHandle(from);
  if (!handle) {
    deps.bus.routeMessage(deps.agentId, from, {
      pkt: conversationPkt(deps.agentId, from, 'Could not resolve your handle.'),
    });
    return;
  }
  generatePairingCode(deps.folder, handle);
  deps.bus.routeMessage(deps.agentId, from, {
    pkt: conversationPkt(
      deps.agentId,
      from,
      'A pairing code has been generated. Ask the server operator for your code, then send: /pair <code>',
    ),
  });
}
