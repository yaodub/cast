/**
 * MessageGateway — bidirectional client boundary.
 *
 * Owns inbound ingestion (store packet, format, route to bus), outbound delivery
 * (store packet, find transport, send), transport binding table, and history queries.
 *
 * Implements BusHandler for transport-bound addresses (cli:*, tg:*).
 */
import { z } from 'zod';

import { extractHandle, isExtAddress, isOperatorHandle } from '../auth/address.js';
import { storePacket, markDelivered, markFailed, getPacketHistory, getUndeliveredPackets, getPendingOutboundForRecipient } from './gateway-db.js';
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
import {
  MAX_ATTACHMENT_BYTES,
  OUTBOUND_ACK_REDUE_MS,
  OUTBOUND_DELIVERY_TTL_MS,
  OUTBOUND_RETRY_BACKOFF_MS,
  OUTBOUND_WORKER_TICK_MS,
} from '../config.js';
import { isPersistablePacket } from '../transports/packet-dispatch.js';
import type { Attachment, ApprovalResponsePayload, Evt } from '../types.js';
import type { Transport, OutboundContext } from '../transports/schema.js';

// --- Bus payload schema (validated at handler boundary) ---

const GatewayBusPayloadSchema = z.object({
  pkt: AnyPacketSchema,
  channel: z.string().optional(),
  conversationKey: z.string().optional(),
});

// --- Outbound delivery types ---

/** Result of a single transport send attempt. */
type SendOutcome =
  | { kind: 'delivered' }             // transport confirmed synchronously; packet marked
  | { kind: 'awaiting-ack' }          // sent over a deferred-ack transport; the client ack marks
  | { kind: 'no-wire' }               // no connected transport owns the recipient right now
  | { kind: 'failed'; err: unknown }; // transport send threw

