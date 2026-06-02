/**
 * SlotPool — process-wide concurrency primitive that issues typed `Slot`
 * tokens.
 *
 * Notable properties:
 *
 * - **Typed `Slot` return.** `tryAcquire` / `acquire` return a `Slot` (or null)
 *   instead of a boolean. Releasing goes through `slot.release()`, so the pool
 *   cannot under- or over-release: each call site holds an opaque token that
 *   names exactly one slot. The audit's R5 finding (clamp-arithmetic hides
 *   underflow) is structurally unrepresentable.
 *
 * - **Token-identity dedup.** Waiters are deduped by object identity, not by
 *   string key. The Conversation passes `this` as the token. Two concurrent
 *   `acquire(this)` calls from the same Conversation share one waiter slot —
 *   no string-collision class (the B2 FIFO-dedup-by-key bug becomes
 *   unrepresentable).
 *
 * - **Cancellable.** `cancel(token)` removes a pending acquire from the queue
 *   and rejects its promise. Conversations destroyed mid-await unwind their
 *   deliver promise chain cleanly instead of leaking a dead queue entry.
 *
 * The pool knows nothing about conversations, paging, or what holds slots.
 * Policy lives one layer up in `ConversationCatalog`.
 */
import { logger } from '../logger.js';

export interface Slot {
  /**
   * Return the slot to the pool. Idempotent — subsequent calls are no-ops.
   *
   * `skipDrain: true` releases the slot without waking the next waiter. Used
   * by the swap-on-pressure path where the caller is about to immediately
   * re-acquire and doesn't want to race a queued waiter for the freed slot.
   */
  release(opts?: { skipDrain?: boolean }): void;
  readonly released: boolean;
}

interface Waiter {
  token: object;
  promise: Promise<Slot>;
  resolve: (slot: Slot) => void;
  reject: (err: Error) => void;
}

class SlotHandle implements Slot {
  private _released = false;

  constructor(private readonly pool: SlotPool) {}

  release(opts?: { skipDrain?: boolean }): void {
    if (this._released) return;
    this._released = true;
    this.pool._onSlotReleased(opts?.skipDrain ?? false);
  }

  get released(): boolean {
    return this._released;
  }
}

export class SlotPool {
  public readonly capacity: number;
  private _active = 0;
  private waiters: Waiter[] = [];
  private _shuttingDown = false;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error(`SlotPool: capacity must be >= 1 (got ${capacity})`);
    this.capacity = capacity;
  }

  get active(): number {
    return this._active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  get hasWaiters(): boolean {
    return this.waiters.length > 0;
  }

  get shuttingDown(): boolean {
    return this._shuttingDown;
  }

  /**
   * Try to acquire a slot synchronously. Returns a `Slot` if one is free,
   * or `null` if the pool is at capacity or shutting down.
   */
  tryAcquire(): Slot | null {
    if (this._shuttingDown) return null;
    if (this._active >= this.capacity) return null;
    this._active++;
    return new SlotHandle(this);
  }

  /**
   * Enqueue an acquire request and await a free slot. The `token` is an
   * opaque object whose identity dedups the waiter — calling `acquire(t)`
   * twice with the same `t` returns the same promise.
   *
   * If a slot is free at call time, the returned Promise is already
   * resolved (the `await` resumes on the next microtask, not the same
   * tick — "synchronously" would be misleading). If the pool is shutting
   * down, returns a rejected Promise.
   */
  acquire(token: object): Promise<Slot> {
    if (this._shuttingDown) {
      return Promise.reject(new Error('SlotPool: shutting down'));
    }
    const existing = this.waiters.find((w) => w.token === token);
    if (existing) return existing.promise;
    if (this._active < this.capacity) {
      this._active++;
      return Promise.resolve(new SlotHandle(this));
    }
    let resolve!: (slot: Slot) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<Slot>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.waiters.push({ token, promise, resolve, reject });
    return promise;
  }

  /**
   * Cancel a pending acquire. Removes `token` from the waiter queue and
   * rejects its promise with a cancellation error. No-op if the token is
   * not currently queued (already dispatched or never acquired).
   */
  cancel(token: object): void {
    const idx = this.waiters.findIndex((w) => w.token === token);
    if (idx === -1) return;
    const [w] = this.waiters.splice(idx, 1);
    w!.reject(new Error('SlotPool: acquire cancelled'));
  }

  /**
   * Reject all pending waiters and refuse further acquires. Held slots are
   * not revoked — callers continue to own and release them. Idempotent.
   */
  shutdown(): void {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    const pending = this.waiters.splice(0);
    for (const w of pending) {
      try {
        w.reject(new Error('SlotPool: shutting down'));
      } catch (err) {
        logger.error({ err }, 'SlotPool: waiter reject threw on shutdown');
      }
    }
  }

  /** Test-only reset. */
  _reset(): void {
    this._active = 0;
    this.waiters = [];
    this._shuttingDown = false;
  }

  /**
   * SIDE EFFECT: invoked by `SlotHandle.release()` only. Decrements `_active`
   * and dispatches one waiter per freed slot (unless `skipDrain` is set,
   * which the swap-on-pressure path uses to keep the freed slot for itself).
   */
  _onSlotReleased(skipDrain: boolean): void {
    this._active = Math.max(0, this._active - 1);
    if (skipDrain || this._shuttingDown) return;
    this.drain();
  }

  private drain(): void {
    while (this._active < this.capacity && this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      this._active++;
      try {
        w.resolve(new SlotHandle(this));
      } catch (err) {
        logger.error({ err }, 'SlotPool: waiter resolve threw on drain');
      }
    }
  }
}
