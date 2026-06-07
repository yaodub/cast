import type { Bus } from '../gateway/bus.js';
import type { MessageGateway } from '../gateway/message-gateway.js';
import type { AnyPacket } from '../gateway/packets.js';
import type { Evt } from '../types.js';
import type { Transport, OutboundContext } from './schema.js';
import type { IdentityProvider } from '../auth/identity.js';
import { setupLocalWss, type WsServer } from '../gateway/ws-server.js';
import type { WebSocketServer } from 'ws';

/**
 * Local transport — wraps WsServer as a Transport for unified outbound routing.
 * Owns participant addresses starting with "cli:".
 */
export class LocalTransport implements Transport {
  name = 'local';

  private wsServer: WsServer;

  constructor(wsServer: WsServer) {
    this.wsServer = wsServer;
  }

  async send(pkt: AnyPacket, ctx: OutboundContext): Promise<void> {
    this.wsServer.broadcastMessage(ctx.agentAddress, pkt, ctx.channel);
  }

  ownsParticipant(participantAddress: string): boolean {
    return participantAddress.startsWith('cli:');
  }

  async sendEvent(evt: Evt): Promise<void> {
    const channel =
      evt.type === 'typing' || evt.type === 'typing_stopped' || evt.type === 'ui_directive'
        ? evt.data.channel
        : undefined;
    this.wsServer.broadcastEvent(evt.from, evt, channel);
  }

  async connect(): Promise<void> {
    // WsServer lifecycle is managed by the factory
  }

  async disconnect(): Promise<void> {
    // Close every connected CLI/TUI client with WebSocket code 1001 ("going
    // away") so clients see a clean shutdown signal instead of TCP RST.
    // The underlying WebSocketServer object itself is owned by the HTTP
    // server's noServer router — we don't close that here.
    for (const client of this.wsServer.wss.clients) {
      try { client.close(1001, 'Server shutting down'); } catch { /* socket may be dead */ }
    }
  }

  isConnected(): boolean {
    return true;
  }
}

export interface LocalTransportDeps {
  gateway: MessageGateway;
  bus: Bus;
  wss: WebSocketServer;
  idp: IdentityProvider;
}

/**
 * Factory: create a LocalTransport from a pre-created WebSocketServer (noServer mode).
 * Absorbs all WsServer wiring (onMessage, ensureAgent, getHistory).
 */
export function createLocalTransport(deps: LocalTransportDeps): { transport: LocalTransport; wsServer: WsServer } {
  const wsServer = setupLocalWss(deps.wss, {
    onMessage: (agentAddress, text, channel, qualifier, handle) => {
      const participant = `cli:${handle || 'user'}`;
      const senderName = handle || 'User';
      deps.gateway.ingestInbound(participant, agentAddress, text, senderName, { channel, qualifier });
    },
    ensureAgent: (folder) => {
      const agentId = deps.bus.resolveByLabel(folder);
      if (!agentId) {
        throw new Error(`Unknown agent "${folder}"`);
      }
      return agentId;
    },
    getHistory: (agentAddress, opts) => {
      const handle = `cli:${opts?.handle || 'user'}`;
      // Operator surfaces are their own bare identity (`resolve('cli:x').id === 'cli:x'`);
      // gateway packets are keyed on the bare participant.
      const resolved = deps.idp.resolve(handle);
      const participant = resolved ? resolved.id : handle;
      return deps.gateway.getHistory(agentAddress, participant, { limit: opts?.limit });
    },
    onApprovalResponse: (agentAddress, handle, id, decision, reason) => {
      const participant = `cli:${handle}`;
      deps.gateway.ingestApprovalResponse(participant, agentAddress, { id, decision, reason });
    },
  });

  const transport = new LocalTransport(wsServer);
  return { transport, wsServer };
}
