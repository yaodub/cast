/**
 * Per-target chat unread state — shared across the per-channel hooks
 * (`useAdminChat`, `useServerScopeChat`) and the sidebar rollup in
 * `layout.tsx` so `AgentRow` can show unread for any agent, not just
 * the one whose URL is currently active.
 *
 * Backed by `localStorage` so unread persists across reloads and tabs.
 * Same-tab consumers are notified via an in-process subscriber map
 * (browser `storage` events only fire cross-tab).
 *
 * Source-of-truth flow:
 *   - `useAdminUnreadTracker` (called once in Layout) subscribes to the
 *     multiplexed admin event stream for every known target. On packet
 *     arrival when the target is not the active chat, it calls
 *     `markUnread(target, true)`.
 *   - `markUnread(target, false)` fires whenever a chat panel becomes
 *     active (operator focused on it).
 *   - Any component reads via `useChatUnread(target)` and gets a live
 *     boolean.
 */
import { useEffect, useState } from 'preact/hooks';

import type { Target } from '../hooks/use-admin-event-stream';

const KEY_PREFIX = 'admin-chat-unread:';
/** Per-target read-cursor: the newest message timestamp the operator has seen
 *  as read. Persisted alongside the unread boolean so the unread tracker can
 *  recompute against it after a remount — fixing the case where a message
 *  arrives while the tracker is unmounted (operator on /chat/) and would
 *  otherwise be re-seeded as already-read on return. */
const CURSOR_PREFIX = 'admin-chat-readcursor:';

function targetKey(target: Target): string {
  return target.kind === 'agent'
    ? `${KEY_PREFIX}agent:${target.alias}:${target.channel}`
    : `${KEY_PREFIX}manager:${target.slug}`;
}

function cursorKey(target: Target): string {
  return target.kind === 'agent'
    ? `${CURSOR_PREFIX}agent:${target.alias}:${target.channel}`
    : `${CURSOR_PREFIX}manager:${target.slug}`;
}

/**
 * Read the per-target read-cursor (newest timestamp seen as read), or `null`
 * if this target has never been tracked — the caller treats `null` as "first
 * sight" and seeds the cursor from current history so a fresh load doesn't
 * flag pre-existing messages as unread.
 */
export function readReadCursor(target: Target): string | null {
  try {
    return localStorage.getItem(cursorKey(target));
  } catch {
    return null;
  }
}

/** Persist the per-target read-cursor. */
export function writeReadCursor(target: Target, ts: string): void {
  try {
    localStorage.setItem(cursorKey(target), ts);
  } catch {
    // Quota or sandboxed storage — best-effort only.
  }
}

// --- Unread decision logic (pure — see use-admin-global-state.ts) ----------
// Extracted so the cursor compute is unit-testable without a DOM/hook harness.

/** Minimal message shape the unread tracker reasons over. */
export interface UnreadMessage {
  from: string;
  type: string;
  timestamp: string;
}

/**
 * A message is badge-worthy unless it's the operator's own echo (`from`
 * starts with `local/`) or a synthetic transcript divider — neither should
 * light an unread dot.
 */
export function isBadgeworthy(m: UnreadMessage): boolean {
  return !m.from.startsWith('local/') && !m.type.startsWith('divider:');
}

/** Newest badge-worthy message timestamp, or `''` if there are none. ISO
 *  timestamps compare lexicographically, so string `>` is chronological. */
export function newestBadgeworthyTimestamp(messages: readonly UnreadMessage[]): string {
  let newest = '';
  for (const m of messages) {
    if (isBadgeworthy(m) && m.timestamp > newest) newest = m.timestamp;
  }
  return newest;
}

/** True iff a badge-worthy message arrived strictly after `cursor`. */
export function hasUnreadSince(messages: readonly UnreadMessage[], cursor: string): boolean {
  return messages.some((m) => isBadgeworthy(m) && m.timestamp > cursor);
}

function readStorage(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeStorage(key: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // Quota or sandboxed storage — best-effort only.
  }
}

// SIDE EFFECT: In-process subscriber map. `storage` events don't fire in
// the tab that wrote the value, so we mirror those notifications manually
// here so unread-state changes propagate within the active tab too. A pure
// approach would require every consumer to subscribe to storage AND a local
// event bus separately — error-prone duplication for cross-tab parity.
const sameTabListeners = new Map<string, Set<(value: boolean) => void>>();

function notifySameTab(key: string, value: boolean): void {
  const listeners = sameTabListeners.get(key);
  if (!listeners) return;
  for (const fn of listeners) fn(value);
}

/** Mark a target unread (or read). Persists to localStorage and notifies any listeners. */
export function markUnread(target: Target, value: boolean): void {
  const key = targetKey(target);
  if (readStorage(key) === value) return; // no-op — avoid notification churn
  writeStorage(key, value);
  notifySameTab(key, value);
}

/** Reactive read of unread state for a target. Tracks both same-tab and cross-tab updates. */
export function useChatUnread(target: Target): boolean {
  const key = targetKey(target);
  const [value, setValue] = useState<boolean>(() => readStorage(key));

  useEffect(() => {
    setValue(readStorage(key));

    let listeners = sameTabListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      sameTabListeners.set(key, listeners);
    }
    listeners.add(setValue);

    const onStorage = (e: StorageEvent): void => {
      if (e.key === key) setValue(e.newValue === '1');
    };
    window.addEventListener('storage', onStorage);

    return () => {
      const set = sameTabListeners.get(key);
      if (set) {
        set.delete(setValue);
        if (set.size === 0) sameTabListeners.delete(key);
      }
      window.removeEventListener('storage', onStorage);
    };
  }, [key]);

  return value;
}
