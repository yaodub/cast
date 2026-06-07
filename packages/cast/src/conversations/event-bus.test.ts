/**
 * ConversationEventBus — unit tests for the typed in-process event bus
 * that the conversations layer emits through.
 *
 * Covers subscribe/emit, dispose, filter matching (scope string + RegExp,
 * kinds, combined), multiple-subscribers, throw isolation, and the
 * subscribe/unsubscribe-during-dispatch semantics (snapshot-before-iterate).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ConversationEventBus,
  type ConversationEvent,
  type SubscriptionFilter,
} from './event-bus.js';
import type { ConversationView } from './conversation.js';
import type { ConversationState } from './types.js';

// =============================================================================
// Helpers
// =============================================================================

function makeView(scope: string, key: string = 'k'): ConversationView<unknown> {
  // Bus subscribers only read `scope` and `key` from the view (and call sites
  // pass through opaque). A minimal stub is sufficient — production code
  // always supplies a real view from `Conversation.view()`.
  return {
    scope,
    key,
    ctx: undefined,
    state: 'idle-no-runner',
    phase: 'new',
    ccSessionId: undefined,
    lastActive: new Date().toISOString(),
    hasRunner: false,
    isExpired: false,
    isDestroyed: false,
    isInvalidated: false,
    mailboxSize: 0,
    activeProcess: null,
    activeContainerName: null,
    deliver: () => Promise.resolve({ ok: true, result: null }),
    canAcceptUserMessage: () => true,
    canEndManually: () => ({ ok: true as const }),
    canDeliverQueryReply: () => true,
  };
}

function stateEvt(
  scope: string,
  from: ConversationState = 'idle-no-runner',
  to: ConversationState = 'running',
): ConversationEvent {
  return { kind: 'state', view: makeView(scope), from, to };
}

function queuedEvt(scope: string, active: boolean): ConversationEvent {
  return { kind: 'queued', view: makeView(scope), active };
}

function phaseEvt(scope: string): ConversationEvent {
  return { kind: 'phase', view: makeView(scope), from: 'new', to: 'active' };
}

// =============================================================================
// Tests
// =============================================================================

describe('ConversationEventBus — subscribe + emit', () => {
  it('subscribe + emit fires the callback', () => {
    const bus = new ConversationEventBus();
    const fn = vi.fn();
    bus.subscribe({}, fn);
    const evt = stateEvt('agent:a');
    bus.emit(evt);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(evt);
  });

  it('dispose() removes the subscriber — no further fires', () => {
    const bus = new ConversationEventBus();
    const fn = vi.fn();
    const dispose = bus.subscribe({}, fn);
    bus.emit(stateEvt('agent:a'));
    expect(fn).toHaveBeenCalledTimes(1);
    dispose();
    bus.emit(stateEvt('agent:a'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('dispose() is idempotent — calling it twice does not throw', () => {
    const bus = new ConversationEventBus();
    const dispose = bus.subscribe({}, vi.fn());
    dispose();
    expect(() => dispose()).not.toThrow();
  });

  it('multiple subscribers each get the event', () => {
    const bus = new ConversationEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    bus.subscribe({}, a);
    bus.subscribe({}, b);
    bus.subscribe({}, c);
    const evt = stateEvt('agent:a');
    bus.emit(evt);
    expect(a).toHaveBeenCalledWith(evt);
    expect(b).toHaveBeenCalledWith(evt);
    expect(c).toHaveBeenCalledWith(evt);
  });
});

describe('ConversationEventBus — filter by scope (string)', () => {
  it('matches when scope string equals view.scope', () => {
    const bus = new ConversationEventBus();
    const fn = vi.fn();
    bus.subscribe({ scope: 'agent:a' }, fn);
    bus.emit(stateEvt('agent:a'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not match when scope string differs', () => {
    const bus = new ConversationEventBus();
    const fn = vi.fn();
    bus.subscribe({ scope: 'agent:a' }, fn);
    bus.emit(stateEvt('agent:b'));
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('ConversationEventBus — filter by scope (RegExp)', () => {
  it('matches when scope regex tests positive', () => {
    const bus = new ConversationEventBus();
    const fn = vi.fn();
    bus.subscribe({ scope: /^agent:/ }, fn);
    bus.emit(stateEvt('agent:foo'));
    bus.emit(stateEvt('agent:bar'));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not match when scope regex tests negative', () => {
    const bus = new ConversationEventBus();
    const fn = vi.fn();
    bus.subscribe({ scope: /^agent:/ }, fn);
    bus.emit(stateEvt('console:server'));
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('ConversationEventBus — filter by kinds', () => {
  it('matches when event kind is in the kinds list', () => {
    const bus = new ConversationEventBus();
    const fn = vi.fn();
    bus.subscribe({ kinds: ['queued'] }, fn);
    bus.emit(queuedEvt('agent:a', true));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not match when event kind is not in the kinds list', () => {
    const bus = new ConversationEventBus();
    const fn = vi.fn();
    bus.subscribe({ kinds: ['queued'] }, fn);
    bus.emit(stateEvt('agent:a'));
    bus.emit(phaseEvt('agent:a'));
    expect(fn).not.toHaveBeenCalled();
  });

  it('matches when multiple kinds are allowed', () => {
    const bus = new ConversationEventBus();
    const fn = vi.fn();
    bus.subscribe({ kinds: ['queued', 'phase'] }, fn);
    bus.emit(queuedEvt('agent:a', true));
    bus.emit(phaseEvt('agent:a'));
    bus.emit(stateEvt('agent:a')); // not in list
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('empty kinds array matches no events (no subscribers indexed)', () => {
    const bus = new ConversationEventBus();
    const fn = vi.fn();
    bus.subscribe({ kinds: [] }, fn);
    bus.emit(stateEvt('agent:a'));
    bus.emit(queuedEvt('agent:a', true));
    bus.emit(phaseEvt('agent:a'));
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('ConversationEventBus — combined scope + kinds filter', () => {
  it('requires both scope AND kinds to match', () => {
    const bus = new ConversationEventBus();
    const fn = vi.fn();
    const filter: SubscriptionFilter = { scope: 'agent:a', kinds: ['queued'] };
    bus.subscribe(filter, fn);

    bus.emit(queuedEvt('agent:a', true)); // both match
    bus.emit(queuedEvt('agent:b', true)); // scope mismatch
    bus.emit(stateEvt('agent:a'));        // kinds mismatch

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'queued' }));
  });
});

describe('ConversationEventBus — throw isolation', () => {
  it('subscriber that throws does not stop other subscribers', () => {
    const bus = new ConversationEventBus();
    const a = vi.fn();
    const b = vi.fn(() => {
      throw new Error('boom');
    });
    const c = vi.fn();
    bus.subscribe({}, a);
    bus.subscribe({}, b);
    bus.subscribe({}, c);
    expect(() => bus.emit(stateEvt('agent:a'))).not.toThrow();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });
});

describe('ConversationEventBus — emit-during-dispatch safety (snapshot semantics)', () => {
  it('subscribe during dispatch — new subscriber is NOT called for the current emit', () => {
    const bus = new ConversationEventBus();
    const late = vi.fn();
    const early = vi.fn(() => {
      bus.subscribe({}, late);
    });
    bus.subscribe({}, early);

    bus.emit(stateEvt('agent:a'));
    expect(early).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();

    // Subsequent emits do reach the late subscriber.
    bus.emit(stateEvt('agent:a'));
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe during dispatch — the unsubscribed callback IS still called for the current emit', () => {
    const bus = new ConversationEventBus();
    let disposeB: (() => void) | null = null;
    const a = vi.fn(() => {
      disposeB?.();
    });
    const b = vi.fn();
    bus.subscribe({}, a);
    disposeB = bus.subscribe({}, b);

    bus.emit(stateEvt('agent:a'));
    // Snapshot was taken before iteration → b receives this emit despite
    // being unsubscribed from inside a.
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    // Next emit: b is gone.
    bus.emit(stateEvt('agent:a'));
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
