/**
 * RestartBreaker — circuit breaker for AgentService's auto-restart loop.
 *
 * Counts restart attempts within a sliding window; trips after the cap. Once
 * tripped the breaker stays tripped until `reset()` — `AgentService` calls
 * reset on stable uptime (mirroring the existing backoff-reset semantic) and
 * on operator-triggered manual restart.
 *
 * Layer separation: this guards the child-process supervisor (the agent's
 * service binary keeps crashing). It's not `MAX_ABNORMAL_EXITS` (per-
 * conversation spawn-cycle cap on the runner side) and not a `panicRegistry`
 * button (rate-shaped LLM-velocity guards on the conversation scope). Those
 * three live at different layers and compose independently.
 */

type BreakerState = { kind: 'ok' } | { kind: 'tripped'; reason: string };

export class RestartBreaker {
  private timestamps: number[] = [];
  private state: BreakerState = { kind: 'ok' };

  constructor(
    private readonly maxRestarts: number,
    private readonly windowMs: number,
  ) {}

  /** Record a restart attempt. Returns the new (possibly unchanged) state.
   *  Idempotent once tripped: subsequent calls return the trip state without
   *  further accounting, so a caller polling the breaker after trip sees a
   *  consistent reason string. */
  record(now: number): BreakerState {
    if (this.state.kind === 'tripped') return this.state;
    const cutoff = now - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t >= cutoff);
    this.timestamps.push(now);
    if (this.timestamps.length >= this.maxRestarts) {
      this.state = {
        kind: 'tripped',
        reason: `${this.timestamps.length} restarts within ${this.windowMs}ms window`,
      };
    }
    return this.state;
  }

  /** Clear the breaker — both the trip state and the timestamp history. */
  reset(): void {
    this.timestamps = [];
    this.state = { kind: 'ok' };
  }

  get tripped(): boolean { return this.state.kind === 'tripped'; }
}
