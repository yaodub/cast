import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostActivityLog } from './server/host-activity-log.js';

vi.mock('./logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

import { logger } from './logger.js';

describe('HostActivityLog', () => {
  let log: HostActivityLog;

  beforeEach(() => {
    log = new HostActivityLog(':memory:');
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.info).mockClear();
  });

  afterEach(() => {
    log.close();
  });

  it('round-trips a basic event', () => {
    log.logEvent('error', 'container', 'spawn_failed', 'Container spawn syscall failed');
    const events = log.readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'error',
      component: 'container',
      event_name: 'spawn_failed',
      message: 'Container spawn syscall failed',
      from_addr: null,
      to_addr: null,
      context: null,
    });
    expect(events[0].id).toBeGreaterThan(0);
    expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves from_addr / to_addr / context', () => {
    log.logEvent('warn', 'bus', 'unrouted_packet', 'No handler for to', {
      fromAddr: 'tg:12345',
      toAddr: 'agent-y@idp',
      context: { payload_type: 'request' },
    });
    const [evt] = log.readEvents();
    expect(evt.from_addr).toBe('tg:12345');
    expect(evt.to_addr).toBe('agent-y@idp');
    expect(evt.context).toEqual({ payload_type: 'request' });
  });

  it('mirrors writes to pino at the same level', () => {
    log.logEvent('warn', 'bus', 'unrouted_packet', 'msg', { fromAddr: 'a', toAddr: 'b' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'bus', event: 'unrouted_packet', from: 'a', to: 'b' }),
      'msg',
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('returns events newest-first', () => {
    log.logEvent('info', 'lifecycle', 'agent_registered', 'first');
    log.logEvent('info', 'lifecycle', 'agent_registered', 'second');
    log.logEvent('info', 'lifecycle', 'agent_registered', 'third');
    const events = log.readEvents();
    expect(events.map((e) => e.message)).toEqual(['third', 'second', 'first']);
  });

  it('filters by level', () => {
    log.logEvent('error', 'container', 'spawn_failed', 'e1');
    log.logEvent('warn', 'auth', 'identity_register_failed', 'w1');
    log.logEvent('info', 'lifecycle', 'agent_registered', 'i1');

    expect(log.readEvents({ level: 'error' })).toHaveLength(1);
    expect(log.readEvents({ level: 'warn' })).toHaveLength(1);
    expect(log.readEvents({ level: 'info' })).toHaveLength(1);
  });

  it('filters by component', () => {
    log.logEvent('warn', 'bus', 'unrouted_packet', 'b1');
    log.logEvent('warn', 'bus', 'unrouted_packet', 'b2');
    log.logEvent('error', 'container', 'spawn_failed', 'c1');

    const busEvents = log.readEvents({ component: 'bus' });
    expect(busEvents).toHaveLength(2);
    expect(busEvents.every((e) => e.component === 'bus')).toBe(true);
  });

  it('filters by since (ts > value)', () => {
    log.logEvent('info', 'lifecycle', 'a', 'one');
    log.logEvent('info', 'lifecycle', 'a', 'two');
    log.logEvent('info', 'lifecycle', 'a', 'three');

    // A cutoff in the past returns everything.
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(log.readEvents({ since: past })).toHaveLength(3);

    // A cutoff in the future returns nothing.
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(log.readEvents({ since: future })).toHaveLength(0);
  });

  it('enforces limit and reports total via countEvents', () => {
    for (let i = 0; i < 5; i++) {
      log.logEvent('info', 'lifecycle', 'agent_registered', `m${i}`);
    }
    const limited = log.readEvents({ limit: 2 });
    expect(limited).toHaveLength(2);
    expect(log.countEvents()).toBe(5);
  });

  it('clearEvents truncates the table', () => {
    log.logEvent('info', 'lifecycle', 'a', 'one');
    log.logEvent('info', 'lifecycle', 'a', 'two');
    expect(log.countEvents()).toBe(2);

    const deleted = log.clearEvents();
    expect(deleted).toBe(2);
    expect(log.countEvents()).toBe(0);
    expect(log.readEvents()).toEqual([]);
  });
});
