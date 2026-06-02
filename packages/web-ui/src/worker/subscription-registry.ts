/**
 * Subscription registry — tracks which tabs are subscribed to which scopes.
 *
 * Indexed two ways:
 *   - `byScopeKey`: scope-key → Set<Subscription>. Used to fan out mutations
 *     for a given scope to all interested tabs.
 *   - `byPort`: port → Set<Subscription>. Used to clean up all of a tab's
 *     subscriptions when its TabChannel closes.
 */

import type { TabChannel } from './interfaces';
import type { Scope } from './protocol';
import { scopeKey } from './protocol';

export interface Subscription {
  port: TabChannel;
  scope: Scope;
  /** Cached `scopeKey(scope)` for hot-path lookups. */
  key: string;
}

export class SubscriptionRegistry {
  private byScopeKey = new Map<string, Set<Subscription>>();
  private byPort = new Map<TabChannel, Set<Subscription>>();

  /**
   * Add a subscription. Idempotent per `(port, scope-key)`: if the pair
   * already exists, returns `{sub, isNew: false}` without mutating. Callers
   * that hold per-subscription resources (refcounts, etc.) must gate
   * acquisition on `isNew` to avoid leaks when a single tab subscribes to
   * the same scope from multiple hooks (e.g. admin-target snapshot read,
   * unread tracker, transient-event listener).
   */
  add(port: TabChannel, scope: Scope): { sub: Subscription; isNew: boolean } {
    const key = scopeKey(scope);

    const existingForPort = this.byPort.get(port);
    if (existingForPort) {
      for (const sub of existingForPort) {
        if (sub.key === key) return { sub, isNew: false };
      }
    }

    const sub: Subscription = { port, scope, key };

    let setForKey = this.byScopeKey.get(key);
    if (!setForKey) {
      setForKey = new Set();
      this.byScopeKey.set(key, setForKey);
    }
    setForKey.add(sub);

    let setForPort = this.byPort.get(port);
    if (!setForPort) {
      setForPort = new Set();
      this.byPort.set(port, setForPort);
    }
    setForPort.add(sub);

    return { sub, isNew: true };
  }

  removeByPortAndScope(port: TabChannel, scope: Scope): Subscription | null {
    const key = scopeKey(scope);
    const setForPort = this.byPort.get(port);
    if (!setForPort) return null;
    for (const sub of setForPort) {
      if (sub.key === key) {
        this.removeSub(sub);
        return sub;
      }
    }
    return null;
  }

  /** Drop all subscriptions for this port. Returns the removed list (callers may release refcounts). */
  removeAllByPort(port: TabChannel): Subscription[] {
    const setForPort = this.byPort.get(port);
    if (!setForPort) return [];
    const removed = Array.from(setForPort);
    for (const sub of removed) this.removeSub(sub);
    return removed;
  }

  /** All subscriptions for the given scope key. Iterate to fan out a mutation. */
  forScopeKey(key: string): Iterable<Subscription> {
    return this.byScopeKey.get(key) ?? [];
  }

  /** Number of distinct ports subscribed to this scope key. Used as a fan-out heuristic. */
  countForScopeKey(key: string): number {
    return this.byScopeKey.get(key)?.size ?? 0;
  }

  /** All distinct ports across all subscriptions. Used for ambient-event broadcast. */
  allPorts(): Iterable<TabChannel> {
    return this.byPort.keys();
  }

  private removeSub(sub: Subscription): void {
    const setForKey = this.byScopeKey.get(sub.key);
    if (setForKey) {
      setForKey.delete(sub);
      if (setForKey.size === 0) this.byScopeKey.delete(sub.key);
    }
    const setForPort = this.byPort.get(sub.port);
    if (setForPort) {
      setForPort.delete(sub);
      if (setForPort.size === 0) this.byPort.delete(sub.port);
    }
  }
}
