/**
 * ConversationCatalog — global catalog + paging policy. Tests cover:
 *
 * - getOrCreate atomicity + replacement of destroyed entries
 * - acquireSlot fast path / pressure path (LRU eviction)
 * - findLRUVictim cross-scope iteration
 * - maybeEvictForWaiters policy
 * - scope-isolation (inScope, shutdownScope)
 * - unregister cleans up pool queue + TTL
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { _resetPanicRegistryForTest } from '../lib/panic-registry.js';

beforeEach(() => {
  _resetPanicRegistryForTest();
});

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ConversationCatalog } from './catalog.js';
import { Conversation, type BuildSpawnHooks } from './conversation.js';
import { ConversationEventBus } from './event-bus.js';
import { SlotPool } from './slot-pool.js';
import { ConversationTtl } from './ttl.js';
import type {
  Runner,
  RunnerFactory,
  SpawnOutcome,
  SpawnHooks,
  PendingMessage,
  TeardownMode,
} from './runner.js';
import { AgentStateStore } from '../agent/state-store.js';

// =============================================================================
// Fixtures
// =============================================================================

function makeStore(): AgentStateStore {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-catalog-test-'));
  return new AgentStateStore(tmpDir);
}

function makeMockRunner(): Runner & {
  spawnSpy: Mock<(p: PendingMessage[], h: SpawnHooks) => void>;
  destroySpy: Mock<() => void>;
} {
  let destroyed = false;
  const spawnSpy = vi.fn<(p: PendingMessage[], h: SpawnHooks) => void>();
  const destroySpy = vi.fn<() => void>();
  return {
    spawnSpy,
    destroySpy,
    async spawn(prompt, hooks): Promise<SpawnOutcome> {
      spawnSpy(prompt, hooks);
      return { type: 'settled', result: null, outputSent: true };
    },
    pipeMessage(): boolean {
      return true;
    },
    close(): void {},
    async destroy(_mode: TeardownMode): Promise<boolean> {
      destroySpy();
      destroyed = true;
      return true;
    },
    async emitAuthExhausted(): Promise<void> {},
    get ccSessionId() {
      return undefined;
    },
    get isDestroyed() {
      return destroyed;
    },
    get activeProcess() {
      return null;
    },
    get activeContainerName() {
      return null;
    },
  };
}

function makeBuildSpawnHooks(): BuildSpawnHooks {
  return vi.fn(() => ({} as SpawnHooks));
}

interface CatalogFixture {
  catalog: ConversationCatalog;
  pool: SlotPool;
  ttl: ConversationTtl;
  store: AgentStateStore;
  factory: RunnerFactory;
  eventBus: ConversationEventBus;
}

function makeFixture(capacity = 4): CatalogFixture {
  const pool = new SlotPool(capacity);
  const ttl = new ConversationTtl();
  const store = makeStore();
  const factory: RunnerFactory = () => makeMockRunner();
  const eventBus = new ConversationEventBus();
  const catalog = new ConversationCatalog({ pool, ttl, eventBus });
  return { catalog, pool, ttl, store, factory, eventBus };
}

async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// =============================================================================
// Tests — getOrCreate
// =============================================================================

describe('ConversationCatalog — getOrCreate', () => {
  it('creates and registers a new Conversation', () => {
    const f = makeFixture();
    const c = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    expect(c.scope).toBe('agent:a');
    expect(c.key).toBe('k1');
    expect(f.catalog.has('agent:a', 'k1')).toBe(true);
    expect(f.catalog.size).toBe(1);
  });

  it('returns the same Conversation on repeated calls (stable reference)', () => {
    const f = makeFixture();
    const c1 = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    const c2 = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    expect(c1).toBe(c2);
    expect(f.catalog.size).toBe(1);
  });

  it('different (scope, key) produce different Conversations', () => {
    const f = makeFixture();
    const a = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    const b = f.catalog.getOrCreate({
      scope: 'agent:b',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    expect(a).not.toBe(b);
    expect(f.catalog.size).toBe(2);
  });

  it('same key in different scopes does not collide', () => {
    const f = makeFixture();
    f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    f.catalog.getOrCreate({
      scope: 'agent:b',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    expect(f.catalog.has('agent:a', 'k1')).toBe(true);
    expect(f.catalog.has('agent:b', 'k1')).toBe(true);
  });
});

// =============================================================================
// Tests — lookup
// =============================================================================

describe('ConversationCatalog — lookup', () => {
  it('get returns the Conversation or undefined', () => {
    const f = makeFixture();
    expect(f.catalog.get('agent:a', 'missing')).toBeUndefined();
    const c = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    expect(f.catalog.get('agent:a', 'k1')).toBe(c);
  });

  it('inScope yields conversations in the scope only', () => {
    const f = makeFixture();
    f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k2',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    f.catalog.getOrCreate({
      scope: 'agent:b',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    const aKeys = [...f.catalog.inScope('agent:a')].map((c) => c.key).sort();
    expect(aKeys).toEqual(['k1', 'k2']);
    const bKeys = [...f.catalog.inScope('agent:b')].map((c) => c.key).sort();
    expect(bKeys).toEqual(['k1']);
  });

  it('inScope for unknown scope yields empty iterator', () => {
    const f = makeFixture();
    const result = [...f.catalog.inScope('agent:nonexistent')];
    expect(result).toEqual([]);
  });
});

// =============================================================================
// Tests — acquireSlot fast path
// =============================================================================

describe('ConversationCatalog — acquireSlot fast path', () => {
  it('returns kind:sync with a slot when capacity is available', () => {
    const f = makeFixture(2);
    const conv = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    const result = f.catalog.acquireSlot(conv);
    expect(result.kind).toBe('sync');
    if (result.kind === 'sync') expect(result.slot).toBeDefined();
    expect(f.pool.active).toBe(1);
  });
});

// =============================================================================
// Tests — findLRUVictim + acquireSlot pressure path
// =============================================================================

describe('ConversationCatalog — LRU eviction (pressure path)', () => {
  it('findLRUVictim returns null when no idle-with-runner candidates', () => {
    const f = makeFixture(1);
    f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    // Conversation is in idle-no-runner; not a victim.
    expect(f.catalog.findLRUVictim()).toBeNull();
  });

  it('findLRUVictim returns the idle-with-runner conv with smallest lastActive', async () => {
    const f = makeFixture(2);
    const a = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    await a.deliver('hi', {});
    const aActive = a.lastActive;
    // Wait so b has later lastActive
    await new Promise((r) => setTimeout(r, 5));
    const b = f.catalog.getOrCreate({
      scope: 'agent:b',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    await b.deliver('hi', {});
    expect(a.lastActive).toBe(aActive);
    expect(b.lastActive > a.lastActive).toBe(true);
    expect(f.catalog.findLRUVictim()).toBe(a);
  });

  it('acquireSlot under pressure evicts an LRU victim then acquires', async () => {
    const f = makeFixture(1);
    const a = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    await a.deliver('hi', {});
    expect(a.state).toBe('idle-with-runner');
    expect(f.pool.active).toBe(1);

    // Try to get a slot for a new conv — pool is saturated; catalog evicts a.
    const b = f.catalog.getOrCreate({
      scope: 'agent:b',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    await b.deliver('hi', {});
    // After eviction + spawn, b has the slot; a is back to idle-no-runner.
    expect(b.state).toBe('idle-with-runner');
    expect(a.state).toBe('idle-no-runner');
    expect(f.pool.active).toBe(1);
  });
});

// =============================================================================
// Swap-vs-queue discriminant in acquireSlot
// =============================================================================

describe('ConversationCatalog — swap/queue discriminant', () => {
  it('returns kind:swap when at capacity with an idle-with-runner victim', async () => {
    const f = makeFixture(1);
    const a = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    await a.deliver('hi', {});
    expect(a.state).toBe('idle-with-runner');
    expect(f.pool.active).toBe(1);

    const b = f.catalog.getOrCreate({
      scope: 'agent:b',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    const result = f.catalog.acquireSlot(b);
    expect(result.kind).toBe('swap');
    // Drain the promise so we don't leak a dangling acquire.
    if (result.kind === 'swap') {
      const slot = await result.promise;
      slot.release();
    }
  });

  it('returns kind:queued when at capacity with no swap victim', () => {
    const f = makeFixture(1);
    const a = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    // Pre-claim the slot without spawning a runner — a stays in idle-no-runner
    // (not a swap victim) but the pool is saturated.
    const heldSlot = f.pool.tryAcquire();
    expect(heldSlot).not.toBeNull();
    expect(a.state).toBe('idle-no-runner');
    expect(f.catalog.findLRUVictim()).toBeNull();

    const b = f.catalog.getOrCreate({
      scope: 'agent:b',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    const result = f.catalog.acquireSlot(b);
    expect(result.kind).toBe('queued');
    // Drain: cancel the pool waiter so the queued promise rejects.
    f.pool.cancel(b);
    if (result.kind === 'queued') {
      void result.promise.catch(() => {});
    }
    heldSlot!.release();
  });

  it('swap path success emits no queued{active:true} for the swapping conv', async () => {
    const f = makeFixture(1);
    const a = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    await a.deliver('hi', {});

    // Subscribe to the bus and watch for queued events targeting b.
    const queuedEvents: boolean[] = [];
    const unsub = f.eventBus.subscribe({ kinds: ['queued'], scope: 'agent:b' }, (evt) => {
      if (evt.kind !== 'queued') return;
      queuedEvents.push(evt.active);
    });

    const b = f.catalog.getOrCreate({
      scope: 'agent:b',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    await b.deliver('hi', {});
    expect(b.state).toBe('idle-with-runner');
    // Swap path succeeded: no queued{active:true} event for b.
    expect(queuedEvents).toEqual([]);
    unsub();
  });

  it('swap path fall-through to FIFO calls markSwapFellThrough and emits queued{active:true}', async () => {
    const f = makeFixture(1);
    const a = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    await a.deliver('hi', {});
    expect(a.state).toBe('idle-with-runner');

    const b = f.catalog.getOrCreate({
      scope: 'agent:b',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });

    // Spy markSwapFellThrough so we can confirm the catalog called it.
    const markSpy = vi.spyOn(b, 'markSwapFellThrough');

    // Force the swap's post-yield retry to fail by stealing the freed slot
    // synchronously the moment yieldSlot's release fires. We patch
    // pool.tryAcquire to return null on its second invocation (after yield),
    // simulating a parallel caller winning the race.
    const originalTryAcquire = f.pool.tryAcquire.bind(f.pool);
    let call = 0;
    vi.spyOn(f.pool, 'tryAcquire').mockImplementation(() => {
      call += 1;
      // First call (in acquireSlot fast-path check) — let it run normally.
      // Second call (in swapAndAcquire post-yield) — force null.
      if (call === 2) return null;
      return originalTryAcquire();
    });

    const queuedEvents: boolean[] = [];
    const unsub = f.eventBus.subscribe({ kinds: ['queued'], scope: 'agent:b' }, (evt) => {
      if (evt.kind !== 'queued') return;
      queuedEvents.push(evt.active);
    });

    const result = f.catalog.acquireSlot(b);
    expect(result.kind).toBe('swap');
    if (result.kind !== 'swap') return;

    // The swap path will yield a's slot but the patched tryAcquire returns
    // null, so it falls through to pool.acquire(b). That call will block
    // because the pool's _active count was already decremented by the yield
    // (so there should be capacity), but our spy on tryAcquire only catches
    // the second call — the third (inside the FIFO drain) goes through.
    // Allow the swap to complete by releasing the steal.
    const slot = await result.promise;
    slot.release();

    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(queuedEvents).toContain(true);
    unsub();
  });
});

// =============================================================================
// Tests — maybeEvictForWaiters
// =============================================================================

describe('ConversationCatalog — maybeEvictForWaiters', () => {
  it('no waiters → no-op', async () => {
    const f = makeFixture(2);
    const a = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    await a.deliver('hi', {});
    expect(a.state).toBe('idle-with-runner');
    // No waiters; calling maybeEvictForWaiters is a no-op.
    f.catalog.maybeEvictForWaiters(a);
    await settle();
    expect(a.state).toBe('idle-with-runner');
  });

  it('with waiters → yields the conversation slot', async () => {
    const f = makeFixture(1);
    const a = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    await a.deliver('hi', {});
    expect(a.state).toBe('idle-with-runner');

    // Add a waiter by enqueueing an acquire from a different token.
    const otherToken = { name: 'waiter' };
    const waitingP = f.pool.acquire(otherToken);
    expect(f.pool.hasWaiters).toBe(true);

    f.catalog.maybeEvictForWaiters(a);
    const slot = await waitingP;
    expect(a.state).toBe('idle-no-runner');
    expect(slot.released).toBe(false);
    slot.release();
  });
});

// =============================================================================
// Tests — unregister
// =============================================================================

describe('ConversationCatalog — unregister', () => {
  it('removes the Conversation from the catalog', async () => {
    const f = makeFixture();
    const c = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    // Forcing destruction via expire(null) triggers unregister.
    await c.expire(null);
    expect(f.catalog.has('agent:a', 'k1')).toBe(false);
    expect(f.catalog.size).toBe(0);
  });

  it('TTL is cancelled on unregister', async () => {
    const f = makeFixture();
    const c = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    f.ttl.scheduleTtl(
      c,
      {
        conversationKey: 'k1',
        channelName: 'default',
        cleanup: undefined,
        cleanupEnabled: false,
        participant: 'cli:user',
        idle_timeout: 60_000,
      },
      5000,
    );
    expect(f.ttl.hasTimer(c)).toBe(true);
    await c.expire(null);
    expect(f.ttl.hasTimer(c)).toBe(false);
  });

  it('subsequent getOrCreate after unregister creates a fresh Conversation', async () => {
    const f = makeFixture();
    const c1 = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    await c1.expire(null);
    const c2 = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    expect(c2).not.toBe(c1);
    expect(c2.state).toBe('idle-no-runner');
  });
});

// =============================================================================
// Tests — shutdown
// =============================================================================

describe('ConversationCatalog — shutdown', () => {
  it('shutdownAll tears down all conversations across scopes', async () => {
    const f = makeFixture(2);
    const a = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    const b = f.catalog.getOrCreate({
      scope: 'agent:b',
      conversationKey: 'k2',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    await a.deliver('hi', {});
    await b.deliver('hi', {});
    await f.catalog.shutdownAll();
    expect(a.state).toBe('destroyed');
    expect(b.state).toBe('destroyed');
    expect(f.catalog.size).toBe(0);
  });

  it('shutdownScope tears down only the named scope', async () => {
    const f = makeFixture(2);
    const a = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    const b = f.catalog.getOrCreate({
      scope: 'agent:b',
      conversationKey: 'k2',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    await a.deliver('hi', {});
    await b.deliver('hi', {});
    await f.catalog.shutdownScope('agent:a');
    expect(a.state).toBe('destroyed');
    expect(b.state).toBe('idle-with-runner');
    expect(f.catalog.size).toBe(1);
  });

  it('shutdownAll cancels pending slot acquires (saturated pool)', async () => {
    const f = makeFixture(1);
    // Saturate the pool with a non-conversation holder
    const held = f.pool.tryAcquire();
    expect(held).not.toBeNull();

    const a = f.catalog.getOrCreate({
      scope: 'agent:a',
      conversationKey: 'k1',
      factory: f.factory,
      buildSpawnHooks: makeBuildSpawnHooks(),
      store: f.store,
    });
    const p = a.deliver('hi', {});
    await settle();
    expect(a.state).toBe('awaiting-slot');

    await f.catalog.shutdownAll();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(a.state).toBe('destroyed');
  });
});
