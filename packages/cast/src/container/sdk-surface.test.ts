import { describe, expect, it } from 'vitest';

import { applyBuiltinToolPolicy, SDK_ENV_FLAGS } from './sdk-surface.js';

/**
 * applyBuiltinToolPolicy — the built-in tool gate: an unconditional disallow
 * list plus WebFetch keyed purely on network mode. Both-branches discipline
 * (style guide §Runtime Validation Strategy): exercise both the allow (full →
 * kept) and deny (everything else → disabled) directions for WebFetch, since
 * the deny side is the property that matters.
 */
describe('applyBuiltinToolPolicy', () => {
  it('KEEPS built-in WebFetch on full network (authoring consoles / deliberately full-net agents)', () => {
    // On full net the agent can already reach any host (Bash/curl), so the
    // built-in adds no exposure — and it's the only fetch path here.
    expect(applyBuiltinToolPolicy([], 'full')).not.toContain('WebFetch');
  });

  it('DISABLES built-in WebFetch on sdk-only (the default network mode)', () => {
    expect(applyBuiltinToolPolicy([], 'sdk-only')).toContain('WebFetch');
  });

  it('DISABLES built-in WebFetch on none (no egress)', () => {
    expect(applyBuiltinToolPolicy([], 'none')).toContain('WebFetch');
  });

  it('DISABLES built-in WebFetch when containerNetwork is unset (entrypoint default = sdk-only)', () => {
    expect(applyBuiltinToolPolicy([], undefined)).toContain('WebFetch');
  });

  it('DISABLES the unconditional built-ins on every network mode, full included', () => {
    // Scheduling outside Cast (session cron, claude.ai Routines), user-reaching
    // side channels (push), interactive plan mode, and the Task* checklist that
    // collides with task__* — none of these are network-gated.
    for (const network of ['full', 'sdk-only', 'none', undefined]) {
      const out = applyBuiltinToolPolicy([], network);
      for (const tool of [
        'CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup',
        'RemoteTrigger', 'PushNotification', 'ShareOnboardingGuide',
        'EnterPlanMode', 'ExitPlanMode',
        'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
      ]) {
        expect(out, `${tool} on network=${network}`).toContain(tool);
      }
    }
  });

  it('preserves the agent\'s existing disabled tools and does not mutate the input', () => {
    const base = ['task__*'];
    const out = applyBuiltinToolPolicy(base, 'sdk-only');
    expect(out[0]).toBe('task__*'); // agent's own list leads, untouched
    expect(out).toContain('WebFetch');
    expect(base).toEqual(['task__*']); // input untouched
  });
});

/**
 * SDK_ENV_FLAGS — polarity guard. Upstream mixes DISABLE_*=1 and ENABLE_*=0
 * conventions; a flipped value silently re-enables the feature, so pin each
 * flag's exact value rather than mere presence.
 */
describe('SDK_ENV_FLAGS', () => {
  it('kills the session cron scheduler (DISABLE polarity: 1 = off)', () => {
    expect(SDK_ENV_FLAGS.CLAUDE_CODE_DISABLE_CRON).toBe('1');
  });

  it('reverts the Task* checklist to TodoWrite (ENABLE polarity: 0 = off)', () => {
    expect(SDK_ENV_FLAGS.CLAUDE_CODE_ENABLE_TASKS).toBe('0');
  });

  it('disables CLI auto-memory (DISABLE polarity: 1 = off)', () => {
    expect(SDK_ENV_FLAGS.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });
});
