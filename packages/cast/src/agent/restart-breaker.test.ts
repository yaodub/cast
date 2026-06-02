/**
 * Tests for RestartBreaker — both branches per the both-branches discipline.
 * Reject cases (breaker trips) AND allow cases (breaker stays ok) are
 * exercised so the predicate ships in a known-bidirectional state.
 */
import { describe, it, expect } from 'vitest';

import { RestartBreaker } from './restart-breaker.js';

describe('RestartBreaker — trip branch', () => {
  it('trips when restart count reaches the cap within the window', () => {
    const b = new RestartBreaker(5, 60_000);
    expect(b.record(0).kind).toBe('ok');
    expect(b.record(1).kind).toBe('ok');
    expect(b.record(2).kind).toBe('ok');
    expect(b.record(3).kind).toBe('ok');
    const fifth = b.record(4);
    expect(fifth.kind).toBe('tripped');
    if (fifth.kind === 'tripped') expect(fifth.reason).toMatch(/5 restarts/);
  });

  it('stays tripped on subsequent records without further accounting', () => {
    const b = new RestartBreaker(3, 60_000);
    b.record(0); b.record(1); b.record(2);
    expect(b.tripped).toBe(true);
    const before = b.record(3);
    const after = b.record(4);
    expect(before).toEqual(after);
  });

  it('trips on fast crashes regardless of small inter-arrival times', () => {
    const b = new RestartBreaker(5, 60_000);
    // All 5 restarts within 1ms — burst pattern.
    for (let i = 0; i < 4; i++) expect(b.record(i).kind).toBe('ok');
    expect(b.record(4).kind).toBe('tripped');
  });
});

describe('RestartBreaker — ok branch', () => {
  it('does not trip when restarts are spaced beyond the window', () => {
    const b = new RestartBreaker(5, 60_000);
    // Each restart is 30s after the previous — older ones drop out of the window
    // before the next arrives.
    expect(b.record(0).kind).toBe('ok');
    expect(b.record(30_000).kind).toBe('ok');
    expect(b.record(70_000).kind).toBe('ok');  // 0 is now outside
    expect(b.record(110_000).kind).toBe('ok'); // 30_000 is now outside
    expect(b.record(150_000).kind).toBe('ok'); // 70_000 is now outside
    expect(b.tripped).toBe(false);
  });

  it('does not trip on the cap-minus-one count', () => {
    const b = new RestartBreaker(5, 60_000);
    for (let i = 0; i < 4; i++) expect(b.record(i).kind).toBe('ok');
    expect(b.tripped).toBe(false);
  });

  it('prunes timestamps older than the window before counting', () => {
    const b = new RestartBreaker(3, 1_000);
    b.record(0);
    b.record(500);
    // 1500 → cutoff is 500; t=0 prunes, [500, 1500] remains, length 2 < 3.
    expect(b.record(1500).kind).toBe('ok');
    expect(b.tripped).toBe(false);
  });
});

describe('RestartBreaker — reset', () => {
  it('clears trip state', () => {
    const b = new RestartBreaker(3, 60_000);
    b.record(0); b.record(1); b.record(2);
    expect(b.tripped).toBe(true);
    b.reset();
    expect(b.tripped).toBe(false);
  });

  it('clears timestamp history so the next record starts fresh', () => {
    const b = new RestartBreaker(3, 60_000);
    b.record(0); b.record(1);
    b.reset();
    // After reset, two more records should not trip even though pre-reset we
    // were one away from tripping.
    expect(b.record(2).kind).toBe('ok');
    expect(b.record(3).kind).toBe('ok');
    expect(b.tripped).toBe(false);
  });
});
