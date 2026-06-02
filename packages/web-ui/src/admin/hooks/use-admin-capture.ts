/**
 * useAdminCapture — keeps the worker's admin events pipeline warm for the
 * whole operator session, on BOTH the admin and chat surfaces.
 *
 * The admin WS inside the SharedWorker is refcounted to admin-scope
 * subscriptions and torn down ~500ms after the last one drops (see
 * `worker/state.ts`). The admin app holds those subscriptions, so navigating
 * to `/chat/` (which unmounts the entire admin subtree) drops the WS — and any
 * console / server-scope message emitted while it's down is lost, because
 * `ConsoleTransport` is best-effort live fan-out with no replay.
 *
 * Mounted once at the App root (`main.tsx`), this hook closes that window
 * without touching the worker internals or the Cast server:
 *
 *   - It holds a single `admin-global` subscription for its lifetime. That
 *     subscription keeps the worker's admin-connection refcount >= 1 (the
 *     worker acquires the connection for any `admin-global`/`admin-target`
 *     subscribe — see `persistence-worker.ts`), so the teardown never fires
 *     while a tab is open, including while the operator is on `/chat/`.
 *   - It supplies the operator bearer via `connect-admin` so the WS attaches
 *     even when the admin app isn't mounted (e.g. a fresh `/chat/` load whose
 *     worker has no sticky bearer yet). `connectAdmin` is idempotent.
 *   - On reconnect (`connectionState === 'reconnecting'`) it re-fetches a fresh
 *     token and re-dispatches `connect-admin`, mirroring
 *     `AdminEventStreamProvider` — needed because that provider isn't mounted
 *     on `/chat/` to do it.
 *
 * With the WS held open, incoming packets are ingested to IndexedDB by the
 * worker regardless of which surface is rendered, so a message that lands
 * while the operator is on `/chat/` is present when they return to admin.
 *
 * Limitation (by design — see the plan): this only helps while *some* tab is
 * alive to hold the worker. Messages emitted while every tab is closed are
 * still lost (the server keeps no replay); closing that gap needs a
 * server-side spool.
 */
import { useEffect, useRef } from 'preact/hooks';

import { worker } from '../../lib/worker-client';
import type { AdminGlobalSnapshot } from '../../worker/protocol';
import { getToken, refreshToken } from './use-session';

export function useAdminCapture(): void {
  // Latch so the reconnect recovery fires once per transition into
  // 'reconnecting', not on every admin-global snapshot.
  const reconnectingRef = useRef(false);

  useEffect(() => {
    // Supply the bearer if we already have one. When the admin app is mounted
    // it dispatches its own connect-admin on auth; this covers the case where
    // a fresh /chat/ load (no admin app) needs to attach the WS itself. No
    // token (logged out / unauthenticated) → no-op; the held subscription
    // below still keeps the refcount up so a later connect-admin attaches.
    const token = getToken();
    if (token) {
      void worker.send({ kind: 'connect-admin', bearer: token }).catch((err) => {
        console.warn('[admin-capture] connect-admin failed', err);
      });
    }

    // The load-bearing line: hold one admin-global subscription for the App's
    // lifetime so the worker's admin-connection refcount stays >= 1 across
    // navigation between /admin and /chat — the teardown can't fire.
    const dispose = worker.subscribe(
      { kind: 'admin-global' },
      (data: AdminGlobalSnapshot) => {
        const reconnecting = data.connectionState === 'reconnecting';
        if (reconnecting && !reconnectingRef.current) {
          reconnectingRef.current = true;
          // Server restart drops the in-memory token map, so the worker's WS
          // 401s on reconnect. Re-fetch a fresh token (auto-issued on
          // localhost) and re-dispatch so the worker swaps the stale bearer.
          void refreshToken().then((fresh) => {
            if (!fresh) return;
            void worker.send({ kind: 'connect-admin', bearer: fresh }).catch((err) => {
              console.warn('[admin-capture] reconnect connect-admin failed', err);
            });
          });
        } else if (!reconnecting) {
          reconnectingRef.current = false;
        }
      },
    );
    return dispose;
  }, []);
}
