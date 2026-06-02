import { describe, it, expect } from 'vitest';

import { buildLifecycleEvtData, renderLifecyclePhase } from './lifecycle-render.js';
import type { LifecyclePhase } from '../types.js';

describe('buildLifecycleEvtData', () => {
  it('compacting carries preTokens and trigger', () => {
    const data = buildLifecycleEvtData('compacting', false, 'default', {
      preTokens: 42_000,
      trigger: 'auto',
    });
    expect(data).toEqual({
      phase: 'compacting',
      active: false,
      channel: 'default',
      preTokens: 42_000,
      trigger: 'auto',
    });
  });

  it('compacting omits extras when undefined', () => {
    const data = buildLifecycleEvtData('compacting', true, 'default');
    expect(data).toEqual({
      phase: 'compacting',
      active: true,
      channel: 'default',
      preTokens: undefined,
      trigger: undefined,
    });
  });

  it('fresh_conversation omits active and extras', () => {
    const data = buildLifecycleEvtData('fresh_conversation', true, 'default');
    expect(data).toEqual({ phase: 'fresh_conversation', channel: 'default' });
  });

  it('queued / bootstrap / auth_refresh carry active + channel', () => {
    for (const phase of ['queued', 'bootstrap', 'auth_refresh'] as const) {
      const data = buildLifecycleEvtData(phase, true, 'archive');
      expect(data).toEqual({ phase, active: true, channel: 'archive' });
    }
  });
});

describe('renderLifecyclePhase', () => {
  it('queued{active:true} renders the "waiting" italics', () => {
    const text = renderLifecyclePhase({ phase: 'queued', active: true, channel: 'default' });
    expect(text).toBe('_Waiting for a free slot…_');
  });

  it('bootstrap{active:true} renders the "waking up" italics', () => {
    const text = renderLifecyclePhase({ phase: 'bootstrap', active: true, channel: 'default' });
    expect(text).toBe('_Waking up…_');
  });

  it('auth_refresh{active:true} renders the "refreshing auth" italics', () => {
    const text = renderLifecyclePhase({ phase: 'auth_refresh', active: true, channel: 'default' });
    expect(text).toBe('_Refreshing authentication…_');
  });

  it('compacting{active:true} renders the "compressing" italics', () => {
    const text = renderLifecyclePhase({ phase: 'compacting', active: true, channel: 'default' });
    expect(text).toBe('_Compressing conversation history…_');
  });

  it('compacting{active:false, preTokens} renders the "context compressed" italics with rounded k', () => {
    const text = renderLifecyclePhase({
      phase: 'compacting',
      active: false,
      channel: 'default',
      preTokens: 47_500,
    });
    expect(text).toBe('_Context compressed (48k tokens). Earlier messages may be forgotten._');
  });

  it('compacting{active:false} without preTokens drops to undefined', () => {
    const text = renderLifecyclePhase({ phase: 'compacting', active: false, channel: 'default' });
    expect(text).toBeUndefined();
  });

  it('fresh_conversation drops to undefined (console-only)', () => {
    const text = renderLifecyclePhase({ phase: 'fresh_conversation', channel: 'default' });
    expect(text).toBeUndefined();
  });

  it('queued{active:false} drops to undefined (end-of-phase)', () => {
    const text = renderLifecyclePhase({ phase: 'queued', active: false, channel: 'default' });
    expect(text).toBeUndefined();
  });

  it('bootstrap{active:false} drops to undefined', () => {
    const data: LifecyclePhase = { phase: 'bootstrap', active: false, channel: 'default' };
    expect(renderLifecyclePhase(data)).toBeUndefined();
  });
});
