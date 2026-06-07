/**
 * Web transport — handles browser clients connecting via ws://host:port/web.
 *
 * Owns participant addresses starting with "web:". Supports text frames
 * (JSON messages) and binary frames (attachment upload/download).
 *
 * Message types (text frames):
 *   message, history  — same semantics as CLI transport
 *   register          — create identity + web: handle
 *   agents            — list agents accessible to caller's identity
 *   discover          — list all agents (localhost only)
 *
 * Binary frame format:
 *   [4 bytes: header length (uint32 BE)] [JSON header] [file bytes]
 */
import fs from 'fs';
import { randomBytes } from 'crypto';
import { WebSocket, type WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import { z } from 'zod';

import type { Bus, BusLifecycleEvent } from '../gateway/bus.js';
import type { MessageGateway } from '../gateway/message-gateway.js';
import type { AnyPacket } from '../gateway/packets.js';
import { markDeliveredIfAddressedTo } from '../gateway/gateway-db.js';
import type { IdentityProvider } from '../auth/identity.js';
import { persistAttachment } from '../lib/attachment-store.js';
import { MAX_ATTACHMENT_BYTES } from '../config.js';
import { isDeliverablePacket } from './packet-dispatch.js';
import { logger } from '../logger.js';
import type { Evt } from '../types.js';
import type { Transport, OutboundContext } from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingAttachment {
  agent: string;
  filename: string;
  mimeType: string;
  hostPath: string;
  hash: string;
  filesize: number;
}

/** Identity bound to this socket — wire handle and bare participant set together. */
interface WebClientIdentity {
  /** The socket's wire (`web:abc123`) — delivery-side only. */
  handle: string;
  /** Bare participant identity (`u:…@issuer`). Used to scope drained packets,
   *  label outbound events via ACL, and validate acks. Transport-blind: never
   *  carries the wire. */
  participant: string;
}

/**
 * Discriminated phase: a connection starts `unbound` and transitions to
 * `bound` once `register` or `agents` resolves an identity. Outbound event
 * routing is ACL-based — the identity is passed to `bus.projectEventForIdentity`,
 * which delegates to the originating agent's handler. The socket itself
 * no longer tracks a "last-selected agent."
 */
type WebClientBinding =
  | { phase: 'unbound' }
  | { phase: 'bound'; identity: WebClientIdentity };

interface WebClientState {
  ws: WebSocket;
  isLocalhost: boolean;
  pendingAttachments: PendingAttachment[];
  binding: WebClientBinding;
}

// ---------------------------------------------------------------------------
// Message schemas (text frames)
// ---------------------------------------------------------------------------

/**
 * Handle shape accepted from web clients. Rejects privileged prefixes
 * (`admin:*`, `cli:*`) which are reserved for the admin console and the
 * CLI transport respectively — both resolve to the `local` operator
 * identity via `idp.resolve` and bypass firewall + auto-registration via
 * `isOperatorHandle`. Allowing a web client to forge them would hand any
 * local-machine-reachable process operator privileges without pairing.
 *
 * The web transport's natural prefix is `web:*`; other prefixes (`tg:*`,
 * `email:*`) are owned by their own transports. We reject the two
 * privileged prefixes explicitly rather than whitelisting `web:*` — the
 * existing codebase treats `handle` as a free-form transport-local opaque
 * string, and restricting it to `web:*` would be a separate, wider change.
 */
const WebHandleSchema = z
  .string()
  .min(1)
  .refine(
    (h) => !h.startsWith('admin:') && !h.startsWith('cli:'),
    'Handle prefix reserved for privileged transport',
  );

const WebMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    handle: WebHandleSchema,
    agent: z.string().min(1),
    text: z.string().min(1),
    channel: z.string().min(1).optional(),
    qualifier: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('history'),
    handle: WebHandleSchema,
    agent: z.string().min(1),
    limit: z.number().int().positive().optional(),
    channel: z.string().min(1).optional(),
    qualifier: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('register'),
    name: z.string().min(1).max(255),
  }),
  z.object({
    type: z.literal('agents'),
    handle: WebHandleSchema,
  }),
  z.object({
    type: z.literal('discover'),
  }),
  z.object({
    type: z.literal('approval_response'),
    handle: WebHandleSchema,
    agent: z.string().min(1),
    id: z.string().min(1),
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('ack'),
    id: z.string().min(1),
  }),
]);

