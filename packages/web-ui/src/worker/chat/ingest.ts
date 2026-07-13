/**
 * Chat packet ingest — translates Cast WS server messages into ConnectionState
 * mutations + IDB persistence + scope broadcasts.
 *
 * Replaces the per-tab `handleMessage` / `handleApprovalRequest` /
 * `handleApprovalAck` triplet from `chat/lib/store.ts`. Single ingest point
 * per identity means no more "two tabs both wrote to IDB and one swallowed
 * the live render" race — there's only one tab-side write path now.
 */

import { LIFECYCLE_LABELS } from '../../lib/lifecycle-labels';
import { ServerMessage } from '../../lib/protocol';
import type {
  AgentsPayload,
  ApprovalAckPayload,
  ApprovalRequestPayload,
  ApprovalStalePayload,
  AttachmentAckPayload,
  BinaryFrameHeader,
  DiscoverPayload,
  ErrorPayload,
  LifecyclePayload,
  MessagePayload,
  PreviewPayload,
  TypingPayload,
  TypingStoppedPayload,
} from '../../lib/protocol';
import type { ConnectionState } from '../connection-state';
import type { StoredMessage, Toast } from '../protocol';
import {
  broadcastMutation,
  hasViewerForConversation,
  store,
} from '../state';

const TOAST_DURATION_MS = 5000;
const TOAST_MAX = 3;

/** Ingest a single parsed packet. Acks / IDB writes / broadcasts happen here. */
export async function ingestPacket(conn: ConnectionState, raw: unknown): Promise<void> {
  const result = ServerMessage.safeParse(raw);
  if (!result.success) {
    console.warn('[worker/chat] invalid packet', result.error.issues);
    return;
  }
  const packet = result.data;
  switch (packet.type) {
    case 'conversation': await ingestConversation(conn, packet); break;
    case 'preview': ingestPreview(conn, packet); break;
    case 'approval_request': await ingestApprovalRequest(conn, packet); break;
    case 'approval_ack': await ingestApprovalAck(conn, packet); break;
    case 'approval_stale': ingestApprovalStale(conn, packet); break;
    case 'agents': ingestAgents(conn, packet); break;
    case 'discover': ingestDiscover(conn, packet); break;
    case 'typing': ingestTyping(conn, packet); break;
    case 'typing_stopped': ingestTypingStopped(conn, packet); break;
    case 'lifecycle': ingestLifecycle(conn, packet); break;
    case 'error': ingestError(conn, packet); break;
    case 'attachment_ack': ingestAttachmentAck(conn, packet); break;
    case 'register':
      // Persistent identity WS shouldn't see register replies (those come on
      // the temporary register WS during fresh-registration). Log and drop.
      console.warn('[worker/chat] unexpected register packet on bound WS', { identity: conn.identity });
      break;
    case 'history':
      // Worker hydrates history from IDB; never requests `history` from the WS.
      break;
  }
}

export async function ingestBinary(_conn: ConnectionState, header: unknown, bytes: Uint8Array): Promise<void> {
  const parsed = parseBinaryHeader(header);
  if (!parsed) return;
  await store.putAttachment(parsed.hash, bytes, parsed.mimeType, parsed.filename);
}

function parseBinaryHeader(header: unknown): BinaryFrameHeader | null {
  if (typeof header !== 'object' || header === null) return null;
  const h = header as Record<string, unknown>;
  if (
    typeof h.agent !== 'string' ||
    typeof h.hash !== 'string' ||
    typeof h.filename !== 'string' ||
    typeof h.mimeType !== 'string' ||
    (h.direction !== 'in' && h.direction !== 'out')
  ) return null;
  return {
    agent: h.agent,
    hash: h.hash,
    filename: h.filename,
    mimeType: h.mimeType,
    direction: h.direction,
  };
}

// ---------------------------------------------------------------------------
// Conversation messages
// ---------------------------------------------------------------------------

