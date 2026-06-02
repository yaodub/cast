/**
 * ConversationTtl — per-conversation idle-timeout timers, keyed by Conversation
 * reference.
 *
 * Headline regression guard:
 *
 * - **TTL survives runner death.** Pre-refactor SessionHost cleared the idle
 *   timer in `swapVictim`, leaving swapped conversations immortal. The TTL is
 *   decoupled from any runner-bound state: it owns its own timer table keyed
 *   by Conversation reference. Nothing in the runner lifecycle can cancel it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ConversationTtl } from './ttl.js';
import type { ExpirableConversation, IdleTimeoutMeta } from './types.js';

/**
 * Minimal stub matching the ExpirableConversation contract. `expire` is a spy
 * so tests can assert it was called with the right cleanup payload.
 */
function makeConv(scope: string, key: string): ExpirableConversation & { expireSpy: ReturnType<typeof vi.fn> } {
  const expireSpy = vi.fn(async (_cleanup: string | null) => {});
  return {
    scope,
    key,
    expire: expireSpy,
    expireSpy,
  };
}

function metaFor(key: string, opts: Partial<IdleTimeoutMeta> = {}): IdleTimeoutMeta {
  return {
    conversationKey: key,
    channelName: 'default',
    cleanup: 'cleanup hint',
    cleanupEnabled: true,
    participant: `cli:user-${key}`,
    idle_timeout: 60_000,
    ...opts,
  };
}

