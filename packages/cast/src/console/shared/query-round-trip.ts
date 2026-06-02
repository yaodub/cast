/**
 * Outbound `<cast:query>` round-trip subsystem for server-scope consoles.
 *
 * When a manager emits `<cast:query target="X" channel="__design">...</cast:query>`
 * in its output, the conversation runner's parser invokes `onRequest` on
 * the spawn hook. That lands here. We:
 *
 *   1. Source-side ACL gate — `hasOutboundBit(self, target, channel, 'q')`.
 *   2. Mint a `requestId` and remember the originating ConversationView so
 *      the eventual reply can be routed back.
 *   3. Route a `type: 'request'` packet through the bus. Receiver's
 *      `checkAcl` then requires `'a'` on the inverse axis.
 *   4. When the answer arrives (a `type: 'response'` or `'rejection'`
 *      packet inbound to the manager's address), look up the tracker entry
 *      and deliver a synthetic `<cast:answer>` tag through the View.
 *
 * State: a `Map<requestId, ConversationView<ServerScopeSpawnContext>>` owned
 * by this class. Lifetime is single-process — server restart drops pending
 * queries along with the conversations that issued them. ACL or routing
 * failure delivers a synthetic `<cast:answer>` so the manager sees a clear
 * failure reason instead of silence.
 *
 * Why a separate class: the protocol has its own state, its own four
 * collaborating methods, and is independent of how a console hosts a
 * session. Pulling it out of `ServerScopeConsole` lets the host class
 * focus on session hosting and lets the protocol be tested in isolation.
 */
import type { Bus } from '../../gateway/bus.js';
import type { ConversationView } from '../../conversations/index.js';
import { escapeXml } from '../../lib/format.js';
import { logger } from '../../logger.js';
import { generateId } from '../../lib/utils.js';

import { hasOutboundBit } from './console-auth.js';
import type { ServerScopeConsoleSpec, ServerScopeSpawnContext } from './server-scope.js';

type ReplyMessage =
  | { type: 'response'; text: string; requestId: string }
  | { type: 'rejection'; requestId: string; reason: string };

export class OutboundQueryTracker {
  private readonly outboundRequests = new Map<
    string,
    ConversationView<ServerScopeSpawnContext>
  >();

  constructor(
    private readonly bus: Bus,
    private readonly spec: ServerScopeConsoleSpec,
  ) {}

  /**
   * Sender side. Resolve `target` (folder/alias/address) via the bus,
   * gate on the matching ACL bit (`q` for query, `r` for request), mint a
   * request id, route through the bus, and — for queries only — remember
   * the originating View so the reply can be delivered. Requests are
   * fire-and-forget; the sender opted out of the return path. ACL/routing
   * failures deliver a synthetic `<cast:rejection>` so the LLM sees the
   * reason instead of silence.
   */
  async handleOutboundRequest(
    view: ConversationView<ServerScopeSpawnContext>,
    kind: 'query' | 'request',
    rawTarget: string,
    channel: string,
    text: string,
    qualifier?: string,
  ): Promise<void> {
    const target = this.bus.resolveAddress(rawTarget) ?? rawTarget;
    const selfAddr = this.spec.descriptor.address;
    const ctx = view.ctx;
    if (!ctx) {
      logger.error(
        { console: this.spec.consoleName, key: view.key },
        'OutboundQueryTracker: no ctx on conversation — internal invariant',
      );
      return;
    }

    const requiredBit: 'q' | 'r' = kind === 'query' ? 'q' : 'r';
    if (!hasOutboundBit(selfAddr, target, channel, requiredBit)) {
      logger.info(
        { console: this.spec.consoleName, target, channel, kind, requiredBit },
        `OutboundQueryTracker: outbound ${kind} blocked (no ${requiredBit} bit)`,
      );
      this.deliverSyntheticRejection(
        view,
        `${kind}-denied-${generateId('req')}`,
        `${kind === 'query' ? 'Query' : 'Request'} to ${rawTarget} was denied (no ${requiredBit} grant on ${channel}).`,
        selfAddr,
      );
      return;
    }

    if (!this.bus.resolve(target)) {
      logger.warn(
        { console: this.spec.consoleName, target: rawTarget, kind },
        `OutboundQueryTracker: ${kind} target not registered on bus`,
      );
      this.deliverSyntheticRejection(
        view,
        `${kind}-unresolved-${generateId('req')}`,
        `${kind === 'query' ? 'Query' : 'Request'} target ${rawTarget} is not registered.`,
        selfAddr,
      );
      return;
    }

    const requestId = generateId('req');
    // Track queries only — requests are fire-and-forget, no reply expected.
    if (kind === 'query') {
      this.outboundRequests.set(requestId, view);
    }

    // Fire-and-forget — awaiting would deadlock the sender's outputChain.
    // `upstreamSet` is empty: manager consoles don't receive queries, so no
    // cycles are possible and cycle-detection machinery isn't needed.
    this.bus
      .routeMessage(selfAddr, target, {
        type: 'request' as const,
        kind,
        text,
        requestId,
        channel,
        returnToAgent: selfAddr,
        returnToChannel: ctx.channelName,
        returnToParticipant: ctx.participant ?? selfAddr,
        returnToQualifier: ctx.qualifier,
        upstreamSet: [],
        routing: { channel, qualifier },
      })
      .catch((err) => {
        logger.error(
          { console: this.spec.consoleName, requestId, kind, err },
          `OutboundQueryTracker: ${kind} route failed`,
        );
        this.outboundRequests.delete(requestId);
        this.deliverSyntheticRejection(
          view,
          requestId,
          `${kind === 'query' ? 'Query' : 'Request'} routing failed: ${err instanceof Error ? err.message : String(err)}`,
          selfAddr,
        );
      });
  }

