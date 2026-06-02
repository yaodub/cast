/**
 * Admin event stream — thin facade over the persistence SharedWorker. The
 * worker owns the actual `/api/admin/events` WebSocket; this provider only:
 *
 *   1. Dispatches the operator Bearer token to the worker so it can attach
 *      the WS (`connect-admin` action). On `connectionState === 'reconnecting'`
 *      we re-fetch the token and re-dispatch — recovers from server restarts
 *      where the cached token is gone from the server's in-memory map.
 *   2. Subscribes to `admin-global` to mirror the worker's authoritative
 *      `initialAgents` / `connectionState` / `serverShutdownReason` into a
 *      Preact-friendly `useState`-backed value for layout consumers.
 *   3. Exposes a `subscribe(target, handler)` API that wraps
 *      `worker.subscribe({kind:'admin-target', target}, noop, onEvent)` so
 *      `useAdminChat` / `useServerScopeChat` keep their existing callback
 *      shape. Only transient `scoped-event` frames flow through `handler` —
 *      packets land on the snapshot via `useTargetMessages`.
 *
 * Wire validation (Zod parsing of envelopes off the WS) and per-target
 * dispatch happens worker-side in `worker/admin/ingest.ts`. Tabs receive
 * already-validated `scoped-event` frames here.
 */
import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useState } from 'preact/hooks';

import type { ServerScopeTarget } from '@getcast/admin-schema/v1';

import { worker } from '../../lib/worker-client';
import type { AdminGlobalSnapshot } from '../../worker/protocol';
import { getToken, refreshToken } from './use-session';

export type AgentChannel = '__design' | '__configure';

export type Target =
  | { kind: 'agent'; alias: string; channel: AgentChannel }
  | { kind: 'manager'; slug: ServerScopeTarget };

/**
 * Subscriber callback. `data` is the raw envelope payload from the server
 * (typing/lifecycle/ui_directive/message_received). The worker validates
 * the envelope before dispatch but does NOT parse the inner data — each
 * consumer Zod-parses against its own schema (e.g. `LifecycleDataSchema`,
 * `UiDirectiveEventDataSchema`).
 */
export type EventHandler = (event: string, data: unknown) => void;

export interface AgentSnapshot {
  alias: string;
  address: string;
}

export type ConnectionState = 'connecting' | 'open' | 'reconnecting';

export interface AdminEventStreamApi {
  /** Subscribe to transient events for a target. Returns a disposer. */
  subscribe(target: Target, handler: EventHandler): () => void;
  /** Initial agent list from the server's `ready` handshake — drives sidebar hydration. */
  initialAgents: AgentSnapshot[];
  /** Current connection state — 'reconnecting' while a transient drop is recovering. */
  connectionState: ConnectionState;
  /** Set when the server emitted a `shutdown` frame before closing the
   *  stream. Cleared automatically once a fresh `ready` handshake arrives
   *  (i.e. the server came back up). UI consumers render a banner from this. */
  serverShutdownReason: string | null;
}

const AdminEventStreamContext = createContext<AdminEventStreamApi | null>(null);

interface ProviderProps {
  /** Gate the admin WS — false until the operator is authenticated. */
  enabled: boolean;
  children: ComponentChildren;
}

const INITIAL_GLOBAL: AdminGlobalSnapshot = {
  initialAgents: [],
  connectionState: 'connecting',
  serverShutdownReason: null,
};

export function AdminEventStreamProvider({ enabled, children }: ProviderProps): preact.JSX.Element {
  const [global, setGlobal] = useState<AdminGlobalSnapshot>(INITIAL_GLOBAL);

  // Dispatch the bearer to the worker on first authenticated mount. The
  // worker holds it sticky across refcount cycles so subscribes and
  // re-mounts don't bounce the WS. On logout the consumer is torn down
  // (enabled flips false); we don't dispatch `disconnect-admin` here
  // because the operator may still want admin state to drain through; the
  // explicit logout flow in `use-session.ts` handles forced teardown.
  useEffect(() => {
    if (!enabled) return;
    const token = getToken();
    if (!token) return;
    void worker.send({ kind: 'connect-admin', bearer: token }).catch((err) => {
      console.warn('[admin-event-stream] connect-admin failed', err);
    });
  }, [enabled]);

  // Mirror the worker's authoritative admin-global snapshot into local state.
  useEffect(() => {
    if (!enabled) return;
    return worker.subscribe({ kind: 'admin-global' }, (data) => {
      setGlobal(data);
    });
  }, [enabled]);

  // Token rotation: server restart drops the in-memory token map, so the
  // worker's WS fails repeatedly with 401. Recover by re-fetching a fresh
  // token (server auto-issues on localhost) and re-dispatching connect-admin
  // — `connectAdmin` notices the bearer change, drops the stale transport,
  // and re-attaches.
  useEffect(() => {
    if (!enabled) return;
    if (global.connectionState !== 'reconnecting') return;
    let cancelled = false;
    void refreshToken().then((fresh) => {
      if (cancelled || !fresh) return;
      void worker.send({ kind: 'connect-admin', bearer: fresh }).catch((err) => {
        console.warn('[admin-event-stream] reconnect connect-admin failed', err);
      });
    });
    return () => { cancelled = true; };
  }, [enabled, global.connectionState]);

  const subscribe = useCallback((target: Target, handler: EventHandler): (() => void) => {
    // Transient events only. The snapshot callback is a no-op — message
    // arrays are owned by `useTargetMessages` (separate subscription).
    return worker.subscribe(
      { kind: 'admin-target', target },
      () => { /* snapshot ignored */ },
      (event, data) => handler(event, data),
    );
  }, []);

  const value = useMemo<AdminEventStreamApi>(
    () => ({
      subscribe,
      initialAgents: global.initialAgents,
      connectionState: global.connectionState,
      serverShutdownReason: global.serverShutdownReason,
    }),
    [subscribe, global.initialAgents, global.connectionState, global.serverShutdownReason],
  );

  return (
    <AdminEventStreamContext.Provider value={value}>
      {children}
    </AdminEventStreamContext.Provider>
  );
}

export function useAdminEventStream(): AdminEventStreamApi {
  const ctx = useContext(AdminEventStreamContext);
  if (!ctx) throw new Error('useAdminEventStream must be used inside <AdminEventStreamProvider>');
  return ctx;
}
