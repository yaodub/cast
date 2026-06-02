/**
 * MessageGateway — bidirectional client boundary.
 *
 * Owns inbound ingestion (store packet, format, route to bus), outbound delivery
 * (store packet, find transport, send), transport binding table, and history queries.
 *
 * Implements BusHandler for transport-bound addresses (cli:*, tg:*).
 */
import { z } from 'zod';

import { buildResolvedParticipant, extractHandle, isOperatorHandle } from '../auth/address.js';
import { storePacket, markDelivered, getPacketHistory, getUndeliveredPackets, getPendingOutboundForRecipient, getUndeliveredOutboundRecipients } from './gateway-db.js';
import type { StoredPacket } from './gateway-db.js';
import type { IdentityProvider } from '../auth/identity.js';
import { conversationPkt, delegatePkt, AnyPacketSchema } from './packets.js';
import type { AnyPacket, ConversationPkt } from './packets.js';
import { logger } from '../logger.js';
import type { SystemCommandDispatcher } from '../commands/index.js';
import { generateId, parseJsonSafe } from '../lib/utils.js';
import type { Bus, BusHandler } from './bus.js';
import type { LogHostEventFn } from '../server/host-activity-log.js';
import { isExternallyReachable } from './firewall.js';
import { attachmentHostPath, persistAttachment } from '../lib/attachment-store.js';
import { MAX_ATTACHMENT_BYTES } from '../config.js';
import { isPersistablePacket } from '../transports/packet-dispatch.js';
import type { Attachment, ApprovalResponsePayload, Evt } from '../types.js';
import type { Transport, OutboundContext } from '../transports/schema.js';

// --- Bus payload schema (validated at handler boundary) ---

const GatewayBusPayloadSchema = z.object({
  pkt: AnyPacketSchema,
  channel: z.string().optional(),
  conversationKey: z.string().optional(),
});

interface MessageGatewayDeps {
  bus: Bus;
  transports: () => Transport[];
  identityProvider: IdentityProvider;
  systemCommands?: SystemCommandDispatcher;
  /** Resolve an agent address to its effective IANA timezone. Used when rendering per-message timestamps. */
  resolveTimezone?: (agentAddress: string) => string | undefined;
  /** Optional structured-event sink for host-tier failures (identity registration, etc.). */
  logHostEvent?: LogHostEventFn;
}

export class MessageGateway implements BusHandler {
  private deps: MessageGatewayDeps;

  constructor(deps: MessageGatewayDeps) {
    this.deps = deps;
  }

  // =========================================================================
  // BusHandler implementation (outbound delivery for cli:*/tg:* addresses)
  // =========================================================================

  async handleMessage(_from: string, _to: string, payload: unknown): Promise<void> {
    const { pkt, channel, conversationKey } = GatewayBusPayloadSchema.parse(payload);
    await this.deliverOutbound(pkt, channel, conversationKey);
  }

  async handleEvent(evt: Evt): Promise<void> {
    const handle = extractHandle(evt.to);
    if (!handle) return; // Agent addresses have no transport handle
    const transport = this.deps.transports().find(
      (t) => t.ownsParticipant(handle) && t.isConnected(),
    );
    if (transport) await transport.sendEvent({ ...evt, to: handle });
  }

  // =========================================================================
  // Inbound ingestion
  // =========================================================================

