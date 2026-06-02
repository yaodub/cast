/**
 * TurnTextStreamer — drives preview frames during an SDK turn and stamps the
 * matching durable seal on completion. Constructed once per `runQuery`.
 */
import { createTagStripper, type TagStripper } from './tag-strip.js';

// Mirrors host-side ContainerOutput (agent-schema is canonical).
type ContainerOutput =
  | { type: 'message'; result: string; intermediate?: boolean; newSessionId?: string; subtype?: 'success'; streamId?: string }
  | { type: 'error'; error: string; newSessionId?: string }
  | { type: 'auth_error' }
  | { type: 'lifecycle'; phase: 'bootstrap' | 'compacting' | 'idle'; active: boolean; preTokens?: number; trigger?: 'manual' | 'auto' }
  | { type: 'preview'; kind: 'text'; streamId: string; text: string };

export type PipeMessageKind =
  | 'participant'
  | 'schedule'
  | 'service'
  | 'lifecycle'
  | 'watch'
  | 'push'
  | 'system';

export type StreamerState = 'streaming' | 'sealed' | 'aborted';

export type AbortReason = 'container_error' | 'size_cap' | 'participant_disconnected';

export interface TurnTextStreamerOpts {
  write: (output: ContainerOutput) => void;
  generateStreamId: () => string;
  /** Tick interval (ms). Default 1000. 0 disables the timer (tests). */
  tickIntervalMs?: number;
}

export interface TurnTextStreamer {
  feedDelta(text: string): void;
  commitBlock(text: string): void;
  flushIntermediate(rawText: string, newSessionId?: string): void;
  flushFinal(rawText: string | null, newSessionId?: string, subtype?: 'success'): void;
  /** Re-arms (rotate streamId, reset state) only when `pipeKind === 'participant'`.
   *  Other kinds keep current state so a retry seal lands on the same bubble. */
  nextTurn(pipeKind: PipeMessageKind): void;
  abort(reason: AbortReason): void;
  /** Idempotent; safe after flushFinal / abort. */
  dispose(): void;
  getStreamId(): string;
  getSnapshot(): string;
  getState(): StreamerState;
}

export function createTurnTextStreamer(opts: TurnTextStreamerOpts): TurnTextStreamer {
  const tickMs = opts.tickIntervalMs ?? 1000;

  let blocks: string[] = [];
  let currentBuf = '';
  let snapshot = '';
  let lastEmitted: string | null = null;
  let streamId = opts.generateStreamId();
  let state: StreamerState = 'streaming';
  let stripper: TagStripper = createTagStripper();
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  function recomputeSnapshot(): void {
    if (blocks.length === 0) {
      snapshot = currentBuf;
    } else if (currentBuf.length === 0) {
      snapshot = blocks.join('\n');
    } else {
      snapshot = blocks.join('\n') + '\n' + currentBuf;
    }
  }

  function emitTickIfChanged(): void {
    if (state !== 'streaming') return;
    if (snapshot === lastEmitted) return;
    // Skip empty snapshots — the first tick can fire before any text delta
    // arrives (e.g. tool-only turns, slow first-token latency). An empty
    // preview frame carries no information and would just be a stray
    // empty-text bubble on the participant's UI.
    if (snapshot === '') return;
    opts.write({ type: 'preview', kind: 'text', streamId, text: snapshot });
    lastEmitted = snapshot;
  }

  function startInterval(): void {
    if (tickTimer || tickMs <= 0) return;
    tickTimer = setInterval(emitTickIfChanged, tickMs);
    // Don't keep the event loop alive for the tick alone — the SDK query
    // holds the process; without unref the tick keeps node running post-seal.
    if (typeof (tickTimer as { unref?: () => void }).unref === 'function') {
      (tickTimer as { unref?: () => void }).unref!();
    }
  }

  function clearTimer(): void {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function resetStream(): void {
    blocks = [];
    currentBuf = '';
    snapshot = '';
    lastEmitted = null;
    stripper = createTagStripper();
    streamId = opts.generateStreamId();
  }

  startInterval();

  return {
    feedDelta(text: string): void {
      if (state !== 'streaming') return;
      currentBuf += stripper.feed(text);
      recomputeSnapshot();
    },

    commitBlock(_text: string): void {
      if (state !== 'streaming') return;
      currentBuf += stripper.flush();
      blocks.push(currentBuf);
      currentBuf = '';
      stripper = createTagStripper();
      recomputeSnapshot();
    },

    flushIntermediate(rawText: string, newSessionId?: string): void {
      if (state !== 'streaming') return;
      currentBuf += stripper.flush();
      recomputeSnapshot();
      emitTickIfChanged();
      const out: ContainerOutput = { type: 'message', result: rawText, intermediate: true, streamId };
      if (newSessionId !== undefined) (out as { newSessionId?: string }).newSessionId = newSessionId;
      opts.write(out);
      resetStream();
    },

    flushFinal(rawText: string | null, newSessionId?: string, subtype?: 'success'): void {
      if (state !== 'streaming') return;
      currentBuf += stripper.flush();
      recomputeSnapshot();
      emitTickIfChanged();
      clearTimer();
      state = 'sealed';
      const out: ContainerOutput = { type: 'message', result: rawText ?? '', streamId };
      if (newSessionId !== undefined) (out as { newSessionId?: string }).newSessionId = newSessionId;
      if (subtype !== undefined) (out as { subtype?: 'success' }).subtype = subtype;
      opts.write(out);
    },

    nextTurn(pipeKind: PipeMessageKind): void {
      if (pipeKind !== 'participant') return;
      resetStream();
      state = 'streaming';
      startInterval();
    },

    abort(_reason: AbortReason): void {
      if (state !== 'streaming') return;
      currentBuf += stripper.flush();
      recomputeSnapshot();
      emitTickIfChanged();
      clearTimer();
      state = 'aborted';
      opts.write({ type: 'message', result: snapshot, streamId });
    },

    dispose(): void {
      clearTimer();
    },

    getStreamId: () => streamId,
    getSnapshot: () => snapshot,
    getState: () => state,
  };
}
