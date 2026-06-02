/**
 * Worker-global state — registries and helpers shared across the entry,
 * chat handlers, and admin handlers. Extracted from `persistence-worker.ts`
 * so handler modules can import the registries without creating a circular
 * dependency through the entry.
 */

import { ConnectionState } from './connection-state';
import { IDBMessageStore } from './storage/idb-message-store';
import { SubscriptionRegistry } from './subscription-registry';
import {
  scopeKey,
  type AdminGlobalSnapshot,
  type AdminTargetSnapshot,
  type Identity,
  type Scope,
  type Snapshot,
  type WorkerEvent,
  type WorkerToTab,
} from './protocol';
import type { CastTransport, MessageStore } from './interfaces';

// ---------------------------------------------------------------------------
// Global registries
// ---------------------------------------------------------------------------

export const store: MessageStore = new IDBMessageStore();
export const subscriptions = new SubscriptionRegistry();
export const connections = new Map<Identity, ConnectionState>();

// Per-target admin message cache (populated lazily on first subscribe).
// Reuses StoredMessage indirectly via store.getByAdminTarget().
import type { AdminChatMessage, AdminTarget } from './protocol';

/** Per-target admin cache. `previews` holds in-flight streams keyed by streamId;
 *  entries are cleared when a durable message arrives carrying the same streamId.
 *  Mirrors `ConversationCache` from `connection-state.ts`. `firstSeenAt` is the
 *  stream's first-chunk timestamp; preserved across chunks so render ordering
 *  doesn't drift forward as the server stamps each new frame with `new Date()`. */
export interface AdminTargetCache {
  messages: AdminChatMessage[];
  previews: Map<string, { text: string; from: string; firstSeenAt: string }>;
}

export const adminTargetCaches = new Map<string, AdminTargetCache>();

/** Lazy cache lookup. Mirrors `ConnectionState.conversationCache`. */
export function ensureAdminTargetCache(target: AdminTarget): AdminTargetCache {
  const key = adminTargetKey(target);
  let cache = adminTargetCaches.get(key);
  if (!cache) {
    cache = { messages: [], previews: new Map() };
    adminTargetCaches.set(key, cache);
  }
  return cache;
}

// Worker-side admin global state — populated by the admin WS transport
// (Phase 3.2). Mirrors the prior tab-side `useAdminEventStream` snapshot.
export const adminGlobal: AdminGlobalSnapshot = {
  initialAgents: [],
  connectionState: 'connecting',
  serverShutdownReason: null,
};

// ---------------------------------------------------------------------------
// Admin connection — singleton (no identity binding). Refcounted across all
// admin-* subscriptions; 500ms grace teardown absorbs page navigations.
// Bearer is set explicitly by tabs via the `connect-admin` action; tabs read
// the operator token from localStorage and pass it in.
// ---------------------------------------------------------------------------

const ADMIN_TEARDOWN_GRACE_MS = 500;

interface AdminConnectionContainer {
  transport: CastTransport | null;
  bearer: string | null;
  refCount: number;
  teardownTimer: ReturnType<typeof setTimeout> | null;
  /** Targets whose IDB history has been hydrated since the WS opened. Cleared on dispose. */
  hydratedTargets: Set<string>;
}

export const adminConnection: AdminConnectionContainer = {
  transport: null,
  bearer: null,
  refCount: 0,
  teardownTimer: null,
  hydratedTargets: new Set<string>(),
};

let onAdminAttach: ((bearer: string) => CastTransport) | null = null;

/**
 * Set by `worker/admin/lifecycle.ts` at boot. Called once when both bearer
 * AND refcount > 0 are true and no transport exists yet — returns a wired
 * `CastTransport` (already `connect()`-called) for the worker to retain.
 */
export function registerAdminTransportInitializer(fn: (bearer: string) => CastTransport): void {
  onAdminAttach = fn;
}

/** Set or rotate the operator Bearer token. Triggers attach if refcount > 0. */
export function setAdminBearer(bearer: string): void {
  adminConnection.bearer = bearer;
  maybeAttachAdminTransport();
}

/** Increment admin refcount; cancel any pending teardown; attach if conditions met. */
export function acquireAdminConnection(): void {
  adminConnection.refCount++;
  if (adminConnection.teardownTimer !== null) {
    clearTimeout(adminConnection.teardownTimer);
    adminConnection.teardownTimer = null;
  }
  maybeAttachAdminTransport();
}

/** Decrement refcount; if it hits zero, schedule teardown after the grace window. */
export function releaseAdminConnection(): void {
  if (adminConnection.refCount <= 0) return;
  adminConnection.refCount--;
  if (adminConnection.refCount === 0) {
    adminConnection.teardownTimer = setTimeout(() => {
      adminConnection.teardownTimer = null;
      if (adminConnection.refCount === 0) disposeAdminConnection();
    }, ADMIN_TEARDOWN_GRACE_MS);
  }
}

