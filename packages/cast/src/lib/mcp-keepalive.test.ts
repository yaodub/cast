import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mcp-keepalive only needs MCP_KEEPALIVE_INTERVAL_MS from config and the logger —
// mock both so the test needs no env. Short interval for fast fake-timer advances.
vi.mock('../config.js', () => ({ MCP_KEEPALIVE_INTERVAL_MS: 50 }));
vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { startMcpKeepalive } from './mcp-keepalive.js';

const fakeServer = (ping: () => Promise<unknown>) => ({ server: { ping } }) as never;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('startMcpKeepalive', () => {
  it('pings on the interval and stops on stop()', async () => {
    const ping = vi.fn().mockResolvedValue({});
    const stop = startMcpKeepalive(fakeServer(ping), { sessionId: 's1' });

    await vi.advanceTimersByTimeAsync(60);
    expect(ping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(ping).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(ping).toHaveBeenCalledTimes(2); // no pings after stop()
  });

  it('skips overlapping pings while one is in flight', async () => {
    let resolve!: () => void;
    const ping = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const stop = startMcpKeepalive(fakeServer(ping), {});

    await vi.advanceTimersByTimeAsync(60); // first ping starts, stays pending
    expect(ping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200); // many ticks, but in-flight → all skipped
    expect(ping).toHaveBeenCalledTimes(1);

    resolve(); // first ping settles → guard clears
    await vi.advanceTimersByTimeAsync(60);
    expect(ping).toHaveBeenCalledTimes(2);
    stop();
  });

  it('swallows a ping rejection (dead/absent SSE stream) and keeps going', async () => {
    const ping = vi.fn().mockRejectedValue(new Error('no stream'));
    const stop = startMcpKeepalive(fakeServer(ping), {});

    await vi.advanceTimersByTimeAsync(60);
    expect(ping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50); // rejection didn't surface; next tick still pings
    expect(ping).toHaveBeenCalledTimes(2);
    stop();
  });
});