async function ingestConversation(conn: ConnectionState, packet: MessagePayload): Promise<void> {
  const agent = packet.agent ?? extractAgentFallback(packet.from);
  if (!agent) return;
  const channel = packet.channel ?? 'default';
  const id = packet.id ?? `rt-${packet.timestamp}`;

  if (conn.processedIds.has(id)) {
    // Already ingested in this worker session — ack and skip.
    sendAck(conn, id);
    return;
  }

  // Seal-inherit: a durable packet terminating a preview stream takes the
  // stream's first-seen timestamp. The server stamps the seal with `new Date()`,
  // which is later than the user-sent messages that arrived during the stream;
  // inheriting holds the bubble in its chronological position.
  const streamStart = packet.streamId
    ? conn.conversations.get(`${agent}:${channel}`)?.previews.get(packet.streamId)?.firstSeenAt
    : undefined;

  const stored: StoredMessage = {
    id,
    identity: conn.identity,
    agent,
    channel,
    from: packet.from,
    to: packet.to,
    text: packet.text,
    timestamp: streamStart ?? packet.timestamp,
    sessionHash: packet.sessionHash ?? null,
    attachments: packet.attachments,
    ...(packet.streamId ? { streamId: packet.streamId } : {}),
  };

  const alreadyStored = await store.has(stored.id);
  if (!alreadyStored) await store.put(stored);
  sendAck(conn, stored.id);
  if (alreadyStored) return;
  conn.processedIds.add(stored.id);

  // If we don't already know this agent, the next refresh-agents will pick it up.
  // Skipping the explicit refresh — the alias→address map updates on bind/unbind
  // events upstream and the sidebar re-renders when chat-identity scope mutates.

  if (hasViewerForConversation(conn.identity, agent, channel)) {
    const cache = conn.conversationCache(agent, channel);
    if (packet.streamId) cache.previews.delete(packet.streamId);
    cache.messages.push(stored);
    cache.typing = false;
    cache.lifecycle = null;
    broadcastMutation({ kind: 'chat-conversation', identity: conn.identity, agent, channel });
  } else {
    conn.bumpUnread(agent, channel);
    pushToast(conn, {
      id: stored.id,
      agent,
      channel,
      from: packet.from,
      preview: packet.text.slice(0, 100),
      timestamp: packet.timestamp,
    });
    broadcastMutation({ kind: 'chat-identity', identity: conn.identity });
  }
}

function ingestPreview(conn: ConnectionState, packet: PreviewPayload): void {
  const agent = packet.agent ?? extractAgentFallback(packet.from);
  if (!agent) return;
  const channel = packet.channel ?? 'default';
  if (!hasViewerForConversation(conn.identity, agent, channel)) return;
  const cache = conn.conversationCache(agent, channel);
  if (packet.final) {
    cache.previews.delete(packet.streamId);
  } else {
    // Preserve firstSeenAt across chunks — the server stamps each frame
    // with a fresh `new Date()`, so blindly taking packet.timestamp would
    // make the bubble drift forward in time as it streams.
    const existing = cache.previews.get(packet.streamId);
    cache.previews.set(packet.streamId, {
      text: packet.text,
      firstSeenAt: existing?.firstSeenAt ?? packet.timestamp,
    });
  }
  broadcastMutation({ kind: 'chat-conversation', identity: conn.identity, agent, channel });
}

async function ingestApprovalRequest(conn: ConnectionState, packet: ApprovalRequestPayload): Promise<void> {
  const agent = packet.agent ?? extractAgentFallback(packet.from);
  if (!agent) return;
  const channel = packet.channel ?? 'default';
  const storedId = packet.id ?? `apr-${packet.approvalId}`;

  if (conn.processedIds.has(storedId)) {
    if (packet.id) sendAck(conn, packet.id);
    return;
  }

  const stored: StoredMessage = {
    id: storedId,
    identity: conn.identity,
    agent,
    channel,
    from: packet.from,
    to: packet.to,
    text: `Approval needed: ${packet.summary}`,
    timestamp: packet.timestamp,
    sessionHash: null,
    meta: {
      type: 'approval_request',
      approvalId: packet.approvalId,
      summary: packet.summary,
      details: packet.details,
      expiresAt: packet.expiresAt,
      tiered: packet.tiered,
    },
  };

  const alreadyStored = await store.has(stored.id);
  if (!alreadyStored) await store.put(stored);
  if (packet.id) sendAck(conn, packet.id);
  if (alreadyStored) return;
  conn.processedIds.add(stored.id);

  if (hasViewerForConversation(conn.identity, agent, channel)) {
    const cache = conn.conversationCache(agent, channel);
    cache.messages.push(stored);
    cache.typing = false;
    cache.lifecycle = null;
    broadcastMutation({ kind: 'chat-conversation', identity: conn.identity, agent, channel });
  } else {
    conn.bumpUnread(agent, channel);
    pushToast(conn, {
      id: stored.id,
      agent,
      channel,
      from: packet.from,
      preview: `❔ ${packet.summary}`,
      timestamp: packet.timestamp,
    });
    broadcastMutation({ kind: 'chat-identity', identity: conn.identity });
  }
}

