/**
 * WebSocket server infrastructure for Cast.
 *
 * Attaches path-based WebSocket routing to an existing HTTP server
 * (the Express admin server). Each transport owns its own WSS instance.
 *
 * Architecture:
 *   http.Server (admin) → WsRouter → /cli WSS (LocalTransport)
 *                                   → /web WSS (WebTransport)
 */
import type http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';

import { logger } from '../logger.js';
import type { AnyPacket } from './packets.js';
import type { Evt } from '../types.js';

// ---------------------------------------------------------------------------
// Path-based WS routing on an existing HTTP server
// ---------------------------------------------------------------------------

export interface WsRouter {
  /** Register a WebSocketServer for a URL path (e.g. '/cli', '/web'). */
  addPath(path: string, wss: WebSocketServer): void;
}

/**
 * Attach path-based WebSocket routing to an existing HTTP server.
 * WebSocket upgrade requests are dispatched by URL path to registered
 * WebSocketServer instances (noServer mode).
 */
export function attachWsRoutes(httpServer: http.Server): WsRouter {
  const pathMap = new Map<string, WebSocketServer>();

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname;
    const wss = pathMap.get(pathname);
    if (!wss) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  logger.info('WebSocket routes attached to HTTP server');

  return {
    addPath(path, wss) {
      pathMap.set(path, wss);
    },
  };
}

// ---------------------------------------------------------------------------
// Local (CLI/TUI) WebSocket handler — wires message handling onto a WSS
// ---------------------------------------------------------------------------

interface LocalWssDeps {
  /** Store a message in the DB and trigger processing */
  onMessage: (agentAddress: string, text: string, channel?: string, qualifier?: string, handle?: string) => void;
  /** Get or auto-register a CLI agent, returns the address */
  ensureAgent: (agentFolder: string) => string;
  /** Get conversation history for an agent address, optionally scoped to a channel/qualifier */
  getHistory: (agentAddress: string, opts?: {
    limit?: number;
    channel?: string;
    qualifier?: string;
    handle?: string;
  }) => Array<{
    id: string;
    type: string;
    from_addr: string;
    to_addr: string;
    timestamp: string;
    payload: string;
  }>;
  /** Handle an approval response from a CLI client. */
  onApprovalResponse?: (agentAddress: string, handle: string, id: string, decision: 'approved' | 'rejected', reason?: string) => void;
}

interface ClientState {
  ws: WebSocket;
  agentAddress: string | null;
  channel: string | null;
}

const WsBaseFields = {
  agent: z.string().min(1),
  handle: z.string().min(1),
  channel: z.string().min(1).optional(),
  qualifier: z.string().min(1).optional(),
};

const WsMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...WsBaseFields, type: z.literal('message'), text: z.string().min(1) }),
  z.object({ ...WsBaseFields, type: z.literal('history'), limit: z.number().int().positive().optional() }),
  z.object({ ...WsBaseFields, type: z.literal('approval_response'), id: z.string().min(1), decision: z.enum(['approved', 'rejected']), reason: z.string().optional() }),
]);

export interface WsServer {
  /** Broadcast a packet to CLI clients watching a specific agent address and channel. */
  broadcastMessage: (agentAddress: string, pkt: AnyPacket, channel?: string) => void;
  /** Broadcast an event envelope to CLI clients watching a specific agent address and channel. */
  broadcastEvent: (agentAddress: string, evt: Evt, channel?: string) => void;
  /** The underlying WebSocketServer instance. */
  wss: WebSocketServer;
}

/**
 * Wire CLI/TUI message handling onto an existing WebSocketServer (noServer mode).
 * The WSS must already be registered on the HTTP server's router.
 */
export function setupLocalWss(wss: WebSocketServer, deps: LocalWssDeps): WsServer {
  const clients = new Set<ClientState>();

  const broadcast = (agentAddress: string, payload: string, channel?: string): void => {
    const targetChannel = channel || 'default';
    for (const client of clients) {
      if (
        client.agentAddress === agentAddress &&
        (client.channel || 'default') === targetChannel &&
        client.ws.readyState === WebSocket.OPEN
      ) {
        try {
          client.ws.send(payload);
        } catch {
          logger.debug('WebSocket send failed, removing client');
          clients.delete(client);
        }
      }
    }
  };

  const broadcastMessage = (agentAddress: string, pkt: AnyPacket, channel?: string): void => {
    broadcast(agentAddress, JSON.stringify(pkt), channel);
  };

  const broadcastEvent = (agentAddress: string, evt: Evt, channel?: string): void => {
    broadcast(agentAddress, JSON.stringify(evt), channel);
  };

  wss.on('connection', (ws) => {
    const client: ClientState = { ws, agentAddress: null, channel: null };
    clients.add(client);
    logger.info('WebSocket client connected');

    ws.on('message', (raw, isBinary) => {
      const str = isBinary ? raw.toString('utf-8') : raw.toString();
      logger.debug({ raw: str }, 'WebSocket message received');
      try {
        const parsed = JSON.parse(str);
        const data = WsMessageSchema.parse(parsed);

        const agentAddress = deps.ensureAgent(data.agent);
        client.agentAddress = agentAddress;
        client.channel = data.channel || null;

        switch (data.type) {
          case 'history': {
            const raw = deps.getHistory(agentAddress, {
              limit: data.limit, channel: data.channel, qualifier: data.qualifier, handle: data.handle,
            });
            // Hydrate text + session_hash from payload for the wire format
            const entries = raw.map((r) => {
              const pkt = JSON.parse(r.payload);
              return {
                id: r.id, type: r.type, from_addr: r.from_addr, to_addr: r.to_addr,
                text: pkt.text as string, timestamp: r.timestamp,
                session_hash: (pkt.sessionHash as string | undefined) ?? null,
              };
            });
            ws.send(JSON.stringify({ type: 'history', entries }));
            break;
          }
          case 'message':
            logger.info({ agentAddress, textLength: data.text.length, channel: data.channel, qualifier: data.qualifier }, 'WebSocket message routed');
            deps.onMessage(agentAddress, data.text, data.channel, data.qualifier, data.handle);
            break;
          case 'approval_response':
            if (deps.onApprovalResponse) {
              deps.onApprovalResponse(agentAddress, data.handle, data.id, data.decision, data.reason);
            }
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
        logger.error({ err, raw: str }, 'WebSocket message error');
        ws.send(JSON.stringify({ type: 'error', text: message }));
      }
    });

    ws.on('close', () => {
      clients.delete(client);
      logger.info('WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'WebSocket client error');
      clients.delete(client);
    });
  });

  wss.on('error', (err) => {
    logger.error({ err }, 'WebSocket server error');
  });

  return { broadcastMessage, broadcastEvent, wss };
}
