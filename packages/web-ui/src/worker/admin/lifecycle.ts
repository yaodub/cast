/**
 * Admin connection lifecycle wiring — invoked by the worker entry to install
 * the WS-attachment hook and provide the per-admin-target hydration helper
 * used on first subscribe.
 */

import {
  adminConnection,
  adminGlobal,
  adminTargetKey,
  broadcastMutation,
  ensureAdminTargetCache,
  registerAdminTransportInitializer,
  store,
} from '../state';
import type { CastTransport } from '../interfaces';
import type { AdminTarget } from '../protocol';
import { WebSocketTransport } from '../transports/web-socket-transport';
import { ingestAdminFrame } from './ingest';

declare const self: { location: { protocol: string; host: string } };

function adminWsUrl(bearer: string): string {
  const proto = self.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${self.location.host}/api/admin/events?token=${encodeURIComponent(bearer)}`;
}

/**
 * Build a `WebSocketTransport` bound to the admin events endpoint. Wired to
 * `ingestAdminFrame` for incoming JSON; flips `adminGlobal.connectionState`
 * on transport state changes. Same exponential-backoff reconnect path as chat.
 *
 * Admin WS is read-only from the server's perspective — the operator sends
 * via HTTP POST. So no `transport.send(...)` calls happen here.
 */
function attachAdminTransport(bearer: string): CastTransport {
  const transport = new WebSocketTransport(adminWsUrl(bearer));

  transport.onPacket((packet) => {
    void ingestAdminFrame(packet);
  });

  transport.onState((state) => {
    // Map the WebSocketTransport state ('connecting' | 'connected' | 'disconnected')
    // to the AdminGlobalSnapshot state ('connecting' | 'open' | 'reconnecting').
    // The 'ready' frame (handled in ingest) flips us from 'connecting' → 'open'
    // *after* the server-side enumeration finishes, so we don't hop directly here.
    if (state === 'disconnected' && adminGlobal.connectionState === 'open') {
      adminGlobal.connectionState = 'reconnecting';
      broadcastMutation({ kind: 'admin-global' });
    }
    // 'connecting' / 'connected': no immediate flip — wait for 'ready'. This
    // matches the legacy SSE behavior at use-admin-event-stream.tsx:198-208.
  });

  transport.connect();
  return transport;
}

/** Bootstrap module — call once at worker startup. */
export function installAdminLifecycle(): void {
  registerAdminTransportInitializer(attachAdminTransport);
}

/**
 * Lazy IDB hydration on first subscribe to an admin-target scope. Mirrors the
 * legacy `ensureHydrated` pattern from use-admin-global-state.ts:101 — runs at
 * most once per (target, WS-connection-cycle). Subsequent subscribes within
 * the same connection reuse the cache; the cache is cleared on dispose so a
 * fresh subscribe after teardown re-hydrates.
 *
 * Race-safe: if a packet lands in the cache between hydration kick-off and
 * resolution, the merge step dedups by id and sorts by timestamp.
 */
export async function onAdminTargetFirstSubscribe(target: AdminTarget): Promise<void> {
  const key = adminTargetKey(target);
  if (adminConnection.hydratedTargets.has(key)) return;
  adminConnection.hydratedTargets.add(key);

  try {
    const loaded = await store.getByAdminTarget(target);
    const cache = ensureAdminTargetCache(target);
    const merged = mergeById(loaded, cache.messages);
    if (merged.length !== cache.messages.length) {
      cache.messages = merged;
      broadcastMutation({ kind: 'admin-target', target });
    }
  } catch (err) {
    console.warn('[worker/admin] IDB hydration failed', { key, err });
    // Allow retry on next subscribe by un-marking. Otherwise a transient IDB
    // error would mean the target stays empty until the WS reconnects.
    adminConnection.hydratedTargets.delete(key);
  }
}

function mergeById<T extends { id: string; timestamp: string }>(loaded: T[], live: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const m of [...loaded, ...live]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return out;
}