const BinaryHeaderSchema = z.object({
  agent: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
});

// ---------------------------------------------------------------------------
// WebTransport class
// ---------------------------------------------------------------------------

export interface WebTransportDeps {
  gateway: MessageGateway;
  bus: Bus;
  idp: IdentityProvider;
  wss: WebSocketServer;
}

export class WebTransport implements Transport {
  name = 'web';
  deferredAck = true;

  private deps: WebTransportDeps;
  private clients = new Set<WebClientState>();

  constructor(deps: WebTransportDeps) {
    this.deps = deps;
    this.wireWss();
    this.deps.bus.onLifecycle(this.onBusLifecycle);
  }

  /**
   * Bus lifecycle subscriber. Triggers a fresh `agents` push to every
   * bound client whenever an agent emits an `acl-change` update.
   *
   * Fan-out (not subject-tagged) is by design: the Bus event carries no
   * `identityId` — embedding policy/subject in a registry event would
   * break the bus's content-agnostic contract (`gateway/bus.ts:2`). The
   * transport collects connected identities and re-projects per-client.
   * At realistic web-ui scale (<20 concurrent identities) this is cheap.
   *
   * SIDE EFFECT: writes to every bound socket. Necessary because pairing
   * + future ACL edits live on disk; without this push, connected chat
   * clients would show stale sidebars until reload.
   */
  private readonly onBusLifecycle = (event: BusLifecycleEvent): void => {
    if (event.type !== 'updated') return;
    // Only ACL changes affect the per-identity accessible-agents projection.
    // MCP-server reconfiguration doesn't change wire-format `AgentSummary`,
    // so skip it. The typed cause replaces the previous
    // metadata-re-read filter.
    if (event.cause !== 'acl-changed') return;
    // Defense in depth: only agent handlers project. Service handlers don't
    // emit acl-changed today, but a future cause on a service entity would
    // bypass without this guard.
    if (this.deps.bus.getMetadata(event.address)?.type !== 'agent') return;
    const pushed = new Set<string>();
    for (const client of this.clients) {
      if (client.binding.phase !== 'bound') continue;
      const resolved = this.deps.idp.resolve(client.binding.identity.handle);
      if (!resolved || pushed.has(resolved.id)) continue;
      pushed.add(resolved.id);
      const list = this.deps.bus.listAccessibleAgents(resolved.id);
      this.pushToIdentity(resolved.id, { type: 'agents', list, name: resolved.declaredName });
    }
  };

  // --- Transport interface ---

  async send(pkt: AnyPacket, ctx: OutboundContext): Promise<void> {
    if (!isDeliverablePacket(pkt)) return;
    const targetChannel = ctx.channel || 'default';

    // Label the outgoing frame with the packet's agent alias (derived from bus metadata
    // for the canonical address). Clients echo this value back when they reply, so it
    // must match the alias they selected originally. Routing is still by handle
    // (pkt.to), not by the client's last-selected agent — this lets a client receive
    // messages for any agent they have access to on a freshly reconnected session.
    const agentAlias = this.agentAliasFor(ctx.agentAddress);
    if (!agentAlias) {
      logger.warn({ agentAddress: ctx.agentAddress }, 'Cannot resolve agent alias for outbound frame');
      return;
    }

    for (const client of this.clients) {
      if (client.binding.phase !== 'bound') continue;
      if (client.binding.identity.handle !== pkt.to) continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      try {
        client.ws.send(JSON.stringify({
          ...pkt,
          agent: agentAlias,
          channel: targetChannel,
        }));

        if (pkt.type === 'conversation' && pkt.attachments) {
          for (const att of pkt.attachments) {
            if (!att.hostPath || !att.hash) continue;
            try {
              const fileData = await fs.promises.readFile(att.hostPath);
              this.sendBinaryFrame(client.ws, {
                agent: ctx.agentAddress,
                hash: att.hash,
                filename: att.filename,
                mimeType: att.mimeType,
                direction: 'out',
              }, fileData);
            } catch (err) {
              logger.warn({ hash: att.hash, err }, 'Failed to send outbound attachment');
            }
          }
        }
      } catch {
        logger.debug('WebSocket send failed, removing web client');
        this.clients.delete(client);
      }
    }
  }

