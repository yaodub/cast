/**
 * Chat connection lifecycle wiring — invoked by the worker entry to attach a
 * `WebSocketTransport` to each freshly-created `ConnectionState` and route
 * its packets/state through the chat ingest.
 */

import { WebSocketTransport } from '../transports/web-socket-transport';
import type { ConnectionState } from '../connection-state';
import { broadcastMutation, registerConnectionInitializer } from '../state';
import { ingestBinary, ingestPacket } from './ingest';

declare const self: { location: { protocol: string; host: string } };

function chatWsUrl(): string {
  const proto = self.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${self.location.host}/web`;
}

/** Initialize chat WS handling on first ConnectionState creation. */
function initChatConnection(conn: ConnectionState): void {
  const transport = new WebSocketTransport(chatWsUrl());
  conn.transport = transport;

  transport.onPacket((packet) => {
    void ingestPacket(conn, packet);
  });

  transport.onBinary((header, bytes) => {
    void ingestBinary(conn, header, bytes);
  });

  transport.onState((state) => {
    conn.setConnectionState(state);
    broadcastMutation({ kind: 'chat-identity', identity: conn.identity });

    if (state === 'connected') {
      // On (re)connect, refresh agent list + discover so the sidebar hydrates
      // and `phase` flips to 'main' once `agents` arrives. Re-fires after every
      // transient drop — also re-establishes server-side replay flow.
      transport.send({ type: 'agents', handle: conn.identity });
      transport.send({ type: 'discover' });
    }
  });

  transport.connect();
}

/** Bootstrap module — call once at worker startup. */
export function installChatLifecycle(): void {
  registerConnectionInitializer(initChatConnection);
}
