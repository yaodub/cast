/**
 * ConnectionManager tests — the reconnect state machine, backoff, pairing
 * plumbing, and pairing-status gating. The library's `connect`/`pair` are the
 * trusted boundary and are faked here; what these tests exercise is the glue.
 *
 * No socket, no account. The only real I/O is a temp `privateDir` so the
 * filesystem-backed `isPaired()` check runs for real.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { Client, ConnectOptions, DeathReason, VerificationPrompt } from 'gmessages';

import {
  ConnectionManager,
  isRetryable,
  fatalConnectReason,
  type ConnectionDeps,
  type PairInput,
} from './connection.js';
import { SESSION_FILE } from './connect.js';

/** Mimics a library error: message + the stable `code` discriminant. */
class LibError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = code;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RETRYABLE: DeathReason = { kind: 'stream-error', error: new Error('boom') };
const parked = (): Promise<DeathReason | null> => new Promise<DeathReason | null>(() => {});

/**
 * A fake `connect`. `finishedQueue[i]` is the promise the i-th connection's
 * `finished()` returns; past the end, the last entry repeats. Records the stop
 * spy and the options each connection was opened with.
 */
function makeConnect(
  finishedQueue: Array<Promise<DeathReason | null>>,
  onOpen?: (options: ConnectOptions) => void,
) {
  const stopSpies: Array<ReturnType<typeof vi.fn>> = [];
  let i = 0;
  const fn = vi.fn(async (options: ConnectOptions): Promise<Client> => {
    onOpen?.(options);
    const finished = finishedQueue[Math.min(i, finishedQueue.length - 1)]!;
    i++;
    const stop = vi.fn(async () => {});
    stopSpies.push(stop);
    return {
      operations: {},
      media: null,
      store: {},
      finished: () => finished,
      stop,
    } as unknown as Client;
  });
  return { fn, stopSpies };
}

function baseDeps(
  connect: ConnectionDeps['connect'],
  sleep: ConnectionDeps['sleep'],
  now: ConnectionDeps['now'] = () => 0, // constant clock → every death is a "flap" unless overridden
): Partial<ConnectionDeps> {
  return {
    connect,
    loadStore: vi.fn(async () => ({ session: 'BLOB', onSessionUpdate: vi.fn() })),
    fetchImpl: vi.fn() as unknown as typeof fetch,
    endpoints: { receiveUrl: 'https://x/receive', registerRefreshUrl: 'https://x/RegisterRefresh' } as never,
    apiKey: 'test-key',
    sleep,
    now,
  };
}

// ---------------------------------------------------------------------------

describe('isRetryable', () => {
  it('parks jar-dead and auth-fatal, retries the rest', () => {
    expect(isRetryable({ kind: 'jar-dead' })).toBe(false);
    expect(isRetryable({ kind: 'stream-fatal', status: 401 })).toBe(false);
    expect(isRetryable({ kind: 'stream-fatal', status: 403 })).toBe(false);
    expect(isRetryable({ kind: 'stream-fatal', status: 500 })).toBe(true);
    expect(isRetryable({ kind: 'stream-error', error: new Error() })).toBe(true);
    expect(isRetryable({ kind: 'refresh-failed', error: new Error() })).toBe(true);
  });
});

describe('fatalConnectReason', () => {
  it('treats a dead jar as terminal, mapped to jar-dead', () => {
    expect(fatalConnectReason(new LibError('JarDeadError'))).toEqual({ kind: 'jar-dead' });
  });

  it('treats unusable-session errors as terminal', () => {
    expect(fatalConnectReason(new LibError('EndpointError'))?.kind).toBe('refresh-failed');
    expect(fatalConnectReason(new LibError('SessionImportError'))?.kind).toBe('refresh-failed');
  });

  it('lets anything else retry', () => {
    expect(fatalConnectReason(new Error('ECONNRESET'))).toBeNull();
    expect(fatalConnectReason(new LibError('ReadError'))).toBeNull();
    expect(fatalConnectReason(null)).toBeNull();
  });
});