  /**
   * Ingest an inbound message from any channel.
   *
   * 1. Resolve identity (server-wide)
   * 2. System command check (/help, /whoami, /name — server-wide)
   * 3. Resolve target agent
   * 4. Server firewall check (external senders only)
   * 5. /pair interception — dispatched to agent via bus (agent-scoped)
   * 6. Build + persist ConversationPkt
   * 7. Format as XML
   * 8. Forward via bus.routeMessage() with resolved from address + declaredName
   */
  ingestInbound(
    from: string,
    to: string,
    text: string,
    senderName: string,
    routing?: { channel?: string; qualifier?: string },
    attachments?: Attachment[],
  ): void {
    const idp = this.deps.identityProvider;
    // Auto-register identity on first contact. Operator-class handles
    // (cli:*, admin:*) short-circuit to the `local` identity via
    // idp.resolve and must NOT be auto-registered as external users.
    let resolved = idp.resolve(from);
    if (!resolved && !isOperatorHandle(from)) {
      try { resolved = idp.register(from, senderName); } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (this.deps.logHostEvent) {
          this.deps.logHostEvent('warn', 'auth', 'identity_register_failed',
            'Identity registration failed, falling back to resolve',
            { fromAddr: from, context: { error: errMsg, sender_name: senderName } });
        } else {
          logger.warn({ from, err }, 'Identity registration failed, falling back to resolve');
        }
        resolved = idp.resolve(from);
      }
    }
    const trimmed = text.trim();

    // System command check — server-wide commands handled here
    if (this.deps.systemCommands && trimmed.startsWith('/')) {
      const cmdResult = this.deps.systemCommands.dispatch(
        { identity: resolved?.id ?? null, handle: from },
        trimmed,
      );
      if (cmdResult) {
        this.sendSystemReply(to, from, cmdResult.text);
        return;
      }
    }

    // Resolve target agent — needed for both firewall check and /pair
    const handler = this.deps.bus.resolve(to);
    if (!handler) {
      logger.debug({ to }, 'Message for unregistered address, dropping');
      this.deps.logHostEvent?.('warn', 'gateway', 'unrouted_packet', `No handler for ${to} (transport ingest)`, {
        fromAddr: from,
        toAddr: to,
        context: { stage: 'ingestInbound' },
      });
      return;
    }

    // Server firewall — block external traffic to non-exposed agents.
    // Operator-class handles (cli:*, admin:*) bypass: they're both
    // localhost-bound, trusted by machine-access boundary, and need to
    // reach non-exposed agents (e.g. the admin UI composing a local-only
    // agent via Design console).
    if (!isOperatorHandle(from)) {
      const resolvedAddress = this.deps.bus.resolveAddress(to);
      const meta = resolvedAddress ? this.deps.bus.getMetadata(resolvedAddress) : undefined;
      if (meta && !isExternallyReachable(meta.label)) {
        logger.info({ from, to, agent: meta.label }, 'Blocked by server firewall');
        this.sendSystemReply(to, from, 'This service is not available.');
        return;
      }
    }

    // /pair — intercepted at gateway, dispatched to agent via bus
    if (trimmed.startsWith('/pair ') || trimmed === '/pair') {
      const code = trimmed.slice(6).trim();
      if (!code) {
        this.deps.bus.routeMessage(from, to, { type: 'pairing_request' });
      } else {
        this.deps.bus.routeMessage(from, to, { type: 'pairing', code });
      }
      return;
    }

    // Build resolved from address (null identity → use raw handle)
    const resolvedFrom = resolved
      ? buildResolvedParticipant(resolved.id, from)
      : from;
    const declaredName = resolved?.declaredName ?? senderName;

    const pktId = generateId('pkt');
    const pkt = conversationPkt(resolvedFrom, to, text, undefined, undefined, undefined, pktId);
    storePacket(pktId, pkt, 'inbound', undefined, routing?.channel);
    markDelivered(pktId);

    // Server-side ack — fires after persist + delivery mark, before route.
    // Transports decide how (or whether) to render. The web UI's admin chat
    // flickers its typing indicator off this; Telegram and CLI ignore it.
    // `from = to` (agent — the receiver) and `to = resolvedFrom` (the operator
    // who sent) so the bus dispatches the event back to the sender's transport.
    this.deps.bus.routeEvent({
      from: to,
      to: resolvedFrom,
      type: 'message_received',
      data: {
        id: pktId,
        channel: routing?.channel ?? 'default',
        timestamp: pkt.timestamp,
      },
    });