  /**
   * Hook target for `<cast:answer>` tags emitted in the manager's own output.
   * Today managers don't receive queries, so this is unreachable — kept
   * wired for symmetry in case a future design routes queries TO a
   * server-scope console.
   */
  async handleOutboundResponse(
    _view: ConversationView<ServerScopeSpawnContext>,
    _requestId: string,
    _text: string,
  ): Promise<void> {
    logger.warn(
      { console: this.spec.consoleName },
      'OutboundQueryTracker: unexpected <cast:answer> emission — managers are queriers, not answerers',
    );
  }

  /**
   * Receiver side. An inbound `response` or `rejection` packet — the reply
   * to a previously-tracked outbound `<cast:query>`. Look up the tracker, find
   * the originating View, deliver a synthetic `<cast:answer>` tag.
   */
  handleInboundReply(from: string, msg: ReplyMessage): void {
    const view = this.outboundRequests.get(msg.requestId);
    if (!view) {
      logger.warn(
        { console: this.spec.consoleName, requestId: msg.requestId, from },
        'OutboundQueryTracker: reply for unknown request — dropped',
      );
      return;
    }
    this.outboundRequests.delete(msg.requestId);

    if (!view.canDeliverQueryReply()) {
      logger.warn(
        {
          console: this.spec.consoleName,
          requestId: msg.requestId,
          conversationKey: view.key,
        },
        'OutboundQueryTracker: reply arrived after conversation was destroyed — dropped',
      );
      return;
    }

    if (msg.type === 'response') {
      this.deliverSyntheticAnswer(view, msg.requestId, msg.text, from);
    } else {
      this.deliverSyntheticRejection(view, msg.requestId, msg.reason, from);
    }
  }

  /**
   * Deliver a synthetic `<cast:answer>` tag to the conversation so the LLM
   * sees a successful query result. Symmetric with the peer-to-peer answer
   * path in `agent-bus-handler.ts`. The View handles spawn-or-pipe routing
   * internally.
   */
  private deliverSyntheticAnswer(
    view: ConversationView<ServerScopeSpawnContext>,
    requestId: string,
    text: string,
    from: string,
  ): void {
    const tag = `<cast:answer from="${escapeXml(from)}" request="${escapeXml(requestId)}">${escapeXml(text)}</cast:answer>`;
    void view.deliver(tag);
  }

  /**
   * Deliver a synthetic `<cast:rejection>` tag so the LLM distinguishes a
   * failed query (denied, unresolved, route-failed, or peer-rejected) from
   * a successful answer. Symmetric with the peer-to-peer rejection path in
   * `agent-bus-handler.ts`.
   */
  private deliverSyntheticRejection(
    view: ConversationView<ServerScopeSpawnContext>,
    requestId: string,
    reason: string,
    from: string,
  ): void {
    const tag = `<cast:rejection from="${escapeXml(from)}" request="${escapeXml(requestId)}">${escapeXml(reason)}</cast:rejection>`;
    void view.deliver(tag);
  }
}