/** In-memory retry state for one pending packet. */
type RetryState = { attempts: number; dueAt: number };

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
    const handle = this.resolveWire(evt.to);
    if (!handle) return; // agent address, or a user identity with no reachable wire
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
   * 5. Build + persist ConversationPkt
   * 6. Format as XML
   * 7. Forward via bus.routeMessage() with resolved from address + declaredName
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
    // G2: an `ext:*` address is an agent-internal injection origin,
    // never a transport sender — it must never be registered as an identity.
    let resolved = idp.resolve(from);
    if (!resolved && !isOperatorHandle(from) && !isExtAddress(from)) {
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

    // Resolve target agent — needed for the firewall check.
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

    // Transport-blind boundary: above the gateway the participant is the bare
    // identity. The source wire (`from`) survives only as per-turn payload
    // metadata (`sourceHandle`) and in this gateway's own packet store; reply
    // delivery recovers the wire via `resolveWire` (IdP lookup).
    const resolvedFrom = resolved ? resolved.id : from;
    const declaredName = resolved?.declaredName ?? senderName;

    // Owner-claim redemption. `/claim <code>` binds the sender as
    // the agent's owner. Intercepted here — after the firewall, before the
    // conversation packet is built and routed to the runner — so the bearer code
    // never reaches the agent's LLM. Routed as an `owner-claim` control packet
    // the AgentManager's bus handler terminates host-side (redeem against the
    // owner_claims store, write acl.json). Deliberately bypasses the ACL `i`-bit:
    // a not-yet-recognized human must be able to claim ownership to bootstrap it,
    // and the code is the capability. The server firewall above still gates
    // reachability, so a non-exposed agent is unclaimable by an external sender.
    if (trimmed === '/claim' || trimmed.startsWith('/claim ')) {
      const code = trimmed.slice('/claim'.length).trim();
      if (!code) {
        this.sendSystemReply(to, from, 'Usage: /claim <code>');
        return;
      }
      this.deps.bus.routeMessage(resolvedFrom, to, {
        type: 'owner-claim',
        code,
        channel: routing?.channel ?? 'default',
      });
      return;
    }

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
      sourceHandle: from,
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

  /** Per-recipient send chains — serializes outbound sends to prevent concurrent double-delivery. */
  private sendChains = new Map<string, Promise<void>>();

  /** Per-streamId latest snapshot (kind: 'text' only in v1) — read-and-cleared
   *  by the first chain entry that drains. Subsequent peer entries find an
   *  empty map and no-op. This is the coalesce mechanism for previews. */
  private latestPreview = new Map<string, string>();

  /** Per-packet retry state — in-memory only. A restart resets backoff to
   *  "due now", which is the correct boot schedule anyway; the durable facts
   *  (pending / delivered / failed) live in gateway.db. */
  private retrySchedule = new Map<string, RetryState>();

  /**
   * Serialize a delivery task onto the recipient's send chain — the single
   * guard against concurrent double-delivery to one recipient. Live sends,
   * worker ticks, and reconnect nudges all enter through here.
   */
  private chainForRecipient(to: string, task: () => Promise<void>): Promise<void> {
    const prev = this.sendChains.get(to) ?? Promise.resolve();
    const current = prev.then(task);
    const settled = current.catch((err) => { logger.warn({ to, err }, 'Send chain failed'); });
    this.sendChains.set(to, settled);
    // Clean up entry once chain settles (only if no newer chain was appended)
    settled.then(() => {
      if (this.sendChains.get(to) === settled) this.sendChains.delete(to);
    });
    return current;
  }

  /**
   * Deliver an outbound packet (agent → participant) through the transport layer.
   * Persists the packet first, then drains all pending outbound packets for this
   * recipient in timestamp order — so older failed messages are retried before
   * newer ones, preserving conversation order.
   */
  async deliverOutbound(pkt: AnyPacket, channel?: string, conversationKey?: string): Promise<void> {
    // Preview text path — ephemeral + coalesced. Skip persistence; queue a
    // chain entry that reads the latest snapshot for this streamId at drain
    // time. Other preview kinds (none in v1) will need separate policies.
    if (pkt.type === 'preview' && pkt.kind === 'text') {
      this.latestPreview.set(pkt.streamId, pkt.text);
      await this.chainForRecipient(pkt.to, async () => {
        const latest = this.latestPreview.get(pkt.streamId);
        if (latest === undefined) return;
        this.latestPreview.delete(pkt.streamId);
        const drained = { ...pkt, text: latest } as AnyPacket;
        await this.sendOne(drained, /* pktId */ '', channel);
      });
      return;
    }

    const pktId = generateId('pkt');
    pkt.id = pktId;
    if (isPersistablePacket(pkt)) {
      try {
        storePacket(pktId, pkt, 'outbound', conversationKey, channel);
      } catch (err) {
        // Persist failed — fall back to a direct one-shot send so the message
        // still gets its delivery chance (it can't enter the retry pool).
        logger.warn({ pktId, to: pkt.to, err }, 'Failed to persist outbound packet');
        await this.chainForRecipient(pkt.to, async () => { await this.sendOne(pkt, pktId, channel); });
        return;
      }
      await this.nudgeRecipient(pkt.to);
      return;
    }

    await this.chainForRecipient(pkt.to, async () => { await this.sendOne(pkt, pktId, channel); });
  }

  /**
   * Make a recipient's pending packets due immediately and drain them through
   * the send chain. Live sends and web reconnects funnel here: fresh activity
   * for a recipient is evidence the wire is worth retrying now, ahead of the
   * worker's backoff schedule.
   */
  async nudgeRecipient(toAddr: string): Promise<void> {
    return this.chainForRecipient(toAddr, async () => {
      for (const p of getPendingOutboundForRecipient(toAddr)) this.retrySchedule.delete(p.id);
      await this.drainRecipientPending(toAddr);
    });
  }

  /**
   * Resolve the delivery wire (transport handle) for an outbound `to` address.
   * Backward-compatible with the compound form; the bare-identity branch is the
   * transport-blind path: a bare `u:` user has its handle recovered from the IdP
   * (one today, multi-transport-ready). Operator handles (`cli:`/`admin:`) and
   * compounds already yield the wire directly. Agent addresses have no wire.
   */
  private resolveWire(to: string): string | undefined {
    const handle = extractHandle(to);
    if (!handle) return undefined; // agent address — no transport handle
    if (handle.startsWith('u:')) {
      // `to` was a bare user identity (no handle in the address) — recover the wire.
      return this.deps.identityProvider.getHandlesForIdentity(handle)[0];
    }
    return handle;
  }

  private async sendOne(pkt: AnyPacket, pktId: string, channel?: string): Promise<SendOutcome> {
    const handle = this.resolveWire(pkt.to);
    if (!handle) return { kind: 'no-wire' }; // agent address, or a user identity with no reachable wire
    const transport = this.deps.transports().find(
      (t) => t.ownsParticipant(handle) && t.isConnected(),
    );
    if (!transport) return { kind: 'no-wire' };

    try {
      const outPkt = { ...pkt, to: handle } as AnyPacket;
      await transport.send(outPkt, { agentAddress: pkt.from, channel });
    } catch (err) {
      return { kind: 'failed', err };
    }

    if (transport.deferredAck) return { kind: 'awaiting-ack' };
    if (isPersistablePacket(pkt)) markDelivered(pktId);
    return { kind: 'delivered' };
  }

  /** Re-attach content-addressed attachment paths to a recovered packet —
   *  gateway.db payloads don't persist hostPaths, but the attachment store
   *  keeps the bytes indefinitely by hash. */
  private rehydrateAttachments(pkt: AnyPacket, fromAddr: string): void {
    if (pkt.type !== 'conversation' || !pkt.attachments) return;
    const agentEntity = this.deps.bus.listEntities().find((e) => e.id === fromAddr);
    if (!agentEntity) return;
    for (const att of pkt.attachments) {
      if (att.hash && !att.hostPath) {
        const ext = att.mimeType.split('/')[1] || 'bin';
        att.hostPath = attachmentHostPath(agentEntity.folderPath, att.hash, ext);
      }
    }
  }

  /**
   * Drain a recipient's pending outbound packets, oldest first — the single
   * delivery implementation behind live sends, worker ticks, and reconnect
   * nudges. Always called on the recipient's send chain. Stops at the first
   * packet that can't deliver so per-conversation order is preserved;
   * TTL-expired and poison packets are marked failed (terminal, loud) and
   * skipped over.
   */
  private async drainRecipientPending(toAddr: string): Promise<void> {
    for (const p of getPendingOutboundForRecipient(toAddr)) {
      const age = Date.now() - Date.parse(p.timestamp);
      if (age > OUTBOUND_DELIVERY_TTL_MS) {
        markFailed(p.id);
        this.retrySchedule.delete(p.id);
        logger.warn({ pktId: p.id, to: toAddr, ageMs: age }, 'Outbound packet expired undelivered — marked failed');
        this.deps.logHostEvent?.('warn', 'gateway', 'outbound_expired',
          `Outbound packet expired undelivered after ${Math.round(age / 60_000)}m`,
          { toAddr, context: { pktId: p.id, ageMs: age } });
        continue;
      }

      // Not due yet — later packets wait behind it so conversation order holds.
      const sched = this.retrySchedule.get(p.id);
      if (sched && sched.dueAt > Date.now()) return;

      // Parse errors mean poison row — a payload that no longer parses can
      // never deliver. Mark failed so the drain can't stall on it forever.
      const pkt = parseJsonSafe(p.payload, AnyPacketSchema);
      if (!pkt) {
        markFailed(p.id);
        this.retrySchedule.delete(p.id);
        logger.error({ pktId: p.id }, 'Unparseable outbound payload — marked failed');
        continue;
      }

      this.rehydrateAttachments(pkt, p.from_addr);
      const outcome = await this.sendOne(pkt, p.id, p.channel ?? undefined);
      switch (outcome.kind) {
        case 'delivered':
          if (sched) logger.info({ pktId: p.id, to: toAddr, attempts: sched.attempts }, 'Outbound packet delivered after retry');
          this.retrySchedule.delete(p.id);
          break;
        case 'awaiting-ack':
          // Sent over a deferred-ack transport; the client ack marks delivery.
          // Re-due far out so a lost ack self-heals — the web client dedups by
          // packet id and re-acks duplicates, so a re-send is harmless.
          this.retrySchedule.set(p.id, {
            attempts: (sched?.attempts ?? 0) + 1,
            dueAt: Date.now() + OUTBOUND_ACK_REDUE_MS,
          });
          break;
        case 'no-wire':
          // Recipient unreachable right now (no connected transport owns it).
          // Nothing to schedule per-packet — the worker re-checks every tick.
          return;
        case 'failed':
          this.noteFailedAttempt(p.id);
          logger.warn({ pktId: p.id, to: toAddr, err: outcome.err }, 'Outbound delivery failed — retry scheduled');
          return;
      }
    }
  }

  /** Record a failed attempt and schedule the next one on the backoff curve. */
  private noteFailedAttempt(pktId: string): void {
    const attempts = (this.retrySchedule.get(pktId)?.attempts ?? 0) + 1;
    const idx = Math.min(attempts - 1, OUTBOUND_RETRY_BACKOFF_MS.length - 1);
    const backoff = OUTBOUND_RETRY_BACKOFF_MS[idx] ?? 5_000; // ?? unreachable — Math.min keeps idx in range
    this.retrySchedule.set(pktId, { attempts, dueAt: Date.now() + backoff });
  }

  // =========================================================================
  // Outbound delivery worker
  // =========================================================================

  private workerTimer: NodeJS.Timeout | null = null;

  /**
   * Start the delivery worker. The first pass runs immediately — boot recovery
   * is not a separate code path, just the worker's first tick over whatever
   * the previous process lifetime left pending.
   */
  startDeliveryWorker(): void {
    if (this.workerTimer) return;
    void this.runDeliveryPass();
    this.workerTimer = setInterval(() => { void this.runDeliveryPass(); }, OUTBOUND_WORKER_TICK_MS);
    this.workerTimer.unref();
  }

  stopDeliveryWorker(): void {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
  }

  /** One delivery pass: prune retry state for packets that left the pending
   *  set (delivered, acked, or expired), then drain every recipient with
   *  pending packets — due-ness is enforced per-packet inside the drain. */
  async runDeliveryPass(): Promise<void> {
    try {
      const pending = getUndeliveredPackets('outbound');
      const pendingIds = new Set(pending.map((p) => p.id));
      for (const id of this.retrySchedule.keys()) {
        if (!pendingIds.has(id)) this.retrySchedule.delete(id);
      }
      const recipients = new Set(pending.map((p) => p.to_addr));
      for (const to of recipients) {
        await this.chainForRecipient(to, () => this.drainRecipientPending(to));
      }
    } catch (err) {
      logger.error({ err }, 'Delivery worker tick failed');
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
  // Crash recovery (inbound only — outbound recovery is the delivery
  // worker's first tick, not a separate path)
  // =========================================================================

  /**
   * Re-deliver undelivered inbound packets.
   * Called once at startup — idempotent (already-delivered packets are skipped).
   * Near-dead code by design: normal ingest marks delivery in the same tick it
   * stores, so only a crash between those two writes leaves a row here.
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