    logger.info(
      { to, from: resolvedFrom, sender: declaredName, text: text.slice(0, 80) },
      'Message ingested',
    );

    // Persist inbound attachment binaries before bus dispatch. The bus's
    // `AttachmentSchema` strips `data:Buffer` (Buffers don't survive JSON,
    // and cross-agent payloads carry hash + hostPath only). Transports that
    // ship raw bytes (Telegram, email) get normalized here; transports that
    // pre-persist (web) pass through unchanged.
    const dispatchAttachments = attachments?.length
      ? this.persistInboundAttachments(to, attachments)
      : attachments;

    // Gateway emits structured fields; the receiver-side bus handler is
    // the single envelope authority and runs `formatMessages` from the
    // raw body + sender metadata.
    this.deps.bus.routeMessage(resolvedFrom, to, {
      type: 'ingested',
      text,
      declaredName,
      attachments: dispatchAttachments,
      routing,
    });
  }

  private persistInboundAttachments(to: string, attachments: Attachment[]): Attachment[] {
    const resolved = this.deps.bus.resolveAddress(to) ?? to;
    const folder = this.deps.bus.getMetadata(resolved)?.folderPath;
    if (!folder) {
      logger.error({ to }, 'Cannot persist inbound attachments — no folder for target');
      return [];
    }
    const out: Attachment[] = [];
    for (const att of attachments) {
      if (att.hostPath && att.hash) {
        out.push(att);
        continue;
      }
      if (!att.data) {
        logger.error(
          { to, filename: att.filename, mimeType: att.mimeType },
          'Inbound attachment has no payload — dropping',
        );
        continue;
      }
      if (att.data.length > MAX_ATTACHMENT_BYTES) {
        logger.warn(
          { to, filename: att.filename, size: att.data.length, limit: MAX_ATTACHMENT_BYTES },
          'Dropping oversized attachment',
        );
        continue;
      }
      const persisted = persistAttachment(folder, att.data, att.mimeType);
      out.push({
        filename: att.filename,
        mimeType: att.mimeType,
        hostPath: persisted.hostPath,
        filesize: att.data.length,
        hash: persisted.hash,
      });
    }
    return out;
  }

  /** Send a system reply back to a participant via outbound delivery. */
  private sendSystemReply(agentAddress: string, participant: string, replyText: string): void {
    const pkt = conversationPkt(agentAddress, participant, replyText);
    this.deliverOutbound(pkt);
  }

  /**
   * Ingest a delegation: X tells agent Y to talk to Z.
   *
   * 1. Resolve handler via bus
   * 2. Build + persist DelegatePkt
   * 3. Update address metadata
   * 4. Format as XML
   * 5. Forward via bus.routeMessage() with replyTo = target
   */
  ingestDelegation(
    from: string,
    to: string,
    target: string,
    text: string,
    senderName: string,
    routing?: { channel?: string; qualifier?: string },
  ): void {
    const handler = this.deps.bus.resolve(to);
    if (!handler) {
      logger.warn({ to, from, target }, 'Delegation for unregistered address');
      return;
    }

    const pkt = delegatePkt(from, to, target, text);
    const pktId = generateId('pkt');
    storePacket(pktId, pkt, 'inbound');
    markDelivered(pktId);

    logger.info(
      { to, from, target, sender: senderName, text: text.slice(0, 80) },
      'Delegation ingested',
    );

    // Gateway emits structured fields; receiver-side bus handler builds
    // the `<messages>` envelope. `targetParticipant` sets the cell-key
    // contributor on the receiver side.
    this.deps.bus.routeMessage(from, to, {
      type: 'ingested',
      text,
      declaredName: senderName,
      routing: { ...routing, targetParticipant: target },
    });
  }

  // =========================================================================
  // Outbound delivery
  // =========================================================================

  /**
   * Deliver an outbound packet (agent → participant) through the transport layer.
   * Persists the packet first, then drains all pending outbound packets for this
   * recipient in timestamp order — so older failed messages are retried before
   * newer ones, preserving conversation order.
   */
  /** Per-recipient send chains — serializes outbound sends to prevent concurrent double-delivery. */
  private sendChains = new Map<string, Promise<void>>();

  /** Per-streamId latest snapshot (kind: 'text' only in v1) — read-and-cleared
   *  by the first chain entry that drains. Subsequent peer entries find an
   *  empty map and no-op. This is the coalesce mechanism for previews. */
  private latestPreview = new Map<string, string>();

  async deliverOutbound(pkt: AnyPacket, channel?: string, conversationKey?: string): Promise<void> {
    // Preview text path — ephemeral + coalesced. Skip persistence; queue a
    // chain entry that reads the latest snapshot for this streamId at drain
    // time. Other preview kinds (none in v1) will need separate policies.
    if (pkt.type === 'preview' && pkt.kind === 'text') {
      this.latestPreview.set(pkt.streamId, pkt.text);

      const prev = this.sendChains.get(pkt.to) ?? Promise.resolve();
      const current = prev.then(async () => {
        const latest = this.latestPreview.get(pkt.streamId);
        if (latest === undefined) return;
        this.latestPreview.delete(pkt.streamId);
        const drained = { ...pkt, text: latest } as AnyPacket;
        await this.sendOne(drained, /* pktId */ '', channel);
      });
      const settled = current.catch((err) => { logger.warn({ to: pkt.to, err }, 'Preview send chain failed'); });
      this.sendChains.set(pkt.to, settled);
      settled.then(() => {
        if (this.sendChains.get(pkt.to) === settled) this.sendChains.delete(pkt.to);
      });
      await current;
      return;
    }

    const pktId = generateId('pkt');
    pkt.id = pktId;
    if (isPersistablePacket(pkt)) {
      try {
        storePacket(pktId, pkt, 'outbound', conversationKey, channel);
      } catch (err) {
        logger.warn({ pktId, to: pkt.to, err }, 'Failed to persist outbound packet');
      }
    }

    // Chain on any in-flight send for this recipient to serialize delivery
    const prev = this.sendChains.get(pkt.to) ?? Promise.resolve();
    const current = prev.then(() => this.sendOne(pkt, pktId, channel));
    const settled = current.catch((err) => { logger.warn({ to: pkt.to, err }, 'Send chain failed'); });
    this.sendChains.set(pkt.to, settled);
    // Clean up entry once chain settles (only if no newer chain was appended)
    settled.then(() => {
      if (this.sendChains.get(pkt.to) === settled) this.sendChains.delete(pkt.to);
    });
    await current;
  }

  private async sendOne(pkt: AnyPacket, pktId: string, channel?: string): Promise<void> {
    const handle = extractHandle(pkt.to);
    if (!handle) return; // Agent addresses have no transport handle
    const transport = this.deps.transports().find(
      (t) => t.ownsParticipant(handle) && t.isConnected(),
    );
    if (!transport) return;

    try {
      const outPkt = { ...pkt, to: handle } as AnyPacket;
      await transport.send(outPkt, { agentAddress: pkt.from, channel });
      if (isPersistablePacket(pkt) && !transport.deferredAck) markDelivered(pktId);
    } catch (err) {
      logger.warn({ pktId, to: handle, err }, 'Outbound delivery failed, queued for retry');
    }
  }

  /**
   * Drain all pending outbound packets for a recipient, oldest first.
   * Used only for startup recovery of undelivered packets.
   */
  private async drainOutboundForRecipient(toAddr: string): Promise<void> {
    const pending = getPendingOutboundForRecipient(toAddr);
    if (pending.length === 0) return;

    const handle = extractHandle(toAddr);
    if (!handle) return; // Agent addresses have no transport handle
    const transport = this.deps.transports().find(
      (t) => t.ownsParticipant(handle) && t.isConnected(),
    );
    if (!transport) return;

    for (const p of pending) {
      // Parse errors mean poison row — quarantine and skip. Looping on the
      // same unparseable payload would stall the whole drain forever.
      const pkt = parseJsonSafe(p.payload, AnyPacketSchema);
      if (!pkt) {
        logger.error({ pktId: p.id }, 'Recovery: skipping unparseable outbound payload');
        markDelivered(p.id);
        continue;
      }

      try {
        // Recover attachment hostPaths for conversation packets with attachment metadata
        if (pkt.type === 'conversation' && pkt.attachments) {
          const agentEntity = this.deps.bus.listEntities().find((e) => e.id === p.from_addr);
          if (agentEntity) {
            for (const att of pkt.attachments) {
              if (att.hash && !att.hostPath) {
                const ext = att.mimeType.split('/')[1] || 'bin';
                att.hostPath = attachmentHostPath(agentEntity.folderPath, att.hash, ext);
              }
            }
          }
        }

        const outPkt = { ...pkt, to: handle } as AnyPacket;
        await transport.send(outPkt, { agentAddress: p.from_addr });
        if (!transport.deferredAck) markDelivered(p.id);
      } catch (err) {
        logger.warn({ pktId: p.id, to: handle, err }, 'Outbound delivery failed, will retry on next send');
        break;
      }
    }
  }

  // =========================================================================
  // History queries
  // =========================================================================

  getHistory(
    agentAddr: string,
    participant: string,
    opts?: { limit?: number; channel?: string },
  ): StoredPacket[] {
    return getPacketHistory(agentAddr, participant, { limit: opts?.limit, channel: opts?.channel });
  }

  // =========================================================================
  // Crash recovery
  // =========================================================================

  /**
   * Re-deliver undelivered inbound packets.
   * Called once at startup — idempotent (already-delivered packets are skipped).
   */
  recoverPending(): void {
    const pending = getUndeliveredPackets('inbound');
    if (pending.length === 0) return;

    logger.info({ count: pending.length }, 'Recovery: re-delivering undelivered inbound packets');

    for (const p of pending) {
      const handler = this.deps.bus.resolve(p.to_addr);
      if (!handler) continue;

      // Parse errors mean poison row — quarantine and skip. Without this guard
      // a single corrupt payload throws out of the loop and stalls the whole
      // recovery pass for every later packet.
      const pkt = parseJsonSafe(p.payload, AnyPacketSchema);
      if (!pkt) {
        logger.error({ pktId: p.id }, 'Recovery: skipping unparseable inbound payload');
        markDelivered(p.id);
        continue;
      }

      // markDelivered before routeMessage — same as normal ingest path.
      // "delivered" means accepted into the gateway, not processed by the agent.
      // routeMessage is fire-and-forget; bus handlers are responsible for their own error handling.
      this.deps.bus.routeMessage(p.from_addr, p.to_addr, {
        type: 'ingested',
        text: pkt.text,
      });
      markDelivered(p.id);
    }
  }

  /**
   * Re-deliver undelivered outbound packets through transports.
   * Called after transports are connected at startup. Drains per-recipient
   * so message ordering is preserved within each conversation.
   */
  async recoverUndeliveredOutbound(): Promise<void> {
    const recipients = getUndeliveredOutboundRecipients();
    if (recipients.length === 0) return;

    logger.info({ recipientCount: recipients.length }, 'Recovery: draining undelivered outbound packets');

    for (const toAddr of recipients) {
      await this.drainOutboundForRecipient(toAddr);
    }
  }

  // =========================================================================
  // Approval response — thin inbound path (no identity/firewall/formatting)
  // =========================================================================

  ingestApprovalResponse(from: string, to: string, response: ApprovalResponsePayload): void {
    this.deps.bus.routeMessage(from, to, {
      type: 'approval_response',
      ...response,
    });
  }
}
