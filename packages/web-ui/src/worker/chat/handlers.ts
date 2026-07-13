/**
 * Chat action handlers — implement the tab-dispatched verbs against the
 * worker's per-identity ConnectionState. The chat ingest is the receive
 * path; this is the send path.
 */

import { z } from 'zod';

import {
  AttachmentAckPayload,
  RegisterPayload,
} from '../../lib/protocol';
import type {
  AttachmentDraft,
  Identity,
  GetAttachmentResult,
  RegisterIdentityResult,
  SendMessageResult,
  StoredMessage,
} from '../protocol';
import { WebSocketTransport } from '../transports/web-socket-transport';
import {
  broadcastEvent,
  broadcastMutation,
  connections,
  ensureConnection,
  hasViewerForConversation,
  store,
} from '../state';
import type { ConnectionState } from '../connection-state';

const ATTACHMENT_ACK_TIMEOUT_MS = 10000;
const REGISTER_TIMEOUT_MS = 8000;

function requireConnection(identity: Identity): ConnectionState {
  const conn = connections.get(identity);
  if (!conn) throw new Error(`identity '${identity}' is not connected`);
  return conn;
}

// ---------------------------------------------------------------------------
// send-message — emits binary frames for attachments, awaits acks, then
// sends the text message, then optimistically appends to the conversation
// cache + broadcasts mutation.
// ---------------------------------------------------------------------------

export async function sendMessage(
  identity: Identity,
  agent: string,
  channel: string,
  text: string,
  clientMsgId: string,
  attachments: AttachmentDraft[] | undefined,
): Promise<SendMessageResult> {
  const conn = requireConnection(identity);
  if (!conn.transport) throw new Error('no transport for identity');

  const ackResults: SendMessageResult['attachmentHashes'] = [];

  if (attachments && attachments.length > 0) {
    // Send binary frames, then await one ack per attachment with a global timeout.
    const ackPromise = collectAttachmentAcks(conn, attachments.length);

    for (const att of attachments) {
      conn.transport.sendBinary(
        {
          agent,
          filename: att.filename,
          mimeType: att.mimeType || 'application/octet-stream',
        },
        att.bytes,
      );
    }

    const acks = await ackPromise;
    for (const ack of acks) {
      const match = attachments.find((a) => a.filename === ack.filename);
      if (!match) continue;
      ackResults.push({
        clientId: match.clientId,
        hash: ack.hash,
        filename: ack.filename,
        mimeType: ack.mimeType,
      });
      // Cache the blob locally so re-renders can resolve the attachment without
      // re-downloading from the server.
      await store.putAttachment(ack.hash, match.bytes, ack.mimeType, ack.filename);
    }
  }

  const wireFrame: Record<string, unknown> = {
    type: 'message',
    handle: identity,
    agent,
    text,
  };
  if (channel !== 'default') wireFrame.channel = channel;
  conn.transport.send(wireFrame);

  // Optimistic render — visible in every tab viewing this conversation.
  const stored: StoredMessage = {
    id: `local-${clientMsgId}`,
    identity,
    agent,
    channel,
    from: identity,
    to: agent,
    text,
    timestamp: new Date().toISOString(),
    sessionHash: null,
    attachments: ackResults.length > 0
      ? ackResults.map((a) => ({ filename: a.filename, mimeType: a.mimeType, hash: a.hash }))
      : undefined,
  };

  await store.put(stored);

  if (hasViewerForConversation(identity, agent, channel)) {
    const cache = conn.conversationCache(agent, channel);
    cache.messages.push(stored);
    broadcastMutation({ kind: 'chat-conversation', identity, agent, channel });
  }

  return { attachmentHashes: ackResults };
}

function collectAttachmentAcks(
  conn: ConnectionState,
  count: number,
): Promise<AttachmentAckPayload[]> {
  if (count === 0) return Promise.resolve([]);
  return new Promise((resolve) => {
    const collected: AttachmentAckPayload[] = [];
    const listener = (ack: AttachmentAckPayload): void => {
      collected.push(ack);
      if (collected.length >= count) cleanup();
    };
    const timer = setTimeout(cleanup, ATTACHMENT_ACK_TIMEOUT_MS);
    function cleanup(): void {
      conn.attachmentAckListeners.delete(listener);
      clearTimeout(timer);
      resolve(collected);
    }
    conn.attachmentAckListeners.add(listener);
  });
}

// ---------------------------------------------------------------------------
// respond-to-approval / explain-approval / refresh-* / rename-user
// ---------------------------------------------------------------------------

