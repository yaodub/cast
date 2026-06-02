/**
 * Debounce primitive — coalesces rapid `schedule()` calls into a single trailing
 * handler invocation after a quiet window.
 *
 * Used by AgentManager to dampen flap during live LLM-led blueprint/config
 * editing, where saves arrive every few seconds and heavy reload handlers
 * (extension reload, MCP proxy delta) shouldn't fire on every keystroke.
 *
 * Handler is fire-and-forget; promise rejections are caught and logged so a
 * misbehaving handler can't disable the debouncer.
 */
import { logger } from '../logger.js';

type DebounceState =
  | { status: 'idle' }
  | { status: 'pending'; timer: NodeJS.Timeout };

export interface DebounceHandle {
  /** Reset the timer; handler runs after `windowMs` of quiet. */
  schedule(): void;
  /** Cancel any pending timer. Used during shutdown. */
  cancel(): void;
  /** Run the handler synchronously (tests). Clears any pending timer. */
  flushNow(): void;
}

export function createDebounced(
  handler: () => void | Promise<void>,
  windowMs: number,
): DebounceHandle {
  // SIDE EFFECT: closure-local state mutated by schedule/cancel/flushNow.
  // Required because debounce inherently needs a single retained timer
  // handle. State is hidden behind the DebounceHandle interface — no
  // upper-scope writes leak out.
  let state: DebounceState = { status: 'idle' };

  const fire = (): void => {
    state = { status: 'idle' };
    try {
      const result = handler();
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err) => {
          logger.warn({ err }, 'debounced handler threw');
        });
      }
    } catch (err) {
      logger.warn({ err }, 'debounced handler threw');
    }
  };

  return {
    schedule(): void {
      if (state.status === 'pending') clearTimeout(state.timer);
      state = { status: 'pending', timer: setTimeout(fire, windowMs) };
    },
    cancel(): void {
      if (state.status === 'pending') clearTimeout(state.timer);
      state = { status: 'idle' };
    },
    flushNow(): void {
      if (state.status === 'pending') clearTimeout(state.timer);
      fire();
    },
  };
}