function maybeAttachAdminTransport(): void {
  if (adminConnection.transport !== null) return;
  if (adminConnection.refCount === 0) return;
  if (adminConnection.bearer === null) return;
  if (onAdminAttach === null) return;
  adminConnection.transport = onAdminAttach(adminConnection.bearer);
}

function disposeAdminConnection(): void {
  adminConnection.transport?.disconnect();
  adminConnection.transport = null;
  adminConnection.hydratedTargets.clear();
  // Bearer is sticky across refcount cycles — operator session outlives a brief
  // tab-close-and-reopen. Reset transient global state so the next subscribe
  // sees a clean 'connecting' snapshot, not the stale 'open' from before.
  adminGlobal.connectionState = 'connecting';
  adminGlobal.serverShutdownReason = null;
  // Keep `initialAgents` — sticky enumeration; refresh on next `ready` frame.
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

/**
 * Lazily create the per-identity ConnectionState. Phase 2.1 wires a
 * WebSocketTransport here on first creation. Subsequent calls reuse.
 */
export function ensureConnection(identity: Identity): ConnectionState {
  let conn = connections.get(identity);
  if (!conn) {
    conn = new ConnectionState(identity, (id) => {
      connections.delete(id);
    });
    connections.set(identity, conn);
    onConnectionCreated?.(conn);
  }
  return conn;
}

/** Set by chat module at boot — invoked when a new ConnectionState is created. */
export let onConnectionCreated: ((conn: ConnectionState) => void) | null = null;
export function registerConnectionInitializer(fn: (conn: ConnectionState) => void): void {
  onConnectionCreated = fn;
}

// ---------------------------------------------------------------------------
// Snapshot projection
// ---------------------------------------------------------------------------

export function snapshotFor(scope: Scope): Snapshot {
  switch (scope.kind) {
    case 'chat-identity': {
      const conn = connections.get(scope.identity);
      const data = conn ? conn.snapshot() : {
        phase: 'connecting' as const,
        agents: [],
        discovered: [],
        unread: {},
        toasts: [],
        error: null,
        connectionState: 'connecting' as const,
      };
      return { kind: 'chat-identity', data };
    }
    case 'chat-conversation': {
      const conn = connections.get(scope.identity);
      const data = conn
        ? conn.conversationSnapshot(scope.agent, scope.channel)
        : { messages: [], typing: false, lifecycle: null, previews: [] };
      return { kind: 'chat-conversation', data };
    }
    case 'admin-global': {
      const data: AdminGlobalSnapshot = { ...adminGlobal };
      return { kind: 'admin-global', data };
    }
    case 'admin-target': {
      const cache = adminTargetCaches.get(adminTargetKey(scope.target));
      const data: AdminTargetSnapshot = cache
        ? {
            messages: [...cache.messages],
            previews: Array.from(cache.previews, ([streamId, { text, from, firstSeenAt }]) => ({ streamId, text, from, timestamp: firstSeenAt })),
          }
        : { messages: [], previews: [] };
      return { kind: 'admin-target', data };
    }
  }
}

export function adminTargetKey(target: AdminTarget): string {
  return target.kind === 'agent'
    ? `agent:${target.alias}:${target.channel}`
    : `manager:${target.slug}`;
}

// ---------------------------------------------------------------------------
// Broadcast — fan a fresh snapshot to all subscribers of a scope
// ---------------------------------------------------------------------------

export function broadcastMutation(scope: Scope): void {
  const key = scopeKey(scope);
  const subs = subscriptions.forScopeKey(key);
  const snapshot = snapshotFor(scope);
  for (const sub of subs) {
    sub.port.postMessage({ kind: 'mutation', scope, snapshot } satisfies WorkerToTab);
  }
}

/**
 * Fan a transient signal to every subscriber of a scope. Not persisted; not
 * included in the snapshot. Used for admin `typing` / `typing_stopped` /
 * `lifecycle` / `ui_directive` / `message_received`.
 */
export function broadcastScopedEvent(scope: Scope, event: string, data: unknown): void {
  const key = scopeKey(scope);
  const subs = subscriptions.forScopeKey(key);
  for (const sub of subs) {
    sub.port.postMessage({ kind: 'scoped-event', scope, event, data } satisfies WorkerToTab);
  }
}

/** Send an ambient event to every connected port. Used for cross-tab-relevant signals. */
export function broadcastEvent(event: WorkerEvent): void {
  const frame: WorkerToTab = { kind: 'event', event };
  for (const port of subscriptions.allPorts()) {
    port.postMessage(frame);
  }
}

// ---------------------------------------------------------------------------
// "Is anyone viewing this conversation?" check — used by chat ingest to decide
// between updating the conversation cache vs bumping unread.
// ---------------------------------------------------------------------------

export function hasViewerForConversation(identity: Identity, agent: string, channel: string): boolean {
  return subscriptions.countForScopeKey(`chat-conversation:${identity}:${agent}:${channel}`) > 0;
}

export function hasViewerForAdminTarget(target: AdminTarget): boolean {
  return subscriptions.countForScopeKey(`admin-target:${adminTargetKey(target)}`) > 0;
}
