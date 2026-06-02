/**
 * ConversationCatalog — owns the global catalog + paging policy.
 *
 * Notable properties:
 *
 * - **Typed scope storage (spec D5).** Scope is a field on `Conversation`, not
 *   a string prefix on a composite key. `inScope(scope)` iterates a per-scope
 *   `Set`, not a prefix-filter over a global Map. The "does my prefix end
 *   with `:` or not" caller-error class is gone.
 * - **No reverse lookup.** No scoped-key-for-runner map is needed: the
 *   Conversation reference IS the lookup key.
 * - **Slot eviction is policy here, not in the gate.** SlotPool is pure
 *   concurrency; this class owns who-to-evict and when.
 */
import type { AgentStateStore } from '../agent/state-store.js';
import { logger } from '../logger.js';
import { Conversation, type BuildSpawnHooks } from './conversation.js';
import type { SlotPool, Slot } from './slot-pool.js';
import type { ConversationTtl } from './ttl.js';
import type { RunnerFactory } from './runner.js';
import type { ConversationEventBus } from './event-bus.js';

export interface ConversationFactoryOpts {
  scope: string;
  conversationKey: string;
  factory: RunnerFactory;
  buildSpawnHooks: BuildSpawnHooks;
  /** Per-conversation state-store. Each agent has its own; the Catalog does
   *  not pin one. */
  store: AgentStateStore;
}

export interface ConversationCatalogOpts {
  pool: SlotPool;
  ttl: ConversationTtl;
  /** Single in-process event bus all materialized `Conversation` instances
   *  emit through. Hosts subscribe at scope-registration time and reach
   *  back into per-host state from the filtered subscriber. Phase H Step 7. */
  eventBus: ConversationEventBus;
}

/** Discriminated return from `ConversationCatalog.acquireSlot`. Three variants:
 *
 *  - `sync` — capacity was immediately available; the caller dispatches
 *    synchronously. Tests + transport ordering depend on this synchronous
 *    spawn-on-free-slot property.
 *  - `swap` — pool is saturated but an idle-with-runner victim exists; the
 *    catalog will evict it (transient ~ms window). The caller stays in
 *    `idle-no-runner` while awaiting — the bus does NOT emit `queued`
 *    because no FIFO wait is occurring from the operator's POV. Phase L.
 *  - `queued` — pool is saturated AND no swap victim is available; this is
 *    a genuine FIFO wait. The caller transitions to `awaiting-slot` (which
 *    emits `queued{active:true}` via the bus chokepoint).
 *
 *  The swap path may fall through to FIFO if a parallel caller grabs the
 *  freed slot first; in that case `swapAndAcquire` calls
 *  `conv.markSwapFellThrough()` to belatedly transition the conv to
 *  `awaiting-slot` so the bus event still fires for the (now-genuine) FIFO
 *  wait. */
export type SlotResult =
  | { kind: 'sync'; slot: Slot }
  | { kind: 'swap'; promise: Promise<Slot> }
  | { kind: 'queued'; promise: Promise<Slot> };

/** Build the composite map key. Uses NUL so no scope can collide with the
 *  `${scope}:${key}` interpretation in any caller-visible surface. */
function compositeKey(scope: string, key: string): string {
  return `${scope}\x00${key}`;
}

export class ConversationCatalog {
  private readonly pool: SlotPool;
  private readonly ttl: ConversationTtl;
  private readonly eventBus: ConversationEventBus;
  private byKey = new Map<string, Conversation>();
  private byScope = new Map<string, Set<Conversation>>();
  private _shuttingDown = false;

  constructor(opts: ConversationCatalogOpts) {
    this.pool = opts.pool;
    this.ttl = opts.ttl;
    this.eventBus = opts.eventBus;
  }

  // =========================================================================
  // Lookup
  // =========================================================================

  get(scope: string, key: string): Conversation | undefined {
    return this.byKey.get(compositeKey(scope, key));
  }

  has(scope: string, key: string): boolean {
    return this.byKey.has(compositeKey(scope, key));
  }

  inScope(scope: string): IterableIterator<Conversation> {
    const set = this.byScope.get(scope);
    return (set ?? new Set<Conversation>()).values();
  }

  get size(): number {
    return this.byKey.size;
  }

  // =========================================================================
  // getOrCreate
  // =========================================================================

  /**
   * Atomic getOrCreate. If a Conversation already exists for (scope, key) and
   * is not destroyed, returns it. Destroyed entries are replaced (this only
   * happens if the catalog hasn't yet processed the unregister call from the
   * destroyed conv — a rare race).
   *
   * `invalidate()` does NOT cause replacement here; the Conversation handles
   * environment-stale runner swap internally on next deliver, preserving the
   * stable-reference invariant.
   */
  getOrCreate(opts: ConversationFactoryOpts): Conversation {
    const ck = compositeKey(opts.scope, opts.conversationKey);
    const existing = this.byKey.get(ck);
    if (existing !== undefined && !existing.isDestroyed) {
      return existing;
    }
    if (existing !== undefined) {
      this.removeFromIndex(existing);
    }

    const conv = new Conversation({
      scope: opts.scope,
      conversationKey: opts.conversationKey,
      factory: opts.factory,
      catalog: this,
      store: opts.store,
      ttl: this.ttl,
      buildSpawnHooks: opts.buildSpawnHooks,
      eventBus: this.eventBus,
    });

    this.byKey.set(ck, conv);
    let scopeSet = this.byScope.get(opts.scope);
    if (scopeSet === undefined) {
      scopeSet = new Set();
      this.byScope.set(opts.scope, scopeSet);
    }
    scopeSet.add(conv);
    return conv;
  }

