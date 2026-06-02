import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createDebounced } from './lib/debounce.js';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('createDebounced', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the handler after the quiet window when scheduled once', () => {
    const handler = vi.fn();
    const d = createDebounced(handler, 1000);

    d.schedule();
    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(999);
    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('coalesces multiple schedules within the window into one call', () => {
    const handler = vi.fn();
    const d = createDebounced(handler, 1000);

    d.schedule();
    vi.advanceTimersByTime(500);
    d.schedule();
    vi.advanceTimersByTime(500);
    d.schedule();
    vi.advanceTimersByTime(999);
    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('cancel() suppresses a pending fire', () => {
    const handler = vi.fn();
    const d = createDebounced(handler, 1000);

    d.schedule();
    d.cancel();
    vi.advanceTimersByTime(5000);

    expect(handler).not.toHaveBeenCalled();
  });

  it('flushNow() runs the handler synchronously and clears the timer', () => {
    const handler = vi.fn();
    const d = createDebounced(handler, 1000);

    d.schedule();
    d.flushNow();
    expect(handler).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a handler that throws does not break subsequent schedules', () => {
    const handler = vi.fn().mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const d = createDebounced(handler, 1000);

    d.schedule();
    vi.advanceTimersByTime(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    d.schedule();
    vi.advanceTimersByTime(1000);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('async handler rejection does not break subsequent schedules', async () => {
    const handler = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
      .mockImplementationOnce(() => Promise.resolve());
    const d = createDebounced(handler, 1000);

    d.schedule();
    vi.advanceTimersByTime(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    // Allow the rejected promise's catch handler to settle.
    await Promise.resolve();
    await Promise.resolve();

    d.schedule();
    vi.advanceTimersByTime(1000);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
