/**
 * Direct unit tests for `gateUserHooks` — the cleanup-phase chokepoint.
 *
 * This is the single structural enforcement point for "no user emission
 * during the cleanup turn." Every emission site in conversation-runner.ts
 * calls hooks unconditionally; the proxy decides whether the call reaches
 * its implementation.
 *
 * Both-branches discipline (style guide §Runtime Validation Strategy):
 * each user-facing hook is tested in both the allow (isExpired=false)
 * and drop (isExpired=true) branches. The drop branch is the regression
 * that streaming work introduced — the leak that prompted this refactor.
 */
import { describe, it, expect, vi } from 'vitest';
import { applyWebFetchPolicy, formatFallbackMessage, gateUserHooks, type SpawnHooks } from './conversation-runner.js';
import type { ConversationPkt, PreviewPkt } from '../gateway/packets.js';
import type { TypingEvt } from '../types.js';

function makeHooks(): { hooks: Required<SpawnHooks>; spies: Record<string, ReturnType<typeof vi.fn>> } {
  const spies = {
    onSessionId: vi.fn(),
    onOutput: vi.fn(async () => {}),
    onPreview: vi.fn(),
    onTyping: vi.fn(),
    onLifecycle: vi.fn(),
    onRequest: vi.fn(async () => {}),
    onResponse: vi.fn(async () => {}),
    logEvent: vi.fn(),
  };
  const hooks: Required<SpawnHooks> = {
    onSessionId: spies.onSessionId,
    onOutput: spies.onOutput,
    onPreview: spies.onPreview,
    onTyping: spies.onTyping,
    onLifecycle: spies.onLifecycle,
    onRequest: spies.onRequest,
    onResponse: spies.onResponse,
    logEvent: spies.logEvent,
  };
  return { hooks, spies };
}

const PKT: ConversationPkt = {
  type: 'conversation',
  id: 'pkt-test',
  from: 'a:agent',
  to: 'u:user',
  text: 'hi',
  timestamp: '2026-05-21T00:00:00.000Z',
};

const PREVIEW: PreviewPkt = {
  type: 'preview',
  id: 'prev-test',
  from: 'a:agent',
  to: 'u:user',
  text: 'streaming…',
  timestamp: '2026-05-21T00:00:00.000Z',
  streamId: 's-1',
  channel: 'default',
  kind: 'text',
};

const TYPING_EVT: TypingEvt = {
  from: 'a:agent',
  to: 'u:user',
  type: 'typing',
  data: { channel: 'default' },
};

describe('gateUserHooks — user-facing hooks gated', () => {
  describe('isExpired=false (allow branch)', () => {
    it('onSessionId passes through', () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => false);
      gated.onSessionId('sess-1');
      expect(spies.onSessionId).toHaveBeenCalledWith('sess-1');
    });

    it('onOutput passes through', async () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => false);
      await gated.onOutput(PKT, 'default', 'conv-1');
      expect(spies.onOutput).toHaveBeenCalledWith(PKT, 'default', 'conv-1');
    });

    it('onPreview passes through', () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => false);
      gated.onPreview?.(PREVIEW, 'default', 'conv-1');
      expect(spies.onPreview).toHaveBeenCalledWith(PREVIEW, 'default', 'conv-1');
    });

    it('onTyping passes through', () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => false);
      gated.onTyping(TYPING_EVT);
      expect(spies.onTyping).toHaveBeenCalledWith(TYPING_EVT);
    });

    it('onLifecycle passes through', () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => false);
      gated.onLifecycle?.('fresh_conversation', false, { trigger: 'manual' });
      expect(spies.onLifecycle).toHaveBeenCalledWith('fresh_conversation', false, { trigger: 'manual' });
    });

    it('onRequest passes through (query kind)', async () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => false);
      await gated.onRequest?.('query', 'target', 'ch', 'text', 'qual');
      expect(spies.onRequest).toHaveBeenCalledWith('query', 'target', 'ch', 'text', 'qual');
    });

    it('onRequest passes through (request kind)', async () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => false);
      await gated.onRequest?.('request', 'target', 'ch', 'text');
      expect(spies.onRequest).toHaveBeenCalledWith('request', 'target', 'ch', 'text', undefined);
    });

    it('onResponse passes through', async () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => false);
      await gated.onResponse?.('req-1', 'reply');
      expect(spies.onResponse).toHaveBeenCalledWith('req-1', 'reply');
    });
  });

  describe('isExpired=true (drop branch — the regression-catching tests)', () => {
    it('onSessionId is dropped', () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => true);
      gated.onSessionId('sess-1');
      expect(spies.onSessionId).not.toHaveBeenCalled();
    });

    it('onOutput is dropped', async () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => true);
      await gated.onOutput(PKT, 'default', 'conv-1');
      expect(spies.onOutput).not.toHaveBeenCalled();
    });

    // This is the test that would have caught the streaming regression.
    // Before the proxy: preview output during cleanup turn → onPreview →
    // Telegram edit-in-place bubble visible to user, even though the
    // cleanup-turn final message was correctly suppressed elsewhere.
    it('onPreview is dropped (streaming regression)', () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => true);
      gated.onPreview?.(PREVIEW, 'default', 'conv-1');
      expect(spies.onPreview).not.toHaveBeenCalled();
    });

    it('onTyping is dropped', () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => true);
      gated.onTyping(TYPING_EVT);
      expect(spies.onTyping).not.toHaveBeenCalled();
    });

    it('onLifecycle is dropped (all phases)', () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => true);
      gated.onLifecycle?.('fresh_conversation', false);
      gated.onLifecycle?.('compacting', true);
      gated.onLifecycle?.('auth_refresh', true);
      gated.onLifecycle?.('bootstrap', false);
      expect(spies.onLifecycle).not.toHaveBeenCalled();
    });

    it('onRequest is dropped (no cross-agent fan-out from a closing conv)', async () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => true);
      await gated.onRequest?.('query', 'target', 'ch', 'text');
      expect(spies.onRequest).not.toHaveBeenCalled();
    });

    it('onResponse is dropped (no cross-agent fan-out from a closing conv)', async () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => true);
      await gated.onResponse?.('req-1', 'reply');
      expect(spies.onResponse).not.toHaveBeenCalled();
    });
  });

  describe('isExpired=true — internal hooks still pass', () => {
    it('logEvent passes through unconditionally', () => {
      const { hooks, spies } = makeHooks();
      const gated = gateUserHooks(hooks, () => true);
      gated.logEvent?.('info', 'agent', 'evt', 'message', {});
      expect(spies.logEvent).toHaveBeenCalled();
    });
  });

  describe('predicate dynamism', () => {
    it('evaluates isExpired at every call (not at construction)', async () => {
      const { hooks, spies } = makeHooks();
      let expired = false;
      const gated = gateUserHooks(hooks, () => expired);

      await gated.onOutput(PKT, 'default', 'conv-1');
      expect(spies.onOutput).toHaveBeenCalledTimes(1);

      expired = true;
      await gated.onOutput(PKT, 'default', 'conv-1');
      expect(spies.onOutput).toHaveBeenCalledTimes(1); // still 1 — dropped

      expired = false;
      await gated.onOutput(PKT, 'default', 'conv-1');
      expect(spies.onOutput).toHaveBeenCalledTimes(2);
    });
  });

  describe('optional-field preservation', () => {
    it('omits onPreview when input lacks it', () => {
      const minimal: SpawnHooks = {
        onSessionId: vi.fn(),
        onOutput: vi.fn(async () => {}),
        onTyping: vi.fn(),
      };
      const gated = gateUserHooks(minimal, () => false);
      expect(gated.onPreview).toBeUndefined();
      expect(gated.onLifecycle).toBeUndefined();
      expect(gated.onRequest).toBeUndefined();
      expect(gated.onResponse).toBeUndefined();
    });

    it('preserves logEvent when input has it', () => {
      const logEvent = vi.fn();
      const hooks: SpawnHooks = {
        onSessionId: vi.fn(),
        onOutput: vi.fn(async () => {}),
        onTyping: vi.fn(),
        logEvent,
      };
      const gated = gateUserHooks(hooks, () => true);
      expect(gated.logEvent).toBe(logEvent); // exact reference; passthrough is not wrapped
    });
  });
});