  // =========================================================================
  // Slot acquisition — fast path → LRU eviction → FIFO queue
  // =========================================================================

  /**
   * Acquire a slot for `conv`. Returns one of three discriminants — see
   * `SlotResult` JSDoc for the full semantics. `findLRUVictim()` runs
   * synchronously here so the swap-vs-queue classification is made up-front
   * (rather than inside a single `async` branch); this is what lets the
   * caller stay silent on the bus during the transient swap window.
   */
  acquireSlot(conv: Conversation): SlotResult {
    const fast = this.pool.tryAcquire();
    if (fast !== null) return { kind: 'sync', slot: fast };
    const victim = this.findLRUVictim();
    if (victim !== null && victim !== conv) {
      return { kind: 'swap', promise: this.swapAndAcquire(conv, victim) };
    }
    return { kind: 'queued', promise: this.pool.acquire(conv) };
  }

  private async swapAndAcquire(conv: Conversation, victim: Conversation): Promise<Slot> {
    await victim.yieldSlot();
    // Post-yield re-check: another caller may have grabbed the freed slot
    // first. If so the swap path falls through to FIFO — the conversation
    // is now genuinely FIFO-queued, so notify it to transition to
    // `awaiting-slot` (which fires `queued{active:true}` via the bus
    // chokepoint). Without this notify, the bus would diverge from the
    // runtime truth.
    const second = this.pool.tryAcquire();
    if (second !== null) return second;
    conv.markSwapFellThrough();
    return this.pool.acquire(conv);
  }

  // =========================================================================
  // findLRUVictim — cross-scope LRU
  // =========================================================================

  /** Iterate ALL conversations across all scopes, filter to idle-with-runner,
   *  return the one with the smallest lastActive timestamp. */
  findLRUVictim(): Conversation | null {
    let best: Conversation | null = null;
    for (const conv of this.byKey.values()) {
      if (conv.state !== 'idle-with-runner') continue;
      if (best === null || conv.lastActive < best.lastActive) {
        best = conv;
      }
    }
    return best;
  }

  // =========================================================================
  // maybeEvictForWaiters — called by Conversation on transition to idle-with-runner
  // =========================================================================

  /**
   * Conversation just became `idle-with-runner`. If waiters are pending in
   * the pool, the policy is: any idle conv becomes evictable (matches today's
   * `handleIdle` behavior). Fire-and-forget the yield; the slot release
   * inside yieldSlot drains the waiter queue.
   */
  maybeEvictForWaiters(conv: Conversation): void {
    if (this._shuttingDown) return;
    if (!this.pool.hasWaiters) return;
    if (conv.state !== 'idle-with-runner') return;
    // skipDrain: false — we WANT the queued waiter to wake on the release.
    void conv.yieldSlot({ skipDrain: false });
  }

  // =========================================================================
  // unregister — Conversation transitions to destroyed
  // =========================================================================

  unregister(conv: Conversation): void {
    // If the conv was awaiting a slot when it transitioned to destroyed, the
    // pool queue still holds its token. Cancel-on-unregister keeps the queue
    // clean (idempotent — no-op if not queued).
    this.pool.cancel(conv);
    this.removeFromIndex(conv);
    this.ttl.cancelTtl(conv);
  }

  // =========================================================================
  // Shutdown
  // =========================================================================

  async shutdownScope(scope: string): Promise<void> {
    const scopeSet = this.byScope.get(scope);
    if (scopeSet === undefined) return;
    await this.tearDown(Array.from(scopeSet));
    this.ttl.shutdownScope(scope);
  }

  async shutdownAll(): Promise<void> {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    await this.tearDown(Array.from(this.byKey.values()));
    this.pool.shutdown();
    this.ttl.shutdown();
  }

  /** Test-only: synchronously wipe the catalog + pool + ttl without
   *  awaiting per-conv destroyers. Used by per-suite `beforeEach` to start
   *  from a clean slate. Production code should use shutdownAll. */
  _reset(): void {
    this.byKey.clear();
    this.byScope.clear();
    this._shuttingDown = false;
    this.pool._reset();
    this.ttl._reset();
  }

  /** Shutdown chokepoint: pre-cancels any pool waiters then awaits a parallel
   *  shutdown of every Conversation. Used by both `shutdownScope` and
   *  `shutdownAll` so the cancel-then-await sequence has one home. */
  private async tearDown(convs: Conversation[]): Promise<void> {
    for (const conv of convs) {
      if (conv.state === 'awaiting-slot') this.pool.cancel(conv);
    }
    await Promise.all(convs.map((c) => this.safeShutdown(c)));
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  private removeFromIndex(conv: Conversation): void {
    this.byKey.delete(compositeKey(conv.scope, conv.key));
    const scopeSet = this.byScope.get(conv.scope);
    if (scopeSet !== undefined) {
      scopeSet.delete(conv);
      if (scopeSet.size === 0) this.byScope.delete(conv.scope);
    }
  }

  private async safeShutdown(conv: Conversation): Promise<void> {
    try {
      await conv.shutdown();
    } catch (err) {
      logger.error(
        { scope: conv.scope, key: conv.key, err },
        'ConversationCatalog.shutdown: conv.shutdown threw',
      );
    }
  }
}
