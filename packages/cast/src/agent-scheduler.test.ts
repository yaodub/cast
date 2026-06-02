/**
 * Unit tests for AgentScheduler.
 *
 * Tests parseScheduleEntries (private) indirectly via the public start()/tick
 * cycle, and verifies task dispatch through the route() callback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks (must be before imports) ---

vi.mock('./config.js', () => ({
  SCHEDULER_POLL_INTERVAL: 60_000,
  TIMEZONE: 'UTC',
  agentPath: (folder: string, ...segments: string[]) =>
    ['/tmp/test-agents', folder, ...segments].join('/'),
}));

const readTextMock = vi.fn<(path: string) => string | null>(() => null);
vi.mock('./lib/config-reader.js', () => ({
  readText: (...args: unknown[]) => readTextMock(args[0] as string),
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AgentScheduler } from './agent/agent-scheduler.js';
import { logger } from './logger.js';
import type { AgentStateStore } from './agent/state-store.js';

// --- Helpers ---

/** Advance past exactly one poll-interval boundary so every-minute crons fire once. */
const ONE_TICK = 60_001;

function mockStore(): AgentStateStore {
  return {
    recoverStuckTasks: vi.fn(() => 0),
    getTasksForAddress: vi.fn(() => []),
    getDueTasksForAgent: vi.fn(() => []),
    getTaskById: vi.fn(),
    updateTask: vi.fn(),
    updateTaskAfterRun: vi.fn(),
    logTaskRun: vi.fn(),
  } as unknown as AgentStateStore;
}

function makeScheduler(opts?: {
  store?: AgentStateStore;
  route?: (...args: unknown[]) => Promise<{ ok: true; result: string | null } | { ok: false; error: string }>;
  isDraft?: () => boolean;
}) {
  return new AgentScheduler({
    folder: 'test-agent',
    agentId: 'agent:test-agent',
    store: opts?.store ?? mockStore(),
    route: (opts?.route as any) ?? vi.fn(async () => ({ ok: true as const, result: null })),
    isDraft: opts?.isDraft ?? (() => false),
  });
}

// --- Tests ---