  /** Look up an agent's alias (manifest.name) from its canonical bus address. */
  private agentAliasFor(agentAddress: string): string | null {
    return this.deps.bus.getMetadata(agentAddress)?.label ?? null;
  }

  ownsParticipant(participantAddress: string): boolean {
    return participantAddress.startsWith('web:');
  }

  /**
   * Route a bus event to every bound client that should see it. Per-event
   * ACL gating delegates to `bus.projectEventForIdentity`, which in turn
   * asks the originating agent's handler (`AgentManager.projectEventForIdentity`).
   * Transport stays wire-only — no ACL, no folder reads.
   */
  async sendEvent(evt: Evt): Promise<void> {
    for (const client of this.clients) {
      if (client.binding.phase !== 'bound') continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      const resolved = this.deps.idp.resolve(client.binding.identity.handle);
      if (!resolved) continue;
      const decision = this.deps.bus.projectEventForIdentity(evt, resolved.id);
      if (!decision) continue;
      try {
        client.ws.send(JSON.stringify({
          ...evt,
          agent: decision.alias,
          channel: decision.channel,
        }));
      } catch {
        this.clients.delete(client);
      }
    }
  }

  async connect(): Promise<void> {
    // Lifecycle managed by factory
  }

  async disconnect(): Promise<void> {
    // WebSocket close code 1001 ("going away") so the browser tab knows the
    // server is shutting down vs. a transient connection error.
    for (const client of this.clients) {
      try { client.ws.close(1001, 'Server shutting down'); } catch { /* socket may be dead */ }
    }
    this.clients.clear();
    this.deps.bus.offLifecycle(this.onBusLifecycle);
  }

  isConnected(): boolean {
    return true;
  }

  // --- Internal ---