describe('ConnectionManager', () => {
  let dir: string;
  const sessionFile = () => path.join(dir, SESSION_FILE);
  const writeSessionFile = () => fs.writeFileSync(sessionFile(), 'BLOB', { mode: 0o600 });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-conn-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('opens, resolves ready, and forwards events', async () => {
    writeSessionFile();
    let opened: ConnectOptions | undefined;
    const { fn } = makeConnect([parked()], (o) => {
      opened = o;
    });
    const onEvent = vi.fn();
    const mgr = new ConnectionManager({
      privateDir: dir,
      onEvent,
      deps: baseDeps(fn, async () => {}),
    });

    mgr.start();
    await mgr.ready;

    expect(mgr.isConnected()).toBe(true);
    expect(mgr.status.status).toBe('open');
    // The connection was opened with our session blob and key.
    expect(opened?.session).toBe('BLOB');
    expect(opened?.apiKey).toBe('test-key');

    // A stream event is forwarded to the watch sink.
    const sample = { kind: 'push' } as never;
    opened?.onEvent?.(sample);
    expect(onEvent).toHaveBeenCalledWith(sample);
  });

  it('does not connect when unpaired', async () => {
    // No session file written.
    const { fn } = makeConnect([parked()]);
    const mgr = new ConnectionManager({ privateDir: dir, deps: baseDeps(fn, async () => {}) });

    mgr.start();
    await Promise.resolve();

    expect(fn).not.toHaveBeenCalled();
    expect(mgr.status.status).toBe('unpaired');
  });

  it('reconnects after a retryable death', async () => {
    writeSessionFile();
    const delays: number[] = [];
    const { fn } = makeConnect([Promise.resolve(RETRYABLE), parked()]);
    const mgr = new ConnectionManager({
      privateDir: dir,
      deps: baseDeps(fn, async (ms) => {
        delays.push(ms);
      }),
    });

    mgr.start();
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(delays).toEqual([1_000]); // first backoff
    await vi.waitFor(() => expect(mgr.status.status).toBe('open'));
  });

  it('backs off exponentially and caps at 60s', async () => {
    writeSessionFile();
    const delays: number[] = [];
    // Seven retryable deaths, then park.
    const queue: Array<Promise<DeathReason | null>> = [...Array(7)].map(() =>
      Promise.resolve(RETRYABLE),
    );
    queue.push(parked());
    const { fn } = makeConnect(queue);
    const mgr = new ConnectionManager({
      privateDir: dir,
      deps: baseDeps(fn, async (ms) => {
        delays.push(ms);
      }),
    });

    mgr.start();
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(8));
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
  });

  it('resets backoff after a connection stays open past the stability threshold', async () => {
    writeSessionFile();
    const delays: number[] = [];
    // A clock that jumps 60s each time it is read: every connection reads
    // openedAt then (at death) a value 60s later — comfortably past MIN_STABLE_MS.
    let t = 0;
    const now = () => {
      const v = t;
      t += 60_000;
      return v;
    };
    const queue: Array<Promise<DeathReason | null>> = [
      Promise.resolve(RETRYABLE),
      Promise.resolve(RETRYABLE),
      parked(),
    ];
    const { fn } = makeConnect(queue);
    const mgr = new ConnectionManager({
      privateDir: dir,
      deps: baseDeps(
        fn,
        async (ms) => {
          delays.push(ms);
        },
        now,
      ),
    });

    mgr.start();
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(3));
    // Each death followed a stable period, so backoff never escalates past 1s.
    expect(delays).toEqual([1_000, 1_000]);
  });

  it('parks as dead on jar-dead, without reconnecting', async () => {
    writeSessionFile();
    const delays: number[] = [];
    const { fn } = makeConnect([Promise.resolve({ kind: 'jar-dead' } as DeathReason), parked()]);
    const mgr = new ConnectionManager({
      privateDir: dir,
      deps: baseDeps(fn, async (ms) => {
        delays.push(ms);
      }),
    });

    mgr.start();
    await vi.waitFor(() => expect(mgr.status.status).toBe('dead'));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('parks as dead on an auth-fatal status', async () => {
    writeSessionFile();
    const { fn } = makeConnect([
      Promise.resolve({ kind: 'stream-fatal', status: 401 } as DeathReason),
      parked(),
    ]);
    const mgr = new ConnectionManager({ privateDir: dir, deps: baseDeps(fn, async () => {}) });

    mgr.start();
    await vi.waitFor(() => {
      const s = mgr.status;
      expect(s.status).toBe('dead');
      if (s.status === 'dead') expect(s.reason.kind).toBe('stream-fatal');
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('parks as dead when connect() THROWS a dead jar, without retrying', async () => {
    // The stale-session case, seen live: the relay 401s before any stream
    // exists, so connect() throws instead of finished() reporting.
    writeSessionFile();
    const delays: number[] = [];
    const connect = vi.fn(async () => {
      throw new LibError('JarDeadError', 'these cookies no longer authenticate');
    });
    const mgr = new ConnectionManager({
      privateDir: dir,
      deps: baseDeps(connect as unknown as ConnectionDeps['connect'], async (ms) => {
        delays.push(ms);
      }),
    });

    mgr.start();
    await vi.waitFor(() => expect(mgr.status.status).toBe('dead'));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
    expect(mgr.deadReason()).toContain('Re-pair');
  });

  it('retries a transient connect failure', async () => {
    writeSessionFile();
    const delays: number[] = [];
    let calls = 0;
    const { fn } = makeConnect([parked()]);
    const connect = vi.fn(async (options: never) => {
      calls++;
      if (calls === 1) throw new Error('ECONNRESET');
      return fn(options);
    });
    const mgr = new ConnectionManager({
      privateDir: dir,
      deps: baseDeps(connect as unknown as ConnectionDeps['connect'], async (ms) => {
        delays.push(ms);
      }),
    });

    mgr.start();
    await mgr.ready;
    expect(calls).toBe(2);
    expect(delays).toEqual([1_000]);
    expect(mgr.deadReason()).toBeNull();
  });

  it('stop() tears down the client and prevents reconnect', async () => {
    writeSessionFile();
    // Give the first connection a controllable finished we resolve AFTER stop.
    let resolveFinished!: (r: DeathReason | null) => void;
    const controllable = new Promise<DeathReason | null>((r) => {
      resolveFinished = r;
    });
    const { fn, stopSpies } = makeConnect([controllable, parked()]);
    const mgr = new ConnectionManager({ privateDir: dir, deps: baseDeps(fn, async () => {}) });

    mgr.start();
    await mgr.ready;
    await mgr.stop();

    expect(stopSpies[0]).toHaveBeenCalled();
    expect(mgr.status.status).toBe('stopped');

    // Even if the old stream now reports a retryable death, no reconnect happens.
    resolveFinished(RETRYABLE);
    await Promise.resolve();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('pair() composes, persists the session, returns the prompt, and starts', async () => {
    // Not paired yet.
    const prompt: VerificationPrompt = { emoji: '🐱🐶🐢🐟', numeric: '123', number: 42, codeVersion: 1 };
    const onVerificationSeen = vi.fn();
    const pairImpl = vi.fn(async (input: PairInput) => {
      await input.onVerification(prompt); // exercise the callback wiring
      return { blob: 'PAIRED_BLOB', prompt };
    });
    const writeSession = vi.fn(async (p: string, blob: string) => {
      fs.writeFileSync(p, blob, { mode: 0o600 }); // real write so isPaired() flips
    });
    const { fn } = makeConnect([parked()]);
    const mgr = new ConnectionManager({
      privateDir: dir,
      deps: { ...baseDeps(fn, async () => {}), pair: pairImpl, writeSession },
    });

    expect(mgr.isPaired()).toBe(false);
    const returned = await mgr.pair('cookie=jar', onVerificationSeen);

    expect(returned).toEqual(prompt);
    expect(onVerificationSeen).toHaveBeenCalledWith(prompt);
    expect(writeSession).toHaveBeenCalledWith(sessionFile(), 'PAIRED_BLOB');
    expect(fs.readFileSync(sessionFile(), 'utf8')).toBe('PAIRED_BLOB');
    expect(mgr.isPaired()).toBe(true);
    // Pairing kicked off the connect loop.
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
  });
});