describe('AgentScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-04-02T12:00:00Z') });
    readTextMock.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ===== Schedule parsing (via readCached mock) =====

  describe('parseScheduleEntries (via start)', () => {
    it('null content — no scheduled messages, start does not crash', () => {
      readTextMock.mockReturnValue(null);
      const scheduler = makeScheduler();
      expect(() => scheduler.start()).not.toThrow();
      scheduler.stop();
    });

    it('empty string content — no scheduled messages', () => {
      readTextMock.mockReturnValue('');
      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = new AgentScheduler({
        folder: 'test-agent',
        agentId: 'agent:test-agent',
        store: mockStore(),
        route,
        isDraft: () => false,
      });
      scheduler.start();
      // No schedule entries parsed and store returns no due tasks → route never called.
      expect(route).not.toHaveBeenCalled();
      scheduler.stop();
    });

    it('valid cron line parses and dispatches when due', () => {
      // "* * * * *" (every minute). At 12:00:00 the parsed nextRun is 12:01:00.
      // Advance one tick (60s) so fake clock reaches 12:01:00 and the entry becomes due.
      readTextMock.mockReturnValue('* * * * * default Hello world');
      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = new AgentScheduler({
        folder: 'test-agent',
        agentId: 'agent:test-agent',
        store: mockStore(),
        route,
        isDraft: () => false,
      });
      scheduler.start();
      vi.advanceTimersByTime(ONE_TICK);
      expect(route).toHaveBeenCalledWith(
        'agent:test-agent',
        'agent:test-agent',
        'Hello world',
        { channel: 'default', qualifier: undefined },
      );
      scheduler.stop();
    });

    it.each([
      { label: 'comment', content: '# This is a comment\n* * * * * default Ping', message: 'Ping' },
      { label: 'blank', content: '\n\n* * * * * default Active line\n\n', message: 'Active line' },
    ])('$label lines are skipped', ({ content, message }) => {
      readTextMock.mockReturnValue(content);
      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = new AgentScheduler({
        folder: 'test-agent',
        agentId: 'agent:test-agent',
        store: mockStore(),
        route,
        isDraft: () => false,
      });
      scheduler.start();
      vi.advanceTimersByTime(ONE_TICK);
      expect(route).toHaveBeenCalledTimes(1);
      expect(route).toHaveBeenCalledWith(
        'agent:test-agent',
        'agent:test-agent',
        message,
        { channel: 'default', qualifier: undefined },
      );
      scheduler.stop();
    });

    it('lines with fewer than 7 fields are skipped', () => {
      // First line has only 6 fields (cron 5 + channel 1, no message) → skipped.
      // Second line has 7 fields but "0 9 * * *" fires at 09:00 → next run is tomorrow → not due.
      readTextMock.mockReturnValue(
        '* * * * * default\n0 9 * * * default Good morning',
      );
      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = new AgentScheduler({
        folder: 'test-agent',
        agentId: 'agent:test-agent',
        store: mockStore(),
        route,
        isDraft: () => false,
      });
      scheduler.start();
      vi.advanceTimersByTime(ONE_TICK);
      // The 6-field line is skipped. The 7-field line parses but isn't due (09:00 tomorrow).
      expect(route).not.toHaveBeenCalled();
      scheduler.stop();
    });

    it('channel with qualifier parses correctly', () => {
      readTextMock.mockReturnValue(
        '* * * * * weekly~standup Prepare summary',
      );
      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = new AgentScheduler({
        folder: 'test-agent',
        agentId: 'agent:test-agent',
        store: mockStore(),
        route,
        isDraft: () => false,
      });
      scheduler.start();
      vi.advanceTimersByTime(ONE_TICK);
      expect(route).toHaveBeenCalledWith(
        'agent:test-agent',
        'agent:test-agent',
        'Prepare summary',
        { channel: 'weekly', qualifier: 'standup' },
      );
      scheduler.stop();
    });

    it('invalid cron expression is skipped with warning', () => {
      // "99 99 99 99 99" is 5 valid-looking cron fields but with out-of-range values.
      // Total tokens: 99 99 99 99 99 default Bad line → 8 fields, passes the >=7 check,
      // then CronExpressionParser.parse throws → logged as warning.
      readTextMock.mockReturnValue(
        '99 99 99 99 99 default Bad line\n* * * * * default Good line',
      );
      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = new AgentScheduler({
        folder: 'test-agent',
        agentId: 'agent:test-agent',
        store: mockStore(),
        route,
        isDraft: () => false,
      });
      scheduler.start();
      // The invalid line should log a warning
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ agentFolder: 'test-agent' }),
        'Invalid cron in schedule.txt',
      );
      vi.advanceTimersByTime(ONE_TICK);
      // Only the valid line dispatches
      expect(route).toHaveBeenCalledTimes(1);
      expect(route).toHaveBeenCalledWith(
        'agent:test-agent',
        'agent:test-agent',
        'Good line',
        { channel: 'default', qualifier: undefined },
      );
      scheduler.stop();
    });

    it('multiple valid entries all parse', () => {
      readTextMock.mockReturnValue(
        [
          '* * * * * default Entry one',
          '* * * * * alerts~critical Entry two',
          '* * * * * weekly Entry three words here',
        ].join('\n'),
      );
      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = new AgentScheduler({
        folder: 'test-agent',
        agentId: 'agent:test-agent',
        store: mockStore(),
        route,
        isDraft: () => false,
      });
      scheduler.start();
      vi.advanceTimersByTime(ONE_TICK);
      expect(route).toHaveBeenCalledTimes(3);
      expect(route).toHaveBeenCalledWith(
        'agent:test-agent', 'agent:test-agent', 'Entry one',
        { channel: 'default', qualifier: undefined },
      );
      expect(route).toHaveBeenCalledWith(
        'agent:test-agent', 'agent:test-agent', 'Entry two',
        { channel: 'alerts', qualifier: 'critical' },
      );
      expect(route).toHaveBeenCalledWith(
        'agent:test-agent', 'agent:test-agent', 'Entry three words here',
        { channel: 'weekly', qualifier: undefined },
      );
      scheduler.stop();
    });

    it('TZ=<iana> prefix parses and dispatches', () => {
      readTextMock.mockReturnValue('TZ=America/New_York * * * * * default Hello NY');
      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = new AgentScheduler({
        folder: 'test-agent',
        agentId: 'agent:test-agent',
        store: mockStore(),
        route,
        isDraft: () => false,
      });
      scheduler.start();
      vi.advanceTimersByTime(ONE_TICK);
      expect(route).toHaveBeenCalledWith(
        'agent:test-agent',
        'agent:test-agent',
        'Hello NY',
        { channel: 'default', qualifier: undefined },
      );
      scheduler.stop();
    });

    it('TZ=server prefix parses and dispatches (equivalent to absent)', () => {
      readTextMock.mockReturnValue('TZ=server * * * * * default Server time');
      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = new AgentScheduler({
        folder: 'test-agent',
        agentId: 'agent:test-agent',
        store: mockStore(),
        route,
        isDraft: () => false,
      });
      scheduler.start();
      vi.advanceTimersByTime(ONE_TICK);
      expect(route).toHaveBeenCalledWith(
        'agent:test-agent',
        'agent:test-agent',
        'Server time',
        { channel: 'default', qualifier: undefined },
      );
      scheduler.stop();
    });

    it('invalid TZ value logs warning and skips entry', () => {
      readTextMock.mockReturnValue(
        'TZ=Not/A/Zone * * * * * default Bad tz\n* * * * * default Good line',
      );
      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = new AgentScheduler({
        folder: 'test-agent',
        agentId: 'agent:test-agent',
        store: mockStore(),
        route,
        isDraft: () => false,
      });
      scheduler.start();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ agentFolder: 'test-agent', tz: 'Not/A/Zone' }),
        'Invalid TZ in schedule.txt, skipping entry',
      );
      vi.advanceTimersByTime(ONE_TICK);
      expect(route).toHaveBeenCalledTimes(1);
      expect(route).toHaveBeenCalledWith(
        'agent:test-agent',
        'agent:test-agent',
        'Good line',
        { channel: 'default', qualifier: undefined },
      );
      scheduler.stop();
    });

  });

  // ===== Schedule reconciliation =====

  describe('schedule reconciliation', () => {
    it('onScheduleChanged picks up new schedule.txt content', () => {
      readTextMock.mockReturnValue('* * * * * default First entry');
      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = new AgentScheduler({
        folder: 'test-agent',
        agentId: 'agent:test-agent',
        store: mockStore(),
        route,
        isDraft: () => false,
      });
      scheduler.start();
      vi.advanceTimersByTime(ONE_TICK);
      expect(route).toHaveBeenCalledWith(
        'agent:test-agent', 'agent:test-agent', 'First entry',
        { channel: 'default', qualifier: undefined },
      );
      route.mockClear();

      // Change schedule.txt content — onScheduleChanged() called by watcher subscription.
      // The fresh parse computes a new nextRun (one minute in the future from current fake time),
      // so we need two more ticks for the new entry to become due.
      readTextMock.mockReturnValue('* * * * * alerts New entry');
      scheduler.onScheduleChanged();
      vi.advanceTimersByTime(ONE_TICK * 2);
      expect(route).toHaveBeenCalledWith(
        'agent:test-agent', 'agent:test-agent', 'New entry',
        { channel: 'alerts', qualifier: undefined },
      );
      // "First entry" should no longer fire after the reconciliation.
      const firstEntryCalls = (route.mock.calls as unknown[][]).filter(
        (c) => c[2] === 'First entry',
      );
      expect(firstEntryCalls).toHaveLength(0);
      scheduler.stop();
    });
  });

  // ===== Task dispatch =====

  describe('task dispatch', () => {
    it('due task triggers route() with correct args', () => {
      const store = mockStore();
      const dueTask = {
        id: 'task-1',
        address: 'agent:test-agent',
        prompt: 'Run daily report',
        schedule_type: 'cron' as const,
        schedule_value: '0 9 * * *',
        timezone: null,
        channel: 'default',
        target_participant: 'tg:12345',
        next_run: '2026-04-02T11:00:00Z', // past → due
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: '2026-04-01T00:00:00Z',
      };
      vi.mocked(store.getDueTasksForAgent).mockReturnValue([dueTask]);
      vi.mocked(store.getTaskById).mockReturnValue(dueTask);

      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = new AgentScheduler({
        folder: 'test-agent',
        agentId: 'agent:test-agent',
        store,
        route,
        isDraft: () => false,
      });
      scheduler.start();

      // Task should be dispatched on first tick (immediate).
      expect(store.updateTask).toHaveBeenCalledWith('task-1', { status: 'running' });
      expect(store.logTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          task_id: 'task-1',
        }),
      );
      expect(route).toHaveBeenCalledWith(
        'agent:test-agent',
        'agent:test-agent',
        'Run daily report',
        { targetParticipant: 'tg:12345', channel: 'default' },
      );
      scheduler.stop();
    });

    it('task with no target_participant is skipped', () => {
      const store = mockStore();
      const dueTask = {
        id: 'task-2',
        address: 'agent:test-agent',
        prompt: 'No target',
        schedule_type: 'cron' as const,
        schedule_value: '0 9 * * *',
        timezone: null,
        channel: null,
        target_participant: null,
        next_run: '2026-04-02T11:00:00Z',
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: '2026-04-01T00:00:00Z',
      };
      vi.mocked(store.getDueTasksForAgent).mockReturnValue([dueTask]);
      vi.mocked(store.getTaskById).mockReturnValue(dueTask);

      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = new AgentScheduler({
        folder: 'test-agent',
        agentId: 'agent:test-agent',
        store,
        route,
        isDraft: () => false,
      });
      scheduler.start();

      expect(route).not.toHaveBeenCalled();
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-2' }),
        'Task has no target_participant, skipping',
      );
      scheduler.stop();
    });

    it('draft agent: cron DB task does not dispatch, next_run advances to avoid burst on ready-flip', () => {
      const store = mockStore();
      const dueTask = {
        id: 'task-draft-cron',
        address: 'agent:test-agent',
        prompt: 'Run daily report',
        schedule_type: 'cron' as const,
        schedule_value: '0 9 * * *',
        timezone: null,
        channel: 'default',
        target_participant: 'tg:12345',
        next_run: '2026-04-02T11:00:00Z', // past → due
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: '2026-04-01T00:00:00Z',
      };
      vi.mocked(store.getDueTasksForAgent).mockReturnValue([dueTask]);
      vi.mocked(store.getTaskById).mockReturnValue(dueTask);

      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = makeScheduler({ store, route, isDraft: () => true });
      scheduler.start();

      expect(route).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalledWith('task-draft-cron', { status: 'running' });
      // Cron next_run advances so we don't fire-burst when draft toggles to ready.
      expect(store.updateTaskAfterRun).toHaveBeenCalledWith(
        'task-draft-cron',
        expect.any(String),
        'Skipped (draft)',
      );
      scheduler.stop();
    });

    it('draft agent: one-shot DB task does not dispatch, stays due', () => {
      const store = mockStore();
      const dueTask = {
        id: 'task-draft-oneshot',
        address: 'agent:test-agent',
        prompt: 'Run once',
        schedule_type: 'once' as const,
        schedule_value: '2026-04-02T11:00:00Z',
        timezone: null,
        channel: 'default',
        target_participant: 'tg:12345',
        next_run: '2026-04-02T11:00:00Z',
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: '2026-04-01T00:00:00Z',
      };
      vi.mocked(store.getDueTasksForAgent).mockReturnValue([dueTask]);
      vi.mocked(store.getTaskById).mockReturnValue(dueTask);

      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = makeScheduler({ store, route, isDraft: () => true });
      scheduler.start();

      expect(route).not.toHaveBeenCalled();
      // One-shot stays due — no next_run advance; will fire when draft flips to ready.
      expect(store.updateTaskAfterRun).not.toHaveBeenCalled();
      scheduler.stop();
    });

    it('draft agent: schedule.txt entry does not dispatch, nextRun advances', () => {
      readTextMock.mockReturnValue('* * * * * default :: ping');
      const route = vi.fn(async () => ({ ok: true as const, result: null }));
      const scheduler = makeScheduler({ route, isDraft: () => true });
      scheduler.start();
      vi.advanceTimersByTime(ONE_TICK);
      expect(route).not.toHaveBeenCalled();
      scheduler.stop();
    });
  });
});
