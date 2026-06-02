/**
 * PanicRegistry — rate-shaped backstops for abnormal velocity scenarios.
 *
 * Cast's existing safety caps are correctness-shaped (`MAX_AUTH_RETRIES`,
 * `MAX_VALIDATION_FAILURES`, `MAX_ABNORMAL_EXITS`): count an outcome, halt
 * on threshold N. The runaway-loop incident of 2026-05-23 (696K iterations
 * over 67 minutes) exposed the gap — a slower runaway can burn through
 * tokens and resources without tripping a correctness cap, while still
 * being unambiguously broken. The registry adds the rate axis.
 *
 * Per-agent panic state (keyed by conversation `scope`, e.g.
 * `agent:site-manager`). When an agent crosses a rate threshold, the
 * registry records a halt with an expiry timestamp. `AgentManager.route()`
 * consults `getHaltState()` before dispatch; halted agents reject new
 * inbound with a clear error. Existing in-flight work tears down via the
 * standard `TeardownMode.drain` path.
 *
 * Process-wide singleton (`panicRegistry`), mirroring the `slotPool` and
 * `conversations` patterns in `gates.ts`. Test surface:
 * `_resetPanicRegistryForTest()`.
 *
 * Phase 1 covers two buttons (#1 spawn-rate, #5 time-aware abnormal-exit).
 * Buttons #2-#4 from the design study are deferred.
 */

/** Identifier for which panic button tripped. Each value names a specific
 *  rate-shaped guard; new buttons (phase 2) add new variants here. Drives
 *  telemetry (`host-activity-log` event_name suffix) and surfaces in the
 *  halt reason string the operator sees. */
export type PanicButton = 'spawn_rate' | 'abnormal_exit_rate';

/** An active halt record. `until` is absolute wall-clock ms — compared
 *  against `Date.now()` at lookup, lazy-expired by `getHaltState`. */
export interface HaltState {
  readonly button: PanicButton;
  readonly reason: string;
  readonly haltedAt: number;
  readonly until: number;
}

/** Button #1 — spawn-rate window and threshold. 20 spawns / agent in a
 *  60s window trips. ~10× the worst-case healthy rate of a chatty user
 *  across three channels (~3 spawns/min). The 2026-05-23 incident peaked
 *  at 600/sec — 36,000× this threshold. */
const SPAWN_RATE_WINDOW_MS = 60_000;
const SPAWN_RATE_MAX = 20;
const SPAWN_RATE_HALT_MS = 10 * 60_000;

/** Button #5 — time-aware MAX_ABNORMAL_EXITS escalation. Same count
 *  cap (3) as the existing per-conversation guard, but adds a time
 *  component: three abnormal exits within 10s escalates from "close
 *  conversation" to agent-scope halt. */
const ABNORMAL_EXIT_WINDOW_MS = 10_000;
const ABNORMAL_EXIT_MIN_COUNT = 3;
const ABNORMAL_EXIT_HALT_MS = 60_000;

export class PanicRegistry {
  /** Active halts. Lazy-expired by `getHaltState` so callers don't need
   *  a sweep timer. */
  private halts = new Map<string, HaltState>();

  /** Per-key ring buffer of recent spawn timestamps for button #1. We
   *  prune-on-write rather than maintaining a separate window. */
  private spawnTimestamps = new Map<string, number[]>();

  /** Returns the active halt for `key`, or `null`. Lazy-expires on read. */
  getHaltState(key: string, now: number = Date.now()): HaltState | null {
    const halt = this.halts.get(key);
    if (!halt) return null;
    if (halt.until <= now) {
      // SIDE EFFECT: drop the expired record so iteration / size reports
      // reflect current state. Lazy expiry — no background sweep needed.
      this.halts.delete(key);
      return null;
    }
    return halt;
  }

  /** Convenience boolean predicate over `getHaltState`. */
  isHalted(key: string, now: number = Date.now()): boolean {
    return this.getHaltState(key, now) !== null;
  }

  /** Place `key` under a halt. Last-writer-wins across buttons (the
   *  registry tracks at most one halt per key at a time). Returns the
   *  recorded `HaltState`. */
  halt(
    key: string,
    button: PanicButton,
    reason: string,
    durationMs: number,
    now: number = Date.now(),
  ): HaltState {
    const state: HaltState = {
      button,
      reason,
      haltedAt: now,
      until: now + durationMs,
    };
    this.halts.set(key, state);
    return state;
  }

  /** Button #1 — record a spawn event for `key` and check the rate
   *  threshold. Returns the new `HaltState` if this spawn just tripped
   *  the threshold, `null` otherwise. Caller (`runSpawnCycle`) checks
   *  the return to decide whether to abort the cycle.
   *
   *  SIDE EFFECT: mutates the per-key ring buffer. Stale entries (older
   *  than the window) are pruned in the same call. */
  recordSpawn(key: string, now: number = Date.now()): HaltState | null {
    const cutoff = now - SPAWN_RATE_WINDOW_MS;
    const prev = this.spawnTimestamps.get(key);
    const trimmed: number[] = [];
    if (prev) {
      for (const ts of prev) if (ts >= cutoff) trimmed.push(ts);
    }
    trimmed.push(now);
    this.spawnTimestamps.set(key, trimmed);
    if (trimmed.length >= SPAWN_RATE_MAX) {
      return this.halt(
        key,
        'spawn_rate',
        `${trimmed.length} spawns in ${SPAWN_RATE_WINDOW_MS / 1000}s window`,
        SPAWN_RATE_HALT_MS,
        now,
      );
    }
    return null;
  }

  /** Button #5 — time-aware abnormal-exit escalation. Caller is the
   *  `recordSpawnOutcome` cap-hit branch in `Conversation`. We escalate
   *  to agent-scope halt only when the cap was hit *and* the burst was
   *  fast enough to be runaway-shaped. Returns the new `HaltState` if
   *  escalated, `null` otherwise (slow successive failures still close
   *  the conversation via the existing correctness cap, but don't halt
   *  the agent). */
  recordAbnormalExitBurst(
    key: string,
    firstAbnormalAt: number,
    count: number,
    now: number = Date.now(),
  ): HaltState | null {
    if (count < ABNORMAL_EXIT_MIN_COUNT) return null;
    if (now - firstAbnormalAt > ABNORMAL_EXIT_WINDOW_MS) return null;
    return this.halt(
      key,
      'abnormal_exit_rate',
      `${count} abnormal exits in ${now - firstAbnormalAt}ms`,
      ABNORMAL_EXIT_HALT_MS,
      now,
    );
  }

  /** Diagnostic iterator over currently-halted keys. Used by the admin
   *  panel and `host-activity-log` summaries. */
  *halted(now: number = Date.now()): IterableIterator<[string, HaltState]> {
    for (const [key, state] of this.halts) {
      if (state.until > now) yield [key, state];
    }
  }

  /** Test-only: clear all halts and spawn-rate accounting buffers. */
  _reset(): void {
    this.halts.clear();
    this.spawnTimestamps.clear();
  }
}

export const panicRegistry = new PanicRegistry();

/** Test-only: reset the singleton between tests. */
export function _resetPanicRegistryForTest(): void {
  panicRegistry._reset();
}