  private wireWss(): void {
    const { wss } = this.deps;

    wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
      const remoteAddr = request.socket.remoteAddress || '';
      const isLocalhost = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';

      const client: WebClientState = {
        ws,
        isLocalhost,
        pendingAttachments: [],
        binding: { phase: 'unbound' },
      };
      this.clients.add(client);
      logger.info({ isLocalhost }, 'Web client connected');

      ws.on('message', (raw: Buffer, isBinary: boolean) => {
        if (isBinary) {
          this.handleBinaryFrame(client, raw);
          return;
        }
        this.handleTextFrame(client, raw.toString());
      });

      ws.on('close', () => {
        this.clients.delete(client);
        logger.info('Web client disconnected');
      });

      ws.on('error', (err) => {
        logger.error({ err }, 'Web client error');
        this.clients.delete(client);
      });
    });

    wss.on('error', (err) => {
      logger.error({ err }, 'Web WSS error');
    });
  }

  private handleTextFrame(client: WebClientState, str: string): void {
    try {
      const parsed = JSON.parse(str);
      const data = WebMessageSchema.parse(parsed);

      switch (data.type) {
        case 'register':
          this.handleRegister(client, data.name);
          break;
        case 'agents':
          this.handleAgents(client, data.handle);
          break;
        case 'discover':
          this.handleDiscover(client);
          break;
        case 'message':
          this.handleMessage(client, data);
          break;
        case 'history':
          this.handleHistory(client, data);
          break;
        case 'approval_response':
          this.handleApprovalResponse(client, data);
          break;
        case 'ack':
          this.handleAck(client, data.id);
          break;
      }
    } catch (err) {
      const message = err instanceof SyntaxError
        ? 'Invalid JSON'
        : err instanceof z.ZodError
          ? `Invalid message: ${err.issues.map((i) => i.message).join(', ')}`
          : err instanceof Error
            ? err.message
            : String(err);
      logger.error({ err, raw: str }, 'Web message error');
      client.ws.send(JSON.stringify({ type: 'error', text: message }));
    }
  }

  private handleRegister(client: WebClientState, name: string): void {
    const handleId = `web:${randomBytes(5).toString('hex')}`;
    const resolved = this.deps.idp.register(handleId, name, 'web');
    client.binding = {
      phase: 'bound',
      identity: { handle: handleId, participant: resolved.id },
    };
    logger.info({ handle: handleId, identity: resolved.id }, 'Web identity registered');
    client.ws.send(JSON.stringify({
      type: 'register',
      handle: handleId,
      identity: resolved.id,
      name: resolved.declaredName,
    }));
  }

  private handleAgents(client: WebClientState, handle: string): void {
    const resolved = this.deps.idp.resolve(handle);
    if (!resolved) {
      client.ws.send(JSON.stringify({ type: 'error', text: 'Unknown handle' }));
      return;
    }

    // Bind identity onto the client; drain any packets queued while they were away.
    // handleAgents is the canonical "I'm back" signal — the client sends it on every
    // successful (re)connect, see packages/web-ui/src/chat/lib/store.ts effect in init.
    const wasUnbound = client.binding.phase === 'unbound';
    const handleChanged = client.binding.phase === 'bound' && client.binding.identity.handle !== handle;
    const firstBind = wasUnbound || handleChanged;
    client.binding = {
      phase: 'bound',
      identity: { handle, participant: resolved.id },
    };
    if (firstBind) {
      void this.drainUndelivered(client).catch((err) => {
        logger.warn({ handle, err }, 'Drain of undelivered packets failed');
      });
    }
    const list = this.deps.bus.listAccessibleAgents(resolved.id);
    client.ws.send(JSON.stringify({ type: 'agents', list, name: resolved.declaredName }));
  }

  /**
   * Pure wire-level fan-out primitive. Sends `payload` to every connected
   * socket whose resolved identity equals `identityId`. No policy, no ACL,
   * no agent-folder reads — those live in `Bus.listAccessibleAgents` and
   * `AgentManager.projectForIdentity`.
   *
   * SIDE EFFECT: writes to each matching WS. Safe to call when no client
   * is currently bound to that identity — the loop simply finds zero
   * matches.
   */
  private pushToIdentity(identityId: string, payload: unknown): void {
    for (const client of this.clients) {
      if (client.binding.phase !== 'bound') continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      const resolved = this.deps.idp.resolve(client.binding.identity.handle);
      if (!resolved || resolved.id !== identityId) continue;
      try {
        client.ws.send(JSON.stringify(payload));
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private handleDiscover(client: WebClientState): void {
    if (!client.isLocalhost) {
      client.ws.send(JSON.stringify({ type: 'error', text: 'Discover is only available from localhost' }));
      return;
    }

    const entities = this.deps.bus.listEntities({ type: 'agent' });
    const list = entities.map((e) => ({
      alias: e.label,
      address: e.id,
      description: e.description,
    }));

    client.ws.send(JSON.stringify({ type: 'discover', list }));
  }

  private handleMessage(
    client: WebClientState,
    data: { handle: string; agent: string; text: string; channel?: string; qualifier?: string },
  ): void {
    const agentId = this.deps.bus.resolveAddress(data.agent);
    if (!agentId) {
      client.ws.send(JSON.stringify({ type: 'error', text: `Unknown agent "${data.agent}"` }));
      return;
    }

    // Reject messages from handles the IdP doesn't know — onboarding goes
    // through the dedicated `register` flow, never through implicit creation
    // here. Browser surfaces the error and can clear localStorage to re-register.
    const resolved = this.deps.idp.resolve(data.handle);
    if (!resolved) {
      client.ws.send(JSON.stringify({ type: 'error', text: 'Unknown handle, please register' }));
      return;
    }

    const senderName = resolved.declaredName;
    client.binding = {
      phase: 'bound',
      identity: { handle: data.handle, participant: resolved.id },
    };

    // Drain stashed attachments matching this agent only
    let attachments: { filename: string; mimeType: string; hostPath: string; hash: string; filesize: number }[] | undefined;
    if (client.pendingAttachments.length > 0) {
      const matching: PendingAttachment[] = [];
      const remaining: PendingAttachment[] = [];
      for (const a of client.pendingAttachments) {
        (a.agent === data.agent ? matching : remaining).push(a);
      }
      client.pendingAttachments = remaining;
      if (matching.length > 0) {
        attachments = matching.map((a) => ({
          filename: a.filename, mimeType: a.mimeType,
          hostPath: a.hostPath, hash: a.hash, filesize: a.filesize,
        }));
      }
    }

    // Intercept /approve and /reject commands → approval_response
    const approveMatch = data.text.match(/^\/approve\s+(\S+)/);
    if (approveMatch) {
      this.deps.gateway.ingestApprovalResponse(data.handle, agentId, { id: approveMatch[1]!, decision: 'approved' });
      return;
    }
    const rejectMatch = data.text.match(/^\/reject\s+(\S+)(?:\s+(.+))?/);
    if (rejectMatch) {
      this.deps.gateway.ingestApprovalResponse(data.handle, agentId, { id: rejectMatch[1]!, decision: 'rejected', reason: rejectMatch[2] });
      return;
    }

    this.deps.gateway.ingestInbound(
      data.handle,
      agentId,
      data.text,
      senderName,
      { channel: data.channel, qualifier: data.qualifier },
      attachments,
    );
  }

  private handleHistory(
    client: WebClientState,
    data: { handle: string; agent: string; limit?: number; channel?: string; qualifier?: string },
  ): void {
    const agentId = this.deps.bus.resolveAddress(data.agent);
    if (!agentId) {
      client.ws.send(JSON.stringify({ type: 'error', text: `Unknown agent "${data.agent}"` }));
      return;
    }

    const handle = data.handle;
    const resolved = this.deps.idp.resolve(handle);
    // Gateway packets are keyed on the bare participant identity.
    const participant = resolved ? resolved.id : handle;

    const raw = this.deps.gateway.getHistory(agentId, participant, { limit: data.limit });
    const HistoryPayloadSchema = z.object({
      text: z.string().optional(),
      sessionHash: z.string().nullish(),
    }).loose();
    const entries = raw.map((r) => {
      const pkt = HistoryPayloadSchema.parse(JSON.parse(r.payload));
      return {
        id: r.id, type: r.type, from_addr: r.from_addr, to_addr: r.to_addr,
        text: pkt.text ?? '', timestamp: r.timestamp,
        session_hash: pkt.sessionHash ?? null,
      };
    });
    client.ws.send(JSON.stringify({ type: 'history', entries }));
  }

  private handleApprovalResponse(
    client: WebClientState,
    data: { handle: string; agent: string; id: string; decision: 'approved' | 'rejected'; reason?: string },
  ): void {
    const agentId = this.deps.bus.resolveAddress(data.agent);
    if (!agentId) return;

    // Same rule as handleMessage — approval responses from unknown handles
    // are rejected (gateway is the actual authority, but client-side state
    // should never end up half-bound).
    const resolved = this.deps.idp.resolve(data.handle);
    if (!resolved) {
      client.ws.send(JSON.stringify({ type: 'error', text: 'Unknown handle, please register' }));
      return;
    }

    client.binding = {
      phase: 'bound',
      identity: { handle: data.handle, participant: resolved.id },
    };

    this.deps.gateway.ingestApprovalResponse(data.handle, agentId, {
      id: data.id,
      decision: data.decision,
      reason: data.reason,
    });
  }

  private handleAck(client: WebClientState, pktId: string): void {
    if (client.binding.phase !== 'bound') {
      logger.debug({ pktId }, 'Ignoring ack from unbound client');
      return;
    }
    const recipient = client.binding.identity.participant;
    const ok = markDeliveredIfAddressedTo(pktId, recipient);
    if (!ok) {
      logger.debug({ pktId, to: recipient }, 'Ack for unknown or unowned packet');
    }
  }

  /**
   * Drain undelivered outbound packets for this client's identity — a nudge
   * into the gateway's delivery worker, which replays through the normal
   * send() path so live and replayed delivery are indistinguishable on the
   * wire. delivered_at stays NULL until the client acks — if they disconnect
   * before acking, the packets resurface on the next reconnect.
   */
  private async drainUndelivered(client: WebClientState): Promise<void> {
    if (client.binding.phase !== 'bound') return;
    await this.deps.gateway.nudgeRecipient(client.binding.identity.participant);
  }

  // --- Binary frame handling ---

  private handleBinaryFrame(client: WebClientState, raw: Buffer): void {
    if (raw.length < 4) {
      client.ws.send(JSON.stringify({ type: 'error', text: 'Binary frame too short' }));
      return;
    }

    const headerLen = raw.readUInt32BE(0);
    if (4 + headerLen > raw.length) {
      client.ws.send(JSON.stringify({ type: 'error', text: 'Invalid binary frame header length' }));
      return;
    }

    let header: z.infer<typeof BinaryHeaderSchema>;
    try {
      header = BinaryHeaderSchema.parse(JSON.parse(raw.subarray(4, 4 + headerLen).toString('utf-8')));
    } catch {
      client.ws.send(JSON.stringify({ type: 'error', text: 'Invalid binary frame header' }));
      return;
    }

    const fileBytes = raw.subarray(4 + headerLen);
    if (fileBytes.length > MAX_ATTACHMENT_BYTES) {
      client.ws.send(JSON.stringify({
        type: 'error',
        text: `Attachment too large (${(fileBytes.length / 1_048_576).toFixed(1)}MB, limit ${MAX_ATTACHMENT_BYTES / 1_048_576}MB)`,
      }));
      return;
    }

    const agentFolder = this.resolveAgentFolder(header.agent);
    if (!agentFolder) {
      client.ws.send(JSON.stringify({ type: 'error', text: `Unknown agent "${header.agent}"` }));
      return;
    }

    try {
      const persisted = persistAttachment(agentFolder, fileBytes, header.mimeType);
      logger.info({
        agent: header.agent,
        filename: header.filename,
        hash: persisted.hash,
        size: fileBytes.length,
        deduplicated: persisted.deduplicated,
      }, 'Web attachment persisted');

      // Stash for the next text message from this client
      client.pendingAttachments.push({
        agent: header.agent,
        filename: header.filename,
        mimeType: header.mimeType,
        hostPath: persisted.hostPath,
        hash: persisted.hash,
        filesize: fileBytes.length,
      });

      client.ws.send(JSON.stringify({
        type: 'attachment_ack',
        hash: persisted.hash,
        filename: header.filename,
        mimeType: header.mimeType,
      }));
    } catch (err) {
      logger.error({ err, agent: header.agent }, 'Failed to persist web attachment');
      client.ws.send(JSON.stringify({ type: 'error', text: 'Failed to persist attachment' }));
    }
  }

  private sendBinaryFrame(
    ws: WebSocket,
    header: Record<string, string>,
    fileBytes: Buffer,
  ): void {
    const headerBuf = Buffer.from(JSON.stringify(header), 'utf-8');
    const frame = Buffer.alloc(4 + headerBuf.length + fileBytes.length);
    frame.writeUInt32BE(headerBuf.length, 0);
    headerBuf.copy(frame, 4);
    fileBytes.copy(frame, 4 + headerBuf.length);
    ws.send(frame, { binary: true });
  }

  private resolveAgentFolder(agentLabel: string): string | null {
    const entities = this.deps.bus.listEntities({ type: 'agent' });
    const entity = entities.find((e) => e.label === agentLabel);
    return entity?.folderPath ?? null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebTransport(deps: WebTransportDeps): WebTransport {
  return new WebTransport(deps);
}