async function ingestApprovalAck(conn: ConnectionState, packet: ApprovalAckPayload): Promise<void> {
  const agent = packet.agent ?? extractAgentFallback(packet.from);
  if (!agent) return;
  const channel = packet.channel ?? 'default';
  const storedId = packet.id ?? `ack-${packet.approvalId}`;

  if (conn.processedIds.has(storedId)) {
    if (packet.id) sendAck(conn, packet.id);
    return;
  }

  const stored: StoredMessage = {
    id: storedId,
    identity: conn.identity,
    agent,
    channel,
    from: packet.from,
    to: packet.to,
    text: packet.text,
    timestamp: packet.timestamp,
    sessionHash: null,
    meta: {
      type: 'approval_ack',
      approvalId: packet.approvalId,
      summary: packet.summary,
      decision: packet.decision,
      reason: packet.reason,
      tier: packet.tier,
    },
  };

  const alreadyStored = await store.has(stored.id);
  if (!alreadyStored) await store.put(stored);
  if (packet.id) sendAck(conn, packet.id);
  if (alreadyStored) return;
  conn.processedIds.add(stored.id);

  if (hasViewerForConversation(conn.identity, agent, channel)) {
    const cache = conn.conversationCache(agent, channel);
    cache.messages.push(stored);
    broadcastMutation({ kind: 'chat-conversation', identity: conn.identity, agent, channel });
  } else {
    conn.bumpUnread(agent, channel);
    broadcastMutation({ kind: 'chat-identity', identity: conn.identity });
  }
}

function ingestApprovalStale(conn: ConnectionState, packet: ApprovalStalePayload): void {
  const agent = packet.agent ?? '';
  pushToast(conn, {
    id: `stale-${packet.data.approvalId}`,
    agent,
    channel: 'default',
    from: '',
    preview: `Already ${packet.data.status}: ${packet.data.summary}`,
    timestamp: new Date().toISOString(),
  });
  broadcastMutation({ kind: 'chat-identity', identity: conn.identity });
}

// ---------------------------------------------------------------------------
// Identity-scoped state
// ---------------------------------------------------------------------------

function ingestAgents(conn: ConnectionState, packet: AgentsPayload): void {
  conn.setAgents(packet.list);
  if (conn.state.phase === 'connecting') conn.setPhase('main');
  broadcastMutation({ kind: 'chat-identity', identity: conn.identity });
}

function ingestDiscover(conn: ConnectionState, packet: DiscoverPayload): void {
  conn.setDiscovered(packet.list);
  broadcastMutation({ kind: 'chat-identity', identity: conn.identity });
}

function ingestTyping(conn: ConnectionState, packet: TypingPayload): void {
  const agent = packet.agent ?? null;
  const channel = packet.channel ?? 'default';
  if (!agent) return;
  if (!hasViewerForConversation(conn.identity, agent, channel)) return;
  const cache = conn.conversationCache(agent, channel);
  cache.typing = true;
  cache.lifecycle = null;
  broadcastMutation({ kind: 'chat-conversation', identity: conn.identity, agent, channel });
}

function ingestTypingStopped(conn: ConnectionState, packet: TypingStoppedPayload): void {
  const agent = packet.agent ?? null;
  const channel = packet.channel ?? 'default';
  if (!agent) return;
  if (!hasViewerForConversation(conn.identity, agent, channel)) return;
  const cache = conn.conversationCache(agent, channel);
  cache.typing = false;
  broadcastMutation({ kind: 'chat-conversation', identity: conn.identity, agent, channel });
}

function ingestLifecycle(conn: ConnectionState, packet: LifecyclePayload): void {
  const agent = packet.agent ?? null;
  const channel = packet.channel ?? 'default';
  if (!agent) return;
  if (!hasViewerForConversation(conn.identity, agent, channel)) return;
  const cache = conn.conversationCache(agent, channel);
  if (packet.data.active) {
    cache.lifecycle = LIFECYCLE_LABELS[packet.data.phase] ?? null;
  } else {
    cache.lifecycle = null;
  }
  broadcastMutation({ kind: 'chat-conversation', identity: conn.identity, agent, channel });
}

function ingestError(conn: ConnectionState, packet: ErrorPayload): void {
  conn.setError(packet.text);
  broadcastMutation({ kind: 'chat-identity', identity: conn.identity });
  setTimeout(() => {
    if (conn.state.error === packet.text) {
      conn.setError(null);
      broadcastMutation({ kind: 'chat-identity', identity: conn.identity });
    }
  }, TOAST_DURATION_MS);
}

function ingestAttachmentAck(conn: ConnectionState, packet: AttachmentAckPayload): void {
  // Routed to a pending send-message handler if any is waiting on this filename.
  conn.attachmentAckListeners.forEach((listener) => listener(packet));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendAck(conn: ConnectionState, id: string): void {
  conn.transport?.send({ type: 'ack', id });
}

function pushToast(conn: ConnectionState, toast: Toast): void {
  conn.pushToast(toast, TOAST_MAX);
  setTimeout(() => {
    conn.removeToast(toast.id);
    broadcastMutation({ kind: 'chat-identity', identity: conn.identity });
  }, TOAST_DURATION_MS);
}

function extractAgentFallback(from: string): string | null {
  const atIdx = from.indexOf('@');
  return atIdx !== -1 ? from.slice(0, atIdx) : from;
}
