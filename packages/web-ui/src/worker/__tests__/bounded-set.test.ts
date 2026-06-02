/**
 * BoundedSet — LRU-ish dedup used by chat ingest's per-identity processedIds
 * cap. Wrong eviction here re-renders duplicate packets after the worker
 * sees more than `cap` distinct ids; bound the regression with a tight test.
 */
import { describe, expect, it } from 'vitest';

import { BoundedSet } from '../lib/bounded-set';

describe('BoundedSet', () => {
  it('rejects a non-positive cap', () => {
    expect(() => new BoundedSet(0)).toThrow();
    expect(() => new BoundedSet(-1)).toThrow();
  });

  it('reports membership after add', () => {
    const s = new BoundedSet<string>(3);
    s.add('a');
    expect(s.has('a')).toBe(true);
    expect(s.has('b')).toBe(false);
  });

  it('treats repeat add as a no-op (no eviction churn)', () => {
    const s = new BoundedSet<string>(2);
    s.add('a');
    s.add('a');
    s.add('a');
    expect(s.size).toBe(1);
  });

  it('evicts oldest insertion when cap is exceeded', () => {
    const s = new BoundedSet<string>(2);
    s.add('a');
    s.add('b');
    s.add('c');
    expect(s.has('a')).toBe(false);
    expect(s.has('b')).toBe(true);
    expect(s.has('c')).toBe(true);
    expect(s.size).toBe(2);
  });

  it('preserves cap across many adds', () => {
    const s = new BoundedSet<number>(5);
    for (let i = 0; i < 100; i++) s.add(i);
    expect(s.size).toBe(5);
    expect(s.has(99)).toBe(true);
    expect(s.has(95)).toBe(true);
    expect(s.has(94)).toBe(false);
  });
});
