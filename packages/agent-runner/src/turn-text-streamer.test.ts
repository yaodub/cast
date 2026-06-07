/**
 * Unit tests for TurnTextStreamer — verbs, state transitions, nextTurn-gating.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createTurnTextStreamer,
  type TurnTextStreamer,
} from './turn-text-streamer.js';

type Frame = Record<string, unknown>;

function makeStreamer(opts?: { tickIntervalMs?: number }): {
  streamer: TurnTextStreamer;
  frames: Frame[];
  streamIdCounter: { value: number };
} {
  const frames: Frame[] = [];
  const streamIdCounter = { value: 0 };
  const streamer = createTurnTextStreamer({
    write: (out) => { frames.push(out as Frame); },
    generateStreamId: () => `strm-${++streamIdCounter.value}`,
    // Disable the timer for unit tests — we drive ticks deterministically.
    tickIntervalMs: opts?.tickIntervalMs ?? 0,
  });
  return { streamer, frames, streamIdCounter };
}

function previewFrames(frames: Frame[]): Frame[] {
  return frames.filter((f) => f.type === 'preview');
}
function messageFrames(frames: Frame[]): Frame[] {
  return frames.filter((f) => f.type === 'message');
}

describe('TurnTextStreamer', () => {
  describe('basic flow', () => {
    it('feedDelta accumulates the snapshot', () => {
      const { streamer } = makeStreamer();
      streamer.feedDelta('hello ');
      streamer.feedDelta('world');
      expect(streamer.getSnapshot()).toBe('hello world');
      expect(streamer.getState()).toBe('streaming');
    });

    it('feedDelta strips <cast:*> tags via the streaming filter', () => {
      const { streamer } = makeStreamer();
      streamer.feedDelta('hello <cast:internal>secret');
      streamer.feedDelta('</cast:internal> world');
      expect(streamer.getSnapshot()).toBe('hello  world');
    });

    it('commitBlock pushes the in-progress block and joins multi-block with \\n', () => {
      const { streamer } = makeStreamer();
      streamer.feedDelta('first block');
      streamer.commitBlock('first block');
      streamer.feedDelta('second block');
      streamer.commitBlock('second block');
      expect(streamer.getSnapshot()).toBe('first block\nsecond block');
    });

    it('flushFinal emits the seal with streamId + raw text + subtype', () => {
      const { streamer, frames, streamIdCounter } = makeStreamer();
      const initialStreamId = `strm-${streamIdCounter.value}`;
      streamer.feedDelta('hi');
      streamer.flushFinal('hi', 'session-abc', 'success');
      const seal = messageFrames(frames).at(-1)!;
      expect(seal.type).toBe('message');
      expect(seal.streamId).toBe(initialStreamId);
      expect(seal.result).toBe('hi');
      expect(seal.subtype).toBe('success');
      expect(seal.newSessionId).toBe('session-abc');
      expect(streamer.getState()).toBe('sealed');
    });

    it('flushFinal with null sdkText emits empty result', () => {
      const { streamer, frames } = makeStreamer();
      streamer.flushFinal(null);
      const seal = messageFrames(frames).at(-1)!;
      expect(seal.result).toBe('');
    });

    it('emits exactly one preview when feedDelta changes snapshot then flushFinal fires', () => {
      const { streamer, frames } = makeStreamer();
      streamer.feedDelta('rainbow');
      streamer.flushFinal('rainbow');
      const previews = previewFrames(frames);
      expect(previews.length).toBe(1);
      expect(previews[0]!.text).toBe('rainbow');
    });

    it('does not emit duplicate previews when snapshot is unchanged', () => {
      const { streamer, frames } = makeStreamer();
      streamer.feedDelta('hi');
      streamer.flushFinal('hi');
      streamer.flushFinal('hi'); // already sealed, no-op
      const previews = previewFrames(frames);
      expect(previews.length).toBe(1);
    });
  });

  describe('flushIntermediate', () => {
    it('rotates streamId; state stays streaming; subsequent ticks use the new streamId', () => {
      const { streamer, frames, streamIdCounter } = makeStreamer();
      const sid1 = `strm-${streamIdCounter.value}`;
      streamer.feedDelta('part one');
      streamer.flushIntermediate('part one', 'session-1');
      // After intermediate: streamId rotates, snapshot resets, state stays streaming.
      expect(streamer.getState()).toBe('streaming');
      expect(streamer.getStreamId()).not.toBe(sid1);
      expect(streamer.getSnapshot()).toBe('');

      const sid2 = streamer.getStreamId();
      streamer.feedDelta('part two');
      streamer.flushFinal('part two');

      const seals = messageFrames(frames);
      expect(seals.length).toBe(2);
      // First seal is the intermediate, second is the final.
      expect(seals[0]!.streamId).toBe(sid1);
      expect(seals[0]!.intermediate).toBe(true);
      expect(seals[1]!.streamId).toBe(sid2);
      expect(seals[1]!.intermediate).toBeUndefined();
    });
  });

  describe('nextTurn — refinement 1 + 3 (path b)', () => {
    it('participant kind re-arms and rotates streamId', () => {
      const { streamer, frames } = makeStreamer();
      streamer.feedDelta('first turn');
      streamer.flushFinal('first turn');
      const sid1 = (messageFrames(frames).at(-1) as Frame).streamId;

      streamer.nextTurn('participant');
      expect(streamer.getState()).toBe('streaming');
      expect(streamer.getStreamId()).not.toBe(sid1);
      expect(streamer.getSnapshot()).toBe('');

      streamer.feedDelta('second turn');
      streamer.flushFinal('second turn');
      const sid2 = (messageFrames(frames).at(-1) as Frame).streamId;
      expect(sid2).not.toBe(sid1);
    });

    it('system kind (systemFormatError / systemUndelivered repipe) does NOT re-arm', () => {
      const { streamer } = makeStreamer();
      streamer.feedDelta('first');
      streamer.flushFinal('first');
      const sealedSid = streamer.getStreamId();
      const sealedSnapshot = streamer.getSnapshot();

      streamer.nextTurn('system');
      expect(streamer.getState()).toBe('sealed');
      expect(streamer.getStreamId()).toBe(sealedSid);
      expect(streamer.getSnapshot()).toBe(sealedSnapshot);
    });

    it.each(['schedule', 'service', 'lifecycle', 'watch', 'push', 'system'] as const)(
      'kind=%s does NOT re-arm a sealed streamer',
      (kind) => {
        const { streamer } = makeStreamer();
        streamer.feedDelta('done');
        streamer.flushFinal('done');
        const sealedSid = streamer.getStreamId();
        streamer.nextTurn(kind);
        expect(streamer.getState()).toBe('sealed');
        expect(streamer.getStreamId()).toBe(sealedSid);
      },
    );
  });

  describe('abort', () => {
    it('emits a sealing message and transitions to aborted', () => {
      const { streamer, frames } = makeStreamer();
      streamer.feedDelta('partial');
      streamer.abort('container_error');
      expect(streamer.getState()).toBe('aborted');
      const seals = messageFrames(frames);
      expect(seals.length).toBe(1);
      expect(seals[0]!.result).toBe('partial');
    });

    it('subsequent feedDelta and flushes are no-ops in aborted state', () => {
      const { streamer, frames } = makeStreamer();
      streamer.feedDelta('p');
      streamer.abort('container_error');
      const sealsAfterAbort = messageFrames(frames).length;

      streamer.feedDelta('more');
      streamer.flushFinal('something');
      streamer.commitBlock('also no-op');

      expect(messageFrames(frames).length).toBe(sealsAfterAbort);
      expect(streamer.getSnapshot()).toBe('p');
    });
  });

  describe('ticker behavior', () => {
    it('500ms tick emits previews when snapshot changes', async () => {
      vi.useFakeTimers();
      try {
        const frames: Frame[] = [];
        const streamer = createTurnTextStreamer({
          write: (out) => { frames.push(out as Frame); },
          generateStreamId: () => 'strm-A',
          tickIntervalMs: 500,
        });
        streamer.feedDelta('a');
        vi.advanceTimersByTime(500);
        streamer.feedDelta('b');
        vi.advanceTimersByTime(500);
        streamer.feedDelta('c');
        vi.advanceTimersByTime(500);
        streamer.dispose();

        const previews = previewFrames(frames);
        // We expect 3 ticks (snapshot changed each interval).
        expect(previews.length).toBe(3);
        expect(previews.map((p) => p.text)).toEqual(['a', 'ab', 'abc']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('idle ticks (no snapshot change) emit nothing', async () => {
      vi.useFakeTimers();
      try {
        const frames: Frame[] = [];
        const streamer = createTurnTextStreamer({
          write: (out) => { frames.push(out as Frame); },
          generateStreamId: () => 'strm-B',
          tickIntervalMs: 500,
        });
        streamer.feedDelta('x');
        vi.advanceTimersByTime(2000); // 4 ticks
        streamer.dispose();
        const previews = previewFrames(frames);
        expect(previews.length).toBe(1); // first tick emitted; rest were duplicates
      } finally {
        vi.useRealTimers();
      }
    });

    it('ticks before any delta emit nothing (empty snapshot is skipped)', async () => {
      // Regression: §3.8.6 e2e surfaced an empty preview frame being shipped
      // when an empty turn (tool-only) ran. The first tick fired before any
      // feedDelta, snapshot was still '', and the old `snapshot !== lastEmitted`
      // gate let it through because lastEmitted was null. Fix: skip empty
      // snapshots. Verified here so it doesn't regress.
      vi.useFakeTimers();
      try {
        const frames: Frame[] = [];
        const streamer = createTurnTextStreamer({
          write: (out) => { frames.push(out as Frame); },
          generateStreamId: () => 'strm-C',
          tickIntervalMs: 500,
        });
        vi.advanceTimersByTime(2000); // 4 ticks, no delta
        streamer.dispose();
        const previews = previewFrames(frames);
        expect(previews.length).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('dispose', () => {
    it('is idempotent and safe to call after seal/abort', () => {
      const { streamer } = makeStreamer();
      streamer.flushFinal('x');
      streamer.dispose();
      streamer.dispose();
      // No assertion needed — just confirm no throw.
    });
  });
});
