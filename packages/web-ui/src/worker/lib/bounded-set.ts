/**
 * Bounded LRU-ish set. Insertions past `cap` evict the oldest insertion.
 * Used for `processedIds` in chat ingest — bounds memory in long-lived
 * SharedWorkers without losing the recent dedup window.
 */
export class BoundedSet<T> {
  private readonly cap: number;
  private readonly items = new Set<T>();

  constructor(cap: number) {
    if (cap <= 0) throw new Error(`BoundedSet cap must be positive, got ${cap}`);
    this.cap = cap;
  }

  has(item: T): boolean {
    return this.items.has(item);
  }

  add(item: T): void {
    if (this.items.has(item)) return;
    if (this.items.size >= this.cap) {
      // Evict oldest (Set insertion order).
      const oldest = this.items.values().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
    this.items.add(item);
  }

  get size(): number {
    return this.items.size;
  }
}