describe('ConversationTtl — schedule + fire', () => {
  let ttl: ConversationTtl;

  beforeEach(() => {
    ttl = new ConversationTtl();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires conv.expire with the cleanup hint after delayMs', async () => {
    const conv = makeConv('agent:a', 'k1');
    ttl.scheduleTtl(conv, metaFor('k1'), 5000);

    expect(conv.expireSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4999);
    expect(conv.expireSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    // Flush the fire microtask
    await vi.runAllTimersAsync();
    expect(conv.expireSpy).toHaveBeenCalledWith('cleanup hint');
  });

  it('passes null when cleanup is undefined', async () => {
    const conv = makeConv('agent:a', 'k1');
    ttl.scheduleTtl(conv, metaFor('k1', { cleanup: undefined }), 1000);
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();
    expect(conv.expireSpy).toHaveBeenCalledWith(null);
  });

  it('two conversations fire independently', () => {
    const a = makeConv('agent:x', 'a');
    const b = makeConv('agent:x', 'b');
    ttl.scheduleTtl(a, metaFor('a'), 1000);
    ttl.scheduleTtl(b, metaFor('b'), 2000);

    vi.advanceTimersByTime(1000);
    expect(a.expireSpy).toHaveBeenCalledTimes(1);
    expect(b.expireSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(b.expireSpy).toHaveBeenCalledTimes(1);
  });

  it('scheduleTtl replaces an existing timer (no double-fire)', () => {
    const conv = makeConv('agent:a', 'k1');
    ttl.scheduleTtl(conv, metaFor('k1'), 5000);
    ttl.scheduleTtl(conv, metaFor('k1'), 10_000);

    vi.advanceTimersByTime(5000);
    expect(conv.expireSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(conv.expireSpy).toHaveBeenCalledTimes(1);
  });

  it('removes itself from the timers map after firing', async () => {
    const conv = makeConv('agent:a', 'k1');
    ttl.scheduleTtl(conv, metaFor('k1'), 1000);
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();
    expect(ttl.hasTimer(conv)).toBe(false);
  });

  it('a thrown conv.expire is caught — registry stays consistent', async () => {
    const conv = makeConv('agent:a', 'k1');
    conv.expire = vi.fn(async () => {
      throw new Error('boom');
    });
    ttl.scheduleTtl(conv, metaFor('k1'), 1000);
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();
    expect(ttl.hasTimer(conv)).toBe(false);
  });
});

describe('ConversationTtl — TTL survives runner death (audit regression)', () => {
  let ttl: ConversationTtl;

  beforeEach(() => {
    ttl = new ConversationTtl();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('TTL fires regardless of any runner-side state', async () => {
    // The pre-refactor bug: SessionHost.swapVictim called clearIdleTimer,
    // killing the timer when a conversation was paged out. TTL ownership is
    // structurally separated from runner residency now — there is no path
    // from "runner gone" to "timer cancelled" except an explicit cancelTtl
    // call from the Conversation itself.
    const conv = makeConv('agent:a', 'k1');
    ttl.scheduleTtl(conv, metaFor('k1'), 1000);

    // Simulate "runner died / swapped out / etc." — TTL is untouched.
    // (The whole point is that no such side-channel exists.)

    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();
    expect(conv.expireSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ConversationTtl — cancel + peek + hasTimer', () => {
  let ttl: ConversationTtl;

  beforeEach(() => {
    ttl = new ConversationTtl();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancelTtl prevents the timer from firing', async () => {
    const conv = makeConv('agent:a', 'k1');
    ttl.scheduleTtl(conv, metaFor('k1'), 5000);
    ttl.cancelTtl(conv);
    vi.advanceTimersByTime(10_000);
    await vi.runAllTimersAsync();
    expect(conv.expireSpy).not.toHaveBeenCalled();
  });

  it('cancelTtl is no-op when no timer scheduled', () => {
    const conv = makeConv('agent:a', 'k1');
    expect(() => ttl.cancelTtl(conv)).not.toThrow();
  });

  it('peekMeta returns the meta of an active timer', () => {
    const conv = makeConv('agent:a', 'k1');
    ttl.scheduleTtl(conv, metaFor('k1', { idle_timeout: 12_345 }), 5000);
    expect(ttl.peekMeta(conv)?.idle_timeout).toBe(12_345);
  });

  it('peekMeta returns undefined when no timer scheduled', () => {
    const conv = makeConv('agent:a', 'k1');
    expect(ttl.peekMeta(conv)).toBeUndefined();
  });

  it('hasTimer reflects whether a timer is scheduled', () => {
    const conv = makeConv('agent:a', 'k1');
    expect(ttl.hasTimer(conv)).toBe(false);
    ttl.scheduleTtl(conv, metaFor('k1'), 5000);
    expect(ttl.hasTimer(conv)).toBe(true);
    ttl.cancelTtl(conv);
    expect(ttl.hasTimer(conv)).toBe(false);
  });
});

describe('ConversationTtl — shutdownScope', () => {
  let ttl: ConversationTtl;

  beforeEach(() => {
    ttl = new ConversationTtl();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears timers in the given scope only', async () => {
    const a1 = makeConv('agent:a', 'k1');
    const a2 = makeConv('agent:a', 'k2');
    const b1 = makeConv('agent:b', 'k1');
    ttl.scheduleTtl(a1, metaFor('k1'), 1000);
    ttl.scheduleTtl(a2, metaFor('k2'), 1000);
    ttl.scheduleTtl(b1, metaFor('k1'), 1000);

    ttl.shutdownScope('agent:a');
    expect(ttl.hasTimer(a1)).toBe(false);
    expect(ttl.hasTimer(a2)).toBe(false);
    expect(ttl.hasTimer(b1)).toBe(true);

    vi.advanceTimersByTime(2000);
    await vi.runAllTimersAsync();
    expect(a1.expireSpy).not.toHaveBeenCalled();
    expect(a2.expireSpy).not.toHaveBeenCalled();
    expect(b1.expireSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ConversationTtl — shutdown', () => {
  let ttl: ConversationTtl;

  beforeEach(() => {
    ttl = new ConversationTtl();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels all timers across all scopes', async () => {
    const a = makeConv('agent:a', 'k1');
    const b = makeConv('agent:b', 'k1');
    ttl.scheduleTtl(a, metaFor('k1'), 1000);
    ttl.scheduleTtl(b, metaFor('k1'), 1000);
    ttl.shutdown();

    vi.advanceTimersByTime(2000);
    await vi.runAllTimersAsync();
    expect(a.expireSpy).not.toHaveBeenCalled();
    expect(b.expireSpy).not.toHaveBeenCalled();
  });
});