export function respondToApproval(
  identity: Identity,
  agent: string,
  approvalId: string,
  decision: 'approved' | 'rejected',
  tier?: 'once' | 'always',
): void {
  const conn = requireConnection(identity);
  conn.transport?.send({
    type: 'approval_response',
    handle: identity,
    agent,
    id: approvalId,
    decision,
    tier,
  });
}

export async function explainApproval(
  identity: Identity,
  agent: string,
  channel: string,
  approvalId: string,
  summary: string,
): Promise<SendMessageResult> {
  const text = `Can you explain what this approval will do? [${approvalId}]: ${summary}`;
  return sendMessage(identity, agent, channel, text, `explain-${approvalId}`, undefined);
}

export function refreshAgents(identity: Identity): void {
  const conn = requireConnection(identity);
  conn.transport?.send({ type: 'agents', handle: identity });
}

export function refreshDiscover(identity: Identity): void {
  const conn = requireConnection(identity);
  conn.transport?.send({ type: 'discover' });
}

// ---------------------------------------------------------------------------
// dismiss-toast — identity-scoped state mutation
// ---------------------------------------------------------------------------

export function dismissToast(identity: Identity, toastId: string): void {
  const conn = requireConnection(identity);
  conn.removeToast(toastId);
  broadcastMutation({ kind: 'chat-identity', identity });
}

// ---------------------------------------------------------------------------
// get-attachment — pulls bytes from IDB
// ---------------------------------------------------------------------------

export async function getAttachment(hash: string): Promise<GetAttachmentResult> {
  // ArrayBufferLike vs ArrayBuffer variance: Zod's `z.instanceof(Uint8Array)`
  // narrows to `Uint8Array<ArrayBuffer>`; the IDB read returns
  // `Uint8Array<ArrayBufferLike>`. The runtime payload is identical.
  return (await store.getAttachment(hash)) as GetAttachmentResult;
}

// ---------------------------------------------------------------------------
// register-identity — uses a short-lived WS to perform the fresh-registration
// handshake without binding a persistent identity on this socket.
// ---------------------------------------------------------------------------

const RegisterMessage = z.object({
  type: z.literal('register'),
  handle: z.string(),
  identity: z.string(),
  name: z.string().optional(),
});

declare const self: { location: { protocol: string; host: string } };

function chatWsUrl(): string {
  const proto = self.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${self.location.host}/web`;
}

export async function registerIdentity(name: string): Promise<RegisterIdentityResult> {
  const transport = new WebSocketTransport(chatWsUrl());

  return new Promise<RegisterIdentityResult>((resolve, reject) => {
    let settled = false;
    const settle = (result: RegisterIdentityResult | Error): void => {
      if (settled) return;
      settled = true;
      transport.disconnect();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      settle(new Error('register timed out'));
    }, REGISTER_TIMEOUT_MS);

    transport.onPacket((packet) => {
      const parsed = RegisterMessage.safeParse(packet);
      if (!parsed.success) return;
      const reg = parsed.data satisfies z.infer<typeof RegisterPayload>;
      clearTimeout(timer);
      const result: RegisterIdentityResult = {
        identity: reg.handle,
        identityId: reg.identity,
        name: reg.name ?? name,
      };
      // Emit an ambient event so any open tab can react (e.g. close a stale
      // registration form on another tab if the user completed registration here).
      broadcastEvent({
        kind: 'identity-registered',
        identity: result.identity,
        identityId: result.identityId,
        name: result.name,
      });
      settle(result);
    });

    transport.onState((state) => {
      if (state === 'connected') {
        transport.send({ type: 'register', name });
      } else if (state === 'disconnected' && !settled) {
        clearTimeout(timer);
        settle(new Error('register disconnected before response'));
      }
    });

    transport.connect();
  });
}

// ---------------------------------------------------------------------------
// On chat-conversation subscribe: hydrate IDB cache + clear unread
// ---------------------------------------------------------------------------

/** Called by the worker entry when a tab first subscribes to a chat-conversation scope. */
export async function onConversationFirstSubscribe(
  identity: Identity,
  agent: string,
  channel: string,
): Promise<void> {
  const conn = ensureConnection(identity);

  // Hydrate cache from IDB if not already populated.
  const cacheKey = `${agent}:${channel}`;
  if (!conn.conversations.has(cacheKey)) {
    const messages = await store.getByConversation({ kind: 'chat-conversation', identity, agent, channel });
    const cache = conn.conversationCache(agent, channel);
    cache.messages = messages;
  }

  // Clear unread on identity scope; broadcast.
  if (conn.state.unread[`${agent}/${channel}`] !== undefined) {
    conn.clearUnread(agent, channel);
    broadcastMutation({ kind: 'chat-identity', identity });
  }
}
