import { describe, it, expect, beforeEach } from 'vitest';

import { PanicRegistry } from './panic-registry.js';

describe('PanicRegistry', () => {
  let reg: PanicRegistry;

  beforeEach(() => {
    reg = new PanicRegistry();
  });

  describe('halt / getHaltState / isHalted', () => {
    it('returns null for never-halted keys', () => {
      expect(reg.getHaltState('a:foo')).toBeNull();
      expect(reg.isHalted('a:foo')).toBe(false);
    });

    it('records halt with until = now + duration', () => {
      const now = 1_000_000;
      const state = reg.halt('a:foo', 'spawn_rate', 'test', 5000, now);
      expect(state).toEqual({
        button: 'spawn_rate',
        reason: 'test',
        haltedAt: now,
        until: now + 5000,
      });
      expect(reg.isHalted('a:foo', now)).toBe(true);
      expect(reg.isHalted('a:foo', now + 4999)).toBe(true);
    });

    it('lazy-expires halts at `until` boundary', () => {
      const now = 1_000_000;
      reg.halt('a:foo', 'spawn_rate', 'test', 5000, now);
      expect(reg.isHalted('a:foo', now + 5000)).toBe(false);
      expect(reg.getHaltState('a:foo', now + 5000)).toBeNull();
    });

    it('re-halting overwrites the prior record (last-writer-wins)', () => {
      const now = 1_000_000;
      reg.halt('a:foo', 'spawn_rate', 'first', 5000, now);
      const second = reg.halt('a:foo', 'abnormal_exit_rate', 'second', 1000, now + 100);
      expect(reg.getHaltState('a:foo', now + 100)).toEqual(second);
    });

    it('halts are independent per key', () => {
      const now = 1_000_000;
      reg.halt('a:foo', 'spawn_rate', 'test', 5000, now);
      expect(reg.isHalted('a:bar', now)).toBe(false);
    });
  });

  describe('recordSpawn — button #1 spawn-rate', () => {
    it('returns null below threshold', () => {
      const now = 1_000_000;
      for (let i = 0; i < 19; i++) {
        expect(reg.recordSpawn('a:foo', now + i)).toBeNull();
      }
      expect(reg.isHalted('a:foo', now + 19)).toBe(false);
    });

    it('trips on the 20th spawn within the window', () => {
      const now = 1_000_000;
      let halt = null;
      for (let i = 0; i < 20; i++) {
        halt = reg.recordSpawn('a:foo', now + i);
      }
      expect(halt).not.toBeNull();
      expect(halt!.button).toBe('spawn_rate');
      expect(halt!.reason).toMatch(/20 spawns in 60s window/);
      // 10 min halt
      expect(halt!.until - halt!.haltedAt).toBe(10 * 60_000);
    });

    it('does not trip when spawns are spread outside the 60s window', () => {
      // 19 spawns 4 seconds apart → 76 seconds total. Sliding window
      // never sees more than ~15 at once.
      let halt = null;
      for (let i = 0; i < 19; i++) {
        halt = reg.recordSpawn('a:foo', 4000 * i);
      }
      expect(halt).toBeNull();
      expect(reg.isHalted('a:foo', 4000 * 18)).toBe(false);
    });

    it('prunes stale timestamps from the ring buffer', () => {
      const t = 1_000_000;
      // 19 spawns at t, then 19 more at t + 70s (outside window of t).
      for (let i = 0; i < 19; i++) reg.recordSpawn('a:foo', t);
      for (let i = 0; i < 19; i++) reg.recordSpawn('a:foo', t + 70_000);
      // Still no trip — the first 19 are pruned by the time the second
      // batch is recorded.
      expect(reg.isHalted('a:foo', t + 70_000)).toBe(false);
    });
  });

  describe('recordAbnormalExitBurst — button #5', () => {
    it('returns null below the count threshold', () => {
      const now = 1_000_000;
      expect(reg.recordAbnormalExitBurst('a:foo', now, 2, now + 100)).toBeNull();
      expect(reg.isHalted('a:foo', now + 100)).toBe(false);
    });

    it('returns null when burst is slower than 10s window', () => {
      const now = 1_000_000;
      // 3 exits but spread over 11s
      expect(reg.recordAbnormalExitBurst('a:foo', now, 3, now + 11_000)).toBeNull();
      expect(reg.isHalted('a:foo', now + 11_000)).toBe(false);
    });

    it('escalates to halt when 3+ within 10s', () => {
      const now = 1_000_000;
      const halt = reg.recordAbnormalExitBurst('a:foo', now, 3, now + 5_000);
      expect(halt).not.toBeNull();
      expect(halt!.button).toBe('abnormal_exit_rate');
      expect(halt!.reason).toMatch(/3 abnormal exits in 5000ms/);
      expect(halt!.until - halt!.haltedAt).toBe(60_000);
    });

    it('uses now-of-trip as haltedAt, not firstAbnormalAt', () => {
      const first = 1_000_000;
      const nowAtTrip = first + 5_000;
      const halt = reg.recordAbnormalExitBurst('a:foo', first, 3, nowAtTrip);
      expect(halt!.haltedAt).toBe(nowAtTrip);
    });
  });

  describe('halted() iterator', () => {
    it('skips expired halts', () => {
      const now = 1_000_000;
      reg.halt('a:foo', 'spawn_rate', 'live', 5_000, now);
      reg.halt('a:bar', 'spawn_rate', 'expired', 1_000, now);
      const live = Array.from(reg.halted(now + 2_000));
      expect(live).toHaveLength(1);
      expect(live[0]![0]).toBe('a:foo');
    });
  });

  describe('_reset', () => {
    it('clears halts and spawn buffers', () => {
      const now = 1_000_000;
      reg.halt('a:foo', 'spawn_rate', 'test', 5_000, now);
      for (let i = 0; i < 10; i++) reg.recordSpawn('a:bar', now + i);
      reg._reset();
      expect(reg.isHalted('a:foo', now)).toBe(false);
      // Buffer for 'a:bar' is empty; 19 fresh spawns should not trip.
      let halt = null;
      for (let i = 0; i < 19; i++) {
        halt = reg.recordSpawn('a:bar', now + 1000 + i);
      }
      expect(halt).toBeNull();
    });
  });
});
