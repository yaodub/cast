/**
 * Lifecycle event payload builders and renderers — the single home for the
 * `LifecyclePhase` → wire-shape mapping (producer side) and the
 * `LifecyclePhase` → user-visible text mapping (consumer side).
 *
 * Before Phase I.1, the producer-side ternary (`phase === 'compacting' ? {…} :
 * phase === 'fresh_conversation' ? {…} : {…}`) lived inline in both
 * `agent-spawn-hooks.ts` and `console/shared/server-scope.ts`, and the
 * consumer-side `if (phase === '…' && active) text = '…'` table lived inline
 * in both `transports/telegram.ts` and `transports/slack.ts`. A new phase
 * meant four edits; this module collapses each side to one.
 *
 * Channel filtering / addressing stays at the call site — this module owns
 * only the shape of the data and the user-visible italics.
 */
import type { LifecyclePhase } from '../types.js';

/** Extra fields the `compacting` phase may carry. Other phases ignore both. */
export interface LifecycleEvtExtras {
  preTokens?: number;
  trigger?: 'manual' | 'auto';
}

/**
 * Build the discriminated `LifecyclePhase` payload for a lifecycle event. The
 * producer-side type system already enforces the per-variant fields; this
 * helper is the one site that knows which phases ship which fields.
 */
export function buildLifecycleEvtData(
  phase: LifecyclePhase['phase'],
  active: boolean,
  channel: string,
  extras?: LifecycleEvtExtras,
): LifecyclePhase {
  if (phase === 'compacting') {
    return { phase, active, channel, preTokens: extras?.preTokens, trigger: extras?.trigger };
  }
  if (phase === 'fresh_conversation') {
    return { phase, channel };
  }
  return { phase, active, channel };
}

/**
 * Render a `LifecyclePhase` as a single line of user-visible italic text for
 * transports that render lifecycle events into chat history (Telegram,
 * Slack). Returns `undefined` for variants the transport should drop —
 * `fresh_conversation` is console-only today, and `queued{active:false}` /
 * `*{active:false}` are end-of-phase signals with no surface.
 */
export function renderLifecyclePhase(data: LifecyclePhase): string | undefined {
  if (data.phase === 'fresh_conversation') return undefined;
  if (data.phase === 'compacting' && !data.active && data.preTokens) {
    return `_Context compressed (${Math.round(data.preTokens / 1000)}k tokens). Earlier messages may be forgotten._`;
  }
  if (!data.active) return undefined;
  switch (data.phase) {
    case 'queued':
      return '_Waiting for a free slot…_';
    case 'bootstrap':
      return '_Waking up…_';
    case 'compacting':
      return '_Compressing conversation history…_';
    case 'auth_refresh':
      return '_Refreshing authentication…_';
  }
  return undefined;
}
