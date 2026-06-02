/**
 * SlotPool — concurrency primitive with typed Slot tokens, identity dedup,
 * cancel, and idempotent release.
 *
 * Bug-class regression guards in this file:
 *
 * - **B2 (FIFO dedup-by-key collision):** structurally unrepresentable because
 *   dedup is keyed by object identity. The same Conversation enqueuing itself
 *   twice resolves to ONE waiter, not two stale entries.
 * - **R5 (release-arithmetic underflow):** structurally unrepresentable because
 *   each Slot is a unique object that tracks its own released bit. Releasing
 *   twice is a no-op on the second call; no clamp arithmetic needed.
 * - **R7 (queue-leak on cancel):** structurally unrepresentable because
 *   `cancel(token)` removes the waiter and rejects its promise.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SlotPool } from './slot-pool.js';

describe('SlotPool — sync acquire (tryAcquire)', () => {
  let pool: SlotPool;

  beforeEach(() => {
    pool = new SlotPool(2);
  });

  it('returns a Slot when capacity available', () => {
    const slot = pool.tryAcquire();
    expect(slot).not.toBeNull();
    expect(pool.active).toBe(1);
    expect(pool.waiting).toBe(0);
  });

  it('returns null when saturated', () => {
    pool.tryAcquire();
    pool.tryAcquire();
    expect(pool.tryAcquire()).toBeNull();
    expect(pool.active).toBe(2);
  });

  it('releases free up slots for subsequent tryAcquire', () => {
    const s1 = pool.tryAcquire()!;
    pool.tryAcquire();
    expect(pool.tryAcquire()).toBeNull();
    s1.release();
    expect(pool.active).toBe(1);
    expect(pool.tryAcquire()).not.toBeNull();
  });

  it('returns null while shutting down', () => {
    pool.shutdown();
    expect(pool.tryAcquire()).toBeNull();
  });
});

describe('SlotPool — async acquire (queue + dispatch)', () => {
  let pool: SlotPool;

  beforeEach(() => {
    pool = new SlotPool(1);
  });

  it('resolves immediately when capacity available', async () => {
    const token = {};
    const slot = await pool.acquire(token);
    expect(slot.released).toBe(false);
    expect(pool.active).toBe(1);
  });

  it('enqueues when saturated; resolves on release', async () => {
    const held = pool.tryAcquire()!;
    const token = {};
    const pending = pool.acquire(token);
    expect(pool.waiting).toBe(1);
    held.release();
    const slot = await pending;
    expect(slot.released).toBe(false);
    expect(pool.waiting).toBe(0);
    expect(pool.active).toBe(1);
  });

  it('FIFO order verified end-to-end', async () => {
    const held = pool.tryAcquire()!;
    const tokenA = { name: 'A' };
    const tokenB = { name: 'B' };
    const tokenC = { name: 'C' };
    const order: string[] = [];
    const pA = pool.acquire(tokenA).then((s) => {
      order.push('A');
      return s;
    });
    const pB = pool.acquire(tokenB).then((s) => {
      order.push('B');
      return s;
    });
    const pC = pool.acquire(tokenC).then((s) => {
      order.push('C');
      return s;
    });

    expect(pool.waiting).toBe(3);
    held.release();
    const sA = await pA;
    expect(order).toEqual(['A']);

    sA.release();
    const sB = await pB;
    expect(order).toEqual(['A', 'B']);

    sB.release();
    const sC = await pC;
    expect(order).toEqual(['A', 'B', 'C']);
    sC.release();
  });

  it('rejects when shutting down at call time', async () => {
    pool.shutdown();
    await expect(pool.acquire({})).rejects.toThrow(/shutting down/);
  });

  it('rejects existing waiters on shutdown', async () => {
    pool.tryAcquire();
    const tokenA = {};
    const tokenB = {};
    const pA = pool.acquire(tokenA);
    const pB = pool.acquire(tokenB);
    pool.shutdown();
    await expect(pA).rejects.toThrow(/shutting down/);
    await expect(pB).rejects.toThrow(/shutting down/);
  });
});

describe('SlotPool — token-identity dedup (B2 regression guard)', () => {
  let pool: SlotPool;

  beforeEach(() => {
    pool = new SlotPool(1);
  });

  it('same token enqueued twice produces one waiter', async () => {
    pool.tryAcquire();
    const token = { conv: 'one' };
    const p1 = pool.acquire(token);
    const p2 = pool.acquire(token);
    expect(pool.waiting).toBe(1); // not 2
    // Same promise reference
    expect(p1).toBe(p2);
  });

  it('different tokens produce separate waiters even with equal contents', async () => {
    pool.tryAcquire();
    const tokenA = { conv: 'one' };
    const tokenB = { conv: 'one' }; // structurally equal but different identity
    pool.acquire(tokenA);
    pool.acquire(tokenB);
    expect(pool.waiting).toBe(2);
  });

  it('both deduplicated awaiters resolve with the same Slot', async () => {
    const held = pool.tryAcquire()!;
    const token = {};
    const p1 = pool.acquire(token);
    const p2 = pool.acquire(token);
    held.release();
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1).toBe(s2);
  });
});

describe('SlotPool — cancel', () => {
  let pool: SlotPool;

  beforeEach(() => {
    pool = new SlotPool(1);
  });

  it('cancel rejects the pending promise and removes from queue', async () => {
    pool.tryAcquire();
    const token = {};
    const pending = pool.acquire(token);
    expect(pool.waiting).toBe(1);
    pool.cancel(token);
    expect(pool.waiting).toBe(0);
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it('cancel is no-op for unknown token', () => {
    expect(() => pool.cancel({})).not.toThrow();
  });

  it('cancel does not affect other waiters', async () => {
    pool.tryAcquire();
    const tokenA = {};
    const tokenB = {};
    const pA = pool.acquire(tokenA);
    const pB = pool.acquire(tokenB);
    pool.cancel(tokenA);
    expect(pool.waiting).toBe(1);
    await expect(pA).rejects.toThrow(/cancelled/);
    void pB;
  });

  it('cancel cleans up a token that was previously deduped', async () => {
    pool.tryAcquire();
    const token = {};
    const p1 = pool.acquire(token);
    const p2 = pool.acquire(token);
    expect(p1).toBe(p2);
    pool.cancel(token);
    expect(pool.waiting).toBe(0);
    await expect(p1).rejects.toThrow(/cancelled/);
    await expect(p2).rejects.toThrow(/cancelled/);
  });
});

describe('SlotPool — Slot.release idempotency (R5 regression guard)', () => {
  it('double-release does not under-count active slots', () => {
    const pool = new SlotPool(2);
    const slot = pool.tryAcquire()!;
    expect(pool.active).toBe(1);
    slot.release();
    expect(pool.active).toBe(0);
    slot.release(); // idempotent: no-op
    expect(pool.active).toBe(0);
  });

  it('Slot.released flag flips after first release', () => {
    const pool = new SlotPool(1);
    const slot = pool.tryAcquire()!;
    expect(slot.released).toBe(false);
    slot.release();
    expect(slot.released).toBe(true);
    slot.release();
    expect(slot.released).toBe(true);
  });

  it('two slots release independently', () => {
    const pool = new SlotPool(2);
    const s1 = pool.tryAcquire()!;
    const s2 = pool.tryAcquire()!;
    expect(pool.active).toBe(2);
    s1.release();
    expect(pool.active).toBe(1);
    expect(s1.released).toBe(true);
    expect(s2.released).toBe(false);
    s2.release();
    expect(pool.active).toBe(0);
  });
});

describe('SlotPool — skipDrain (swap-on-pressure path)', () => {
  let pool: SlotPool;

  beforeEach(() => {
    pool = new SlotPool(1);
  });

  it('skipDrain releases the slot without waking a waiter', async () => {
    const held = pool.tryAcquire()!;
    const token = {};
    let resolved = false;
    void pool.acquire(token).then(() => {
      resolved = true;
    });
    expect(pool.waiting).toBe(1);

    held.release({ skipDrain: true });

    // Slot count drops but waiter is not dispatched.
    expect(pool.active).toBe(0);
    expect(pool.waiting).toBe(1);
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('caller can immediately re-acquire the freed slot after skipDrain', async () => {
    const held = pool.tryAcquire()!;
    void pool.acquire({}); // dummy waiter
    held.release({ skipDrain: true });

    // skipDrain made the slot reusable without waking the waiter
    const fresh = pool.tryAcquire();
    expect(fresh).not.toBeNull();
    expect(pool.active).toBe(1);
  });
});

describe('SlotPool — shutdown', () => {
  it('shutdown is idempotent', () => {
    const pool = new SlotPool(1);
    pool.shutdown();
    expect(() => pool.shutdown()).not.toThrow();
    expect(pool.shuttingDown).toBe(true);
  });

  it('held slots survive shutdown and may still release', () => {
    const pool = new SlotPool(1);
    const slot = pool.tryAcquire()!;
    pool.shutdown();
    expect(pool.active).toBe(1);
    slot.release();
    expect(pool.active).toBe(0);
  });
});

describe('SlotPool — constructor validation', () => {
  it('rejects capacity < 1', () => {
    expect(() => new SlotPool(0)).toThrow(/capacity must be/);
    expect(() => new SlotPool(-1)).toThrow(/capacity must be/);
  });
});