describe('formatFallbackMessage', () => {
  it('returns the not-configured copy', () => {
    const msg = formatFallbackMessage('not-configured');
    expect(msg).toContain("isn't set up");
    expect(msg).toContain('server dashboard');
  });

  it('returns the invalid-credentials copy', () => {
    expect(formatFallbackMessage('invalid-credentials')).toContain('rejected the API key');
  });

  it('returns the quota-exhausted copy', () => {
    expect(formatFallbackMessage('quota-exhausted')).toContain('out of usage');
  });

  it('returns the claude-unavailable copy', () => {
    const msg = formatFallbackMessage('claude-unavailable');
    expect(msg).toContain('currently unavailable');
    expect(msg).toContain('Try again');
  });

  it('keeps the external_kill copy distinct from the generic fallback', () => {
    const ek = formatFallbackMessage('external_kill');
    const generic = formatFallbackMessage('container_error');
    expect(ek).toContain('terminated by the host runtime');
    expect(generic).toContain('stopped without producing a response');
    expect(ek).not.toEqual(generic);
  });

  it('shares copy between auth_exhausted and container_error (both generic)', () => {
    // Auth retries exhausted falls back to the same generic "stopped"
    // message as a container crash — the operator's next move is the same.
    expect(formatFallbackMessage('auth_exhausted')).toEqual(formatFallbackMessage('container_error'));
  });
});

/**
 * applyWebFetchPolicy — the built-in WebFetch security gate, keyed purely on
 * network mode. Both-branches discipline (style guide §Runtime Validation
 * Strategy): exercise both the allow (full → kept) and deny (everything else →
 * disabled) directions, since the deny side is the property that matters.
 */
describe('applyWebFetchPolicy', () => {
  it('KEEPS built-in WebFetch on full network (authoring consoles / deliberately full-net agents)', () => {
    // On full net the agent can already reach any host (Bash/curl), so the
    // built-in adds no exposure — and it's the only fetch path here.
    expect(applyWebFetchPolicy([], 'full')).not.toContain('WebFetch');
  });

  it('DISABLES built-in WebFetch on sdk-only (the default network mode)', () => {
    expect(applyWebFetchPolicy([], 'sdk-only')).toContain('WebFetch');
  });

  it('DISABLES built-in WebFetch on none (no egress)', () => {
    expect(applyWebFetchPolicy([], 'none')).toContain('WebFetch');
  });

  it('DISABLES built-in WebFetch when containerNetwork is unset (entrypoint default = sdk-only)', () => {
    expect(applyWebFetchPolicy([], undefined)).toContain('WebFetch');
  });

  it('preserves the agent\'s existing disabled tools and does not mutate the input', () => {
    const base = ['task__*'];
    const out = applyWebFetchPolicy(base, 'sdk-only');
    expect(out).toEqual(['task__*', 'WebFetch']);
    expect(base).toEqual(['task__*']); // input untouched
  });
});
