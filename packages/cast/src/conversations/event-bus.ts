/**
 * ConversationEventBus — typed, in-process pub/sub for Conversation
 * state-machine transitions.
 *
 * NOT the same as `gateway/bus.ts` (which is the cross-process address bus
 * carrying packets between transports and agents). This bus is internal to
 * the conversations layer — it emits whenever a `Conversation` instance
 * changes state, phase, queue posture, or completes a teardown side-effect.
 * Phase H Steps 3-7 progressively migrate hook delivery onto this bus so
 * the `Conversation` class has a single observable surface and host-layer
 * subscribers (queue UX, snapshot cleanup, expiry side-effects) become
 * compositional rather than baked into `ConversationCallbacks`.
 *
 * Filter semantics (Step 3 scope):
 * - `scope?: string | RegExp` — string is exact-match, RegExp uses `.test()`,
 *   absent matches all.
 * - `kinds?: ConversationEvent['kind'][]` — subscriber receives only events
 *   whose `kind` is in the list. Absent matches all kinds.
 * - Channel filtering is intentionally NOT supported at this layer: channel
 *   data lives in the conversation's host-supplied `ctx`, which is `unknown`
 *   here. Host subscribers that need channel scoping should keep a typed
 *   facade over `subscribe()` and apply their own predicate.
 *
 * Emit-during-dispatch safety: `emit()` snapshots subscribers per `kind`
 * before iterating, so subscribers that subscribe/unsubscribe inside their
 * own callback do not perturb the current dispatch. New subscribers are
 * picked up on the next `emit()`; unsubscribed callbacks still receive the
 * in-flight event (their `Set` removal is visible only to subsequent emits).
 */
import type { ConversationView } from './conversation.js';
import type { ConversationState, ConversationPhase } from './types.js';
import { logger } from '../logger.js';

export type ConversationEvent =
  | { kind: 'state'; view: ConversationView<unknown>; from: ConversationState; to: ConversationState }
  | { kind: 'phase'; view: ConversationView<unknown>; from: ConversationPhase; to: ConversationPhase }
  | { kind: 'queued'; view: ConversationView<unknown>; active: boolean }
  | { kind: 'runner-removed'; view: ConversationView<unknown> }
  | { kind: 'expiry-complete'; view: ConversationView<unknown> };

export type ConversationEventKind = ConversationEvent['kind'];

export interface SubscriptionFilter {
  scope?: string | RegExp;
  kinds?: ConversationEventKind[];
}

type Subscriber = {
  filter: SubscriptionFilter;
  fn: (evt: ConversationEvent) => void;
};

const ALL_KINDS: readonly ConversationEventKind[] = [
  'state',
  'phase',
  'queued',
  'runner-removed',
  'expiry-complete',
];

export class ConversationEventBus {
  /** Indexed by kind for O(1) dispatch. Each subscriber is registered under
   *  every kind it cares about (all kinds when its filter omits `kinds`). */
  private byKind = new Map<ConversationEventKind, Set<Subscriber>>();

  constructor() {
    for (const k of ALL_KINDS) this.byKind.set(k, new Set());
  }

  /**
   * Register a subscriber. Returns a dispose function that removes the
   * subscriber from every kind-set it was indexed under. Calling dispose
   * more than once is safe — extra calls are no-ops.
   */
  subscribe(filter: SubscriptionFilter, fn: (evt: ConversationEvent) => void): () => void {
    const sub: Subscriber = { filter, fn };
    const kinds = filter.kinds ?? ALL_KINDS;
    for (const k of kinds) {
      const set = this.byKind.get(k);
      if (set !== undefined) set.add(sub);
    }
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      for (const k of kinds) {
        this.byKind.get(k)?.delete(sub);
      }
    };
  }

  /**
   * Emit synchronously to every subscriber whose filter matches. Each
   * subscriber's callback runs inside a try/catch so a throwing subscriber
   * doesn't break siblings or the caller (errors log to `logger.error`).
   *
   * Snapshot semantics: the per-kind subscriber set is copied into a local
   * array before iteration, so subscribe/unsubscribe inside a callback only
   * affects future emits.
   */
  emit(evt: ConversationEvent): void {
    const set = this.byKind.get(evt.kind);
    if (set === undefined || set.size === 0) return;
    const snapshot = Array.from(set);
    for (const sub of snapshot) {
      if (!matchesScope(sub.filter, evt)) continue;
      try {
        sub.fn(evt);
      } catch (err) {
        logger.error(
          {
            kind: evt.kind,
            scope: evt.view.scope,
            key: evt.view.key,
            err,
          },
          'ConversationEventBus: subscriber threw',
        );
      }
    }
  }
}

function matchesScope(filter: SubscriptionFilter, evt: ConversationEvent): boolean {
  const s = filter.scope;
  if (s === undefined) return true;
  if (typeof s === 'string') return evt.view.scope === s;
  return s.test(evt.view.scope);
}
