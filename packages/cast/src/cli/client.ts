/**
 * Shared WebSocket client for Cast CLI and TUI.
 * Handles connection, reconnect, and the JSON message protocol.
 */
import { randomBytes } from 'crypto';

import WebSocket from 'ws';
import { z } from 'zod';

import { RECONNECT_DELAY_MS } from '../config.js';

type Status = 'connecting' | 'connected' | 'disconnected' | 'refused';

const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation'), text: z.string(), sessionHash: z.string().nullish() }),
  z.object({ type: z.literal('approval_request'), approvalId: z.string(), summary: z.string(), details: z.string().optional(), expiresAt: z.string().optional(), text: z.string() }),
  z.object({ type: z.literal('approval_ack'), approvalId: z.string(), decision: z.string(), summary: z.string(), text: z.string() }),
  z.object({ type: z.literal('typing') }),
  z.object({ type: z.literal('typing_stopped') }),
  z.object({ type: z.literal('error'), text: z.string().optional() }),
  z.object({ type: z.literal('history'), entries: z.array(z.object({
    id: z.string(),
    type: z.string(),
    from_addr: z.string(),
    to_addr: z.string(),
    text: z.string(),
    timestamp: z.string(),
    session_hash: z.string().nullable(),
  })) }),
]);

type HistoryEntry = {
  id: string;
  type: string;
  from_addr: string;
  to_addr: string;
  text: string;
  timestamp: string;
  session_hash: string | null;
};

type ApprovalRequest = {
  approvalId: string;
  summary: string;
  details?: string;
  expiresAt?: string;
};

type ClientEvents = {
  message: (text: string, sessionHash?: string) => void;
  approvalRequest: (req: ApprovalRequest) => void;
  typing: () => void;
  typingStopped: () => void;
  error: (text: string) => void;
  status: (status: Status) => void;
  history: (entries: HistoryEntry[]) => void;
};

type ClientOptions = {
  host?: string;
  port?: string;
  reconnect?: boolean;
  handle?: string;
};

type Client = {
  send: (text: string, opts?: { channel?: string; qualifier?: string }) => void;
  requestHistory: (opts?: { limit?: number; channel?: string; qualifier?: string }) => void;
  close: () => void;
  on: <K extends keyof ClientEvents>(event: K, handler: ClientEvents[K]) => void;
  off: <K extends keyof ClientEvents>(event: K, handler: ClientEvents[K]) => void;
};

function createClient(agent: string, opts?: ClientOptions): Client {
  const host = opts?.host || process.env.WS_HOST || 'localhost';
  const port = opts?.port || process.env.CAST_PORT || '5050';
  const shouldReconnect = opts?.reconnect ?? true;
  const handleKey = opts?.handle || randomBytes(4).toString('hex');
  const url = `ws://${host}:${port}/cli`;

  const listeners: { [K in keyof ClientEvents]: Set<ClientEvents[K]> } = {
    message: new Set(),
    approvalRequest: new Set(),
    typing: new Set(),
    typingStopped: new Set(),
    error: new Set(),
    status: new Set(),
    history: new Set(),
  };

  let ws: WebSocket | undefined;
  let closed = false;

  function emit<K extends keyof ClientEvents>(
    event: K,
    ...args: Parameters<ClientEvents[K]>
  ): void {
    for (const handler of listeners[event]) {
      // TS can't narrow generic event handler signatures through K
      (handler as (...a: unknown[]) => void)(...args);
    }
  }

  function connect(): void {
    if (closed) return;
    emit('status', 'connecting');

    ws = new WebSocket(url);

    ws.on('open', () => emit('status', 'connected'));

    ws.on('message', (raw) => {
      try {
        const parsed = ServerMessageSchema.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) return;
        const msg = parsed.data;
        switch (msg.type) {
          case 'history': emit('history', msg.entries); break;
          case 'conversation': emit('message', msg.text, msg.sessionHash ?? undefined); break;
          case 'approval_request': emit('approvalRequest', { approvalId: msg.approvalId, summary: msg.summary, details: msg.details, expiresAt: msg.expiresAt }); break;
          case 'approval_ack': emit('message', msg.text); break;
          case 'typing': emit('typing'); break;
          case 'typing_stopped': emit('typingStopped'); break;
          case 'error': emit('error', msg.text || 'Unknown error'); break;
        }
      } catch {
        // Ignore unparseable messages
      }
    });

    ws.on('close', () => {
      emit('status', 'disconnected');
      if (shouldReconnect && !closed) {
        setTimeout(connect, RECONNECT_DELAY_MS);
      }
    });

    ws.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') { // ws Error lacks .code; ErrnoException subtype
        emit('status', 'refused');
      } else {
        emit('error', err.message);
      }
    });
  }

  connect();

  return {
    send(text: string, opts?: { channel?: string; qualifier?: string }): void {
      if (ws?.readyState !== WebSocket.OPEN) return;

      // Intercept /approve and /reject commands → approval_response frames
      const approveMatch = text.match(/^\/approve\s+(\S+)/);
      if (approveMatch) {
        ws.send(JSON.stringify({ type: 'approval_response', agent, handle: handleKey, id: approveMatch[1], decision: 'approved' }));
        return;
      }
      const rejectMatch = text.match(/^\/reject\s+(\S+)(?:\s+(.+))?/);
      if (rejectMatch) {
        ws.send(JSON.stringify({ type: 'approval_response', agent, handle: handleKey, id: rejectMatch[1], decision: 'rejected', ...(rejectMatch[2] ? { reason: rejectMatch[2] } : {}) }));
        return;
      }

      const msg: Record<string, string> = { agent, type: 'message', text, handle: handleKey };
      if (opts?.channel) msg.channel = opts.channel;
      if (opts?.qualifier) msg.qualifier = opts.qualifier;
      ws.send(JSON.stringify(msg));
    },
    requestHistory(opts?: { limit?: number; channel?: string; qualifier?: string }): void {
      if (ws?.readyState === WebSocket.OPEN) {
        const msg: Record<string, unknown> = { agent, type: 'history', handle: handleKey };

        if (opts?.limit) msg.limit = opts.limit;
        if (opts?.channel) msg.channel = opts.channel;
        if (opts?.qualifier) msg.qualifier = opts.qualifier;
        ws.send(JSON.stringify(msg));
      }
    },
    close(): void {
      closed = true;
      ws?.close();
    },
    on<K extends keyof ClientEvents>(event: K, handler: ClientEvents[K]): void {
      listeners[event].add(handler);
    },
    off<K extends keyof ClientEvents>(event: K, handler: ClientEvents[K]): void {
      listeners[event].delete(handler);
    },
  };
}

export { createClient };
export type { Client, ClientOptions, HistoryEntry, Status };
