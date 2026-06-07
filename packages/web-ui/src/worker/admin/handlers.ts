/**
 * Admin action handlers — invoked from the persistence worker's action
 * dispatcher. All write paths into the per-target message cache and IDB
 * funnel through here so tabs never touch admin state directly.
 */

import {
  adminConnection,
  adminTargetCaches,
  adminTargetKey,
  broadcastMutation,
  ensureAdminTargetCache,
  setAdminBearer,
  store,
} from '../state';
import type { AdminChatMessage, AdminTarget } from '../protocol';

/**
 * Set or rotate the operator Bearer token.
 *
 * - First call (no bearer set): triggers WS attach if any admin scope is
 *   currently subscribed.
 * - Same bearer as before: no-op.
 * - Different bearer with active transport: drops the old transport (which
 *   was retrying with stale credentials) and re-attaches with the new one.
 *   Tabs invoke this after `refreshToken()` recovers from a server restart.
 */
export function connectAdmin(bearer: string): void {
  if (adminConnection.bearer === bearer && adminConnection.transport !== null) return;
  if (adminConnection.bearer !== bearer && adminConnection.transport !== null) {
    adminConnection.transport.disconnect();
    adminConnection.transport = null;
    adminConnection.hydratedTargets.clear();
  }
  setAdminBearer(bearer);
}

/**
 * Tear down the admin WS immediately (operator logged out). Bypasses the
 * 500ms grace because logout is a deliberate action and we want the WS gone
 * now — not after navigation noise.
 */
export function disconnectAdmin(): void {
  // Explicit teardown: if the transport exists, force-close it now and clear
  // bearer so a subsequent subscribe doesn't re-attach with stale credentials.
  adminConnection.transport?.disconnect();
  adminConnection.transport = null;
  adminConnection.bearer = null;
  adminConnection.hydratedTargets.clear();
  // Don't touch refCount — the subscriptions still exist; their next acquire
  // attempt will see no bearer and wait for the tab to re-supply one.
}

/**
 * Optimistic echo / operator-injected message (e.g. `divider:fresh_conversation`).
 * Appends to the per-target cache + persists to IDB. Caller supplies a stable
 * id; for echoes use `echo-<uuid>`, replaced server-side by the real packet id
 * on next WS delivery (dedup by id keeps it coherent).
 */
export async function writeEcho(target: AdminTarget, msg: AdminChatMessage): Promise<void> {
  appendIfNew(target, msg);
  await persistAdminMessage(target, msg);
}

/**
 * Like `writeEcho`, but splices the message in *before* the last existing
 * row and backdates its timestamp to `lastMsg.timestamp - 1ms`. Used for the
 * `fresh_conversation` divider, fired after the operator message it precedes
 * conceptually. Backdating keeps order stable across IDB rehydration.
 *
 * If the cache is empty, falls back to a plain append.
 */
export async function writeEchoBeforeLast(target: AdminTarget, msg: AdminChatMessage): Promise<void> {
  const cache = ensureAdminTargetCache(target);
  if (cache.messages.some((m) => m.id === msg.id)) return;
  const last = cache.messages[cache.messages.length - 1];
  if (!last) {
    cache.messages.push(msg);
    broadcastMutation({ kind: 'admin-target', target });
    await persistAdminMessage(target, msg);
    return;
  }
  const backdated: AdminChatMessage = {
    ...msg,
    timestamp: new Date(new Date(last.timestamp).getTime() - 1).toISOString(),
  };
  cache.messages.splice(cache.messages.length - 1, 0, backdated);
  broadcastMutation({ kind: 'admin-target', target });
  await persistAdminMessage(target, backdated);
}

/** Roll back an echo whose POST failed. Idempotent — no-op if not present. */
export function rollbackEcho(target: AdminTarget, echoId: string): void {
  const key = adminTargetKey(target);
  const cache = adminTargetCaches.get(key);
  if (!cache) return;
  const idx = cache.messages.findIndex((m) => m.id === echoId);
  if (idx === -1) return;
  cache.messages.splice(idx, 1);
  broadcastMutation({ kind: 'admin-target', target });
  // IDB delete is best-effort; the echo's id is the same one persisted in
  // writeEcho so deleting it cleans up the row that would otherwise resurrect
  // on next hydration.
  void store.delete(echoId).catch(() => { /* best-effort */ });
}

/**
 * Mark a target read. Worker-side intent: clear any worker-tracked unread
 * counter. Today unread tracking lives entirely tab-side in `chat-unread.ts`
 * (localStorage + storage event); this is a no-op stub kept so the action
 * routes cleanly. A later change may move unread into the worker — at which point
 * this becomes the mutation site.
 */
export function markAdminTargetRead(_target: AdminTarget): void {
  // Intentionally empty — see doc comment.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendIfNew(target: AdminTarget, msg: AdminChatMessage): void {
  const cache = ensureAdminTargetCache(target);
  if (cache.messages.some((m) => m.id === msg.id)) return;
  cache.messages.push(msg);
  broadcastMutation({ kind: 'admin-target', target });
}

async function persistAdminMessage(target: AdminTarget, msg: AdminChatMessage): Promise<void> {
  const already = await store.hasAdmin(msg.id).catch(() => false);
  if (already) return;
  await store.putAdmin(target, msg).catch((err) => {
    console.warn('[worker/admin] putAdmin failed', { err, target, id: msg.id });
  });
}
