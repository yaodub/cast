/**
 * Three core interfaces that decouple the worker's business logic from
 * (a) where messages are stored, (b) how it talks to a tab, and (c) how
 * it talks to the Cast server. Each is implemented today by a single
 * concrete class living next to it; the interface exists so the eventual
 * networked-persistence-service split is a one-file swap, not a rewrite.
 *
 * Sketches of the future implementations are inlined as comment blocks —
 * they're not write-now, but the interface shape is a contract: each
 * sketch must be expressible against this interface without changing it.
 */

import type {
  AdminTarget,
  AdminChatMessage,
  ChatConversationScope,
  StoredMessage,
  ConnectionState,
} from './protocol';

// ---------------------------------------------------------------------------
// MessageStore — durable history. Today: IndexedDB. Tomorrow: networked.
//
// Today's implementation: IDBMessageStore (worker/storage/idb-message-store.ts)
//   owns the `cast-web-client` IDB schema directly (DB name + version +
//   indexes); the same schema was previously defined in the now-deleted
//   `lib/db.ts`, so existing browser data carries forward unchanged.
//
// Future sketch: NetworkMessageStore
//   - getByConversation: GET /persistence/messages?identity=&agent=&channel=
//   - put: POST /persistence/messages (idempotent on stored.id)
//   - has: HEAD /persistence/messages/:id (or batch lookup)
//   - getAttachment: GET /persistence/attachments/:hash → returns bytes
//   - putAttachment: POST /persistence/attachments (idempotent on hash)
//   - All methods return Promises just like IDB; constructor takes a
//     base URL + auth token. The worker code calling this interface
//     does not change — it's the same async contract.
// ---------------------------------------------------------------------------

export interface MessageStore {
  /** Read all messages for a chat conversation, sorted by timestamp ascending. */
  getByConversation(scope: ChatConversationScope): Promise<StoredMessage[]>;

  /** Read all admin chat messages for a target, sorted ascending. */
  getByAdminTarget(target: AdminTarget): Promise<AdminChatMessage[]>;

  /** Idempotent put on `msg.id`. Overwrites if present. */
  put(msg: StoredMessage): Promise<void>;

  /** Idempotent put for admin chat messages. */
  putAdmin(target: AdminTarget, msg: AdminChatMessage): Promise<void>;

  /** Existence check by id — used by the dedup race fix in chat ingest. */
  has(id: string): Promise<boolean>;

  /** Existence check for admin messages by id. */
  hasAdmin(id: string): Promise<boolean>;

  /** Delete by id (used by rollbackEcho). */
  delete(id: string): Promise<void>;

  /** Read an attachment blob by content hash, or null if missing. */
  getAttachment(hash: string): Promise<{ blob: Uint8Array; mimeType: string; filename: string } | null>;

  /** Store an attachment blob, evicting oldest if total bytes exceed budget. */
  putAttachment(hash: string, blob: Uint8Array, mimeType: string, filename: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// TabChannel — abstract MessagePort. Today: SharedWorker MessagePort.
//                                   Tomorrow: WebSocket frame.
//
// Today's implementation: PortTabChannel (inlined in persistence-worker.ts;
//   a thin wrapper over the raw MessagePort each tab opens to the worker).
//
// Future sketch: WebSocketTabChannel
//   - postMessage: send JSON envelope (or binary frame for Transferable
//     payloads like attachment bytes) over a WebSocket to the persistence
//     service.
//   - onMessage / onClose: standard WS event listeners.
//   - close: WS.close().
//   The worker's subscription-routing code consumes only this interface; it
//   never imports MessagePort directly.
// ---------------------------------------------------------------------------

export interface TabChannel {
  /** Send an envelope to the tab. `transfer` lists Transferable objects (e.g. ArrayBuffer for attachments). */
  postMessage(envelope: unknown, transfer?: Transferable[]): void;

  /** Register a handler for inbound envelopes. Returns an unregister function. */
  onMessage(handler: (envelope: unknown) => void): () => void;

  /** Register a handler for channel close. Called on tab unload, port error, etc. */
  onClose(handler: () => void): () => void;

  /** Close the channel. Idempotent. */
  close(): void;
}

// ---------------------------------------------------------------------------
// CastTransport — abstract over the WebSocket links the worker maintains
// with the Cast server.
//
// Today's implementation: WebSocketTransport (worker/transports/web-socket-
//   transport.ts) — one class, two instances:
//     1. Chat — per-identity WS to /web. Sends JSON + binary attachment
//        frames; owns reconnect + drain replay.
//     2. Admin — singleton WS to /api/admin/events?token=<bearer>. Read-only
//        from the server's perspective (the operator sends via HTTP POST).
//
// Future sketch: nothing changes here; the persistence service would sit
//   downstream of the transports, not in their place. Cast server still
//   emits events on the WS; the worker still consumes them. A future
//   networked persistence layer would receive the worker's `MessageStore.put`
//   calls over the network without touching this interface.
// ---------------------------------------------------------------------------

export interface CastTransport {
  /** Open the connection. Idempotent — calling twice is a no-op. */
  connect(): void;

  /** Close the connection cleanly. Stops reconnect attempts. */
  disconnect(): void;

  /** Send a JSON envelope (chat WS only — SSE is one-way). */
  send(envelope: Record<string, unknown>): void;

  /** Send a binary frame with a JSON header (chat WS only — used for attachments). */
  sendBinary(header: Record<string, string>, bytes: Uint8Array): void;

  /** Register a handler for parsed JSON packets from the server. */
  onPacket(handler: (packet: unknown) => void): () => void;

  /** Register a handler for binary frames (chat WS only — header pre-parsed, bytes raw). */
  onBinary(handler: (header: unknown, bytes: Uint8Array) => void): () => void;

  /** Register a handler for connection-state changes. */
  onState(handler: (state: ConnectionState) => void): () => void;

  /** Current connection state — synchronous read for state-aware sends. */
  state(): ConnectionState;
}
