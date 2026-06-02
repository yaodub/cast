# Persistence SharedWorker

The browser-origin singleton that owns the WebSocket connections to the Cast
server, the IndexedDB message history, and the per-(identity, conversation)
state caches. Tabs are thin renderers that speak `MessagePort` to this
worker — they never instantiate `WebSocket` or open IndexedDB directly.

## Architecture

```
                                   ┌───────────────────────────────────┐
                                   │           SharedWorker            │
                                   │  packages/web-ui/src/worker/...   │
                                   │                                   │
  ┌───────┐   MessagePort           │  ┌──────────────────────────────┐ │
  │ Tab 1 │ ◀──────────────────────▶│  │  TabChannel × N (one/tab)    │ │
  └───────┘                          │  └────────────┬─────────────────┘ │
                                   │               │                   │
  ┌───────┐                          │  ┌────────────▼─────────────────┐ │
  │ Tab 2 │ ◀──────────────────────▶│  │  Subscription registry +     │ │
  └───────┘                          │  │  per-scope snapshot cache    │ │
                                   │  └─────┬───────────────────┬─────┘ │
                                   │        │                   │       │
                                   │   ┌────▼─────────┐    ┌────▼─────┐ │
                                   │   │ Chat state   │    │ Admin    │ │
                                   │   │ Map<id,Conn> │    │ state    │ │
                                   │   └────┬─────────┘    └────┬─────┘ │
                                   │        │                   │       │
                                   │   ┌────▼─────────┐    ┌────▼─────┐ │
                                   │   │ WebSocket    │    │ WebSocket│ │
                                   │   │ /web         │    │ /api/    │ │
                                   │   │ × identity   │    │ admin/   │ │
                                   │   └──────────────┘    │ events   │ │
                                   │                       └──────────┘ │
                                   │                                   │
                                   │           IDBMessageStore         │
                                   │      (cast-web-client IDB)        │
                                   └───────────────────────────────────┘
                                                  ▲
                                                  │ WebSocket
                                                  ▼
                                          Cast server
```

The single SharedWorker per browser origin is what makes multi-tab "just
work": every tab subscribes to scoped projections (`chat-identity`,
`chat-conversation`, `admin-global`, `admin-target`); the worker fans every
mutation to every subscribed tab. Optimistic writes go through the worker
too, so a send in Tab A immediately appears in Tab B if it's viewing the
same conversation.

## Three core interfaces

The worker's business logic is decoupled from three external concerns:

| Interface | Today | Future |
|-----------|-------|--------|
| `MessageStore` | `IDBMessageStore` — wraps the existing `cast-web-client` IndexedDB schema in-process. | `NetworkMessageStore` — same async contract, but `put` / `get` round-trip to a hosted persistence service. |
| `TabChannel` | `PortTabChannel` — thin wrapper over `MessagePort` (one per tab connection). | `WebSocketTabChannel` — same envelope shape over a WebSocket, for when the worker itself runs server-side. |
| `CastTransport` | `WebSocketTransport` — used twice (chat per-identity to `/web`, admin singleton to `/api/admin/events`). Owns reconnect + drain. | No swap planned; the persistence service sits *downstream* of transports, not in their place. |

Each interface is defined in `interfaces.ts` with a sketch of its future
implementation inline. The contracts are deliberately narrow: the worker's
subscription routing, dedup, hydration, and broadcast paths consume only
these interfaces — they never touch `MessagePort`, `WebSocket`, or
`indexedDB` symbols directly.

## Swap procedure

The intended evolution path is: the worker is "v0 of the networked
persistence service." When the codebase moves to a hosted persistence
service, the swap is a one-file substitution per interface, not a rewrite.

### Swapping `MessageStore` to a network-backed store

1. Implement `NetworkMessageStore` next to `idb-message-store.ts`, matching
   the `MessageStore` interface in `interfaces.ts`. Each method round-trips
   the equivalent REST call (sketched in the comment block above the
   interface).
2. In `worker/state.ts`, change `export const store: MessageStore = new
   IDBMessageStore();` to `new NetworkMessageStore(baseUrl, token);`.
3. No other worker code changes — `ConnectionState`, `subscription-registry`,
   chat/admin ingest, all consume `store: MessageStore` and don't know which
   implementation backs it.

### Swapping `TabChannel` to WebSocket (hosted-worker mode)

This is the mode where the "worker" actually runs as a server-side process
and tabs connect over WebSocket instead of `MessagePort`.

1. Implement `WebSocketTabChannel` (in `tab-channel.ts` next to
   `PortTabChannel`) — `postMessage` becomes `ws.send(JSON.stringify(...))`,
   `onMessage` registers a `ws.addEventListener('message', ...)` handler,
   `onClose` registers `ws.addEventListener('close', ...)`.
2. In `persistence-worker.ts`, replace the `self.onconnect = (event) => {...
   new PortTabChannel(port); ...}` block with a `WebSocketServer` listener
   that wraps each new client in a `WebSocketTabChannel`.
3. Binary `Transferable` payloads (attachment bytes) become binary WS frames
   prefixed with a JSON header — same pattern as `WebSocketTransport.sendBinary`.

### Swapping `CastTransport` — no path today

The transport interface exists for completeness and future protocol shifts
(e.g. QUIC). There is no swap on the near horizon: chat and admin are both
WS already; both go through the same `WebSocketTransport` class.

## What lives where

| Concern | File |
|---------|------|
| `MessageStore` / `TabChannel` / `CastTransport` interfaces | `interfaces.ts` |
| Zod-validated `Action` / `Scope` / `Snapshot` / `WorkerEvent` types (the protocol between worker and tab) | `protocol.ts` |
| SharedWorker entry + envelope dispatch | `persistence-worker.ts` |
| Per-identity `ConnectionState` (refcount, chat-state slots, conversation caches) | `connection-state.ts` |
| Worker-global registries (`store`, `subscriptions`, `connections`, `adminGlobal`, `adminTargetCaches`, `adminConnection`) | `state.ts` |
| Tab subscription registry — `(port, scope)` index keyed two ways | `subscription-registry.ts` |
| IDB implementation of `MessageStore` (owns `cast-web-client` schema) | `storage/idb-message-store.ts` |
| Chat-WS lifecycle (per-identity attach, ingest wiring) | `chat/lifecycle.ts` |
| Chat action handlers (`send-message`, `respond-to-approval`, ...) + IDB hydration on first subscribe | `chat/handlers.ts` |
| Chat WS ingest (server packets → state mutations + broadcasts) | `chat/ingest.ts` |
| Admin-WS lifecycle (singleton attach, IDB hydration on first subscribe) | `admin/lifecycle.ts` |
| Admin action handlers (`connect-admin`, `write-echo`, ...) | `admin/handlers.ts` |
| Admin WS ingest (envelope → mutation or scoped-event) | `admin/ingest.ts` |
| `WebSocketTransport` (single class, used per-identity for chat and singleton for admin) | `transports/web-socket-transport.ts` |
| `PortTabChannel` (concrete `TabChannel` for SharedWorker `MessagePort`) | `tab-channel.ts` |
| `BoundedSet` LRU helper (per-identity dedup) | `lib/bounded-set.ts` |

## Worker version stamp

`WORKER_VERSION` in `persistence-worker.ts` is logged on every `hello`
handshake. Bump it whenever worker code changes substantively so a stale
HMR-cached worker in a long-lived tab is obvious in the console. Vite's
HMR does not replace SharedWorker code, so a full browser reload is the
only way to pick up a new worker bundle during development.
