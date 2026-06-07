/**
 * Packet-type predicate for outbound transport delivery.
 *
 * Every transport's `send(pkt, ctx)` opens with the same guard: only
 * `'conversation' | 'approval_request' | 'approval_ack'` packets get delivered;
 * `'delegate'` packets are internal routing primitives that never leave the
 * bus. A shared helper names the set so the per-transport `if (pkt.type !== …
 * && pkt.type !== …)` triple becomes a single typed predicate call.
 *
 * The narrowing in the type predicate is what gives each transport's
 * post-guard code access to the conversation/approval shapes without
 * additional checks.
 */
import type {
  AnyPacket,
  ApprovalAckPkt,
  ApprovalRequestPkt,
  ConversationPkt,
  PreviewPkt,
} from '../types.js';

/** The union of packet types a transport may deliver. */
export type DeliverablePacket = ConversationPkt | ApprovalRequestPkt | ApprovalAckPkt | PreviewPkt;

/**
 * `true` iff `pkt` is one of the transport-deliverable packet variants
 * (`conversation`, `approval_request`, `approval_ack`, `preview`). `delegate`
 * packets route through the bus only — transports drop them silently. Named
 * here so adding a new deliverable type lands in one place instead of four.
 */
export function isDeliverablePacket(pkt: AnyPacket): pkt is DeliverablePacket {
  return (
    pkt.type === 'conversation' ||
    pkt.type === 'approval_request' ||
    pkt.type === 'approval_ack' ||
    pkt.type === 'preview'
  );
}

/**
 * `true` iff `pkt` should be persisted in `gateway.db` and flow through
 * `markDelivered`. Previews are ephemeral by design — kind-agnostic check,
 * future preview kinds (tool_call, progress) inherit the right behavior
 * without touching this predicate.
 */
export function isPersistablePacket(pkt: AnyPacket): boolean {
  return pkt.type !== 'preview';
}
