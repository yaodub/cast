import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AgentStateStore } from './agent/state-store.js';
import type { ScheduledTask, TaskRunLog } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function stateDir(): string {
  return path.join(tmpDir, 'state');
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    address: 'test-agent',
    prompt: 'test prompt',
    schedule_type: 'once',
    schedule_value: new Date(Date.now() + 60000).toISOString(),
    timezone: null,
    channel: 'default',
    target_participant: 'tg:12345',
    next_run: new Date(Date.now() - 1000).toISOString(), // due
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-store-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =========================================================================
// Conversations
// =========================================================================

describe('AgentStateStore — conversations', () => {
  it('1: constructor creates state dir and empty JSONL', () => {
    const dir = stateDir();
    expect(fs.existsSync(dir)).toBe(false);

    new AgentStateStore(dir);

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'conversations.jsonl'))).toBe(true);
  });

  it('2: upsertConversation + getActiveConversation roundtrip', () => {
    const store = new AgentStateStore(stateDir());
    const conv = store.upsertConversation('key-1', {
      channelName: 'default',
      participant: 'tg:12345',
      qualifier: null,
      ccSessionId: 'sess-1',
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      ttl: null,
      status: 'active',
      summary: null,
    });

    const fetched = store.getActiveConversation('key-1');
    expect(fetched).toBeDefined();
    expect(fetched!.conversationKey).toBe('key-1');
    expect(fetched!.channelName).toBe('default');
    expect(fetched!.ccSessionId).toBe('sess-1');
    expect(fetched!.status).toBe('active');
  });

  it('3: touchConversation updates lastActive', () => {
    const store = new AgentStateStore(stateDir());
    const early = '2024-01-01T00:00:00.000Z';
    store.upsertConversation('key-1', {
      channelName: 'default',
      participant: 'tg:12345',
      qualifier: null,
      ccSessionId: 'sess-1',
      createdAt: early,
      lastActive: early,
      ttl: null,
      status: 'active',
      summary: null,
    });

    store.touchConversation('key-1');

    const conv = store.getActiveConversation('key-1');
    expect(conv).toBeDefined();
    expect(conv!.lastActive).not.toBe(early);
    expect(new Date(conv!.lastActive).getTime()).toBeGreaterThan(new Date(early).getTime());
  });

  it('4: expireConversation sets status to expired, getActive returns undefined', () => {
    const store = new AgentStateStore(stateDir());
    store.upsertConversation('key-1', {
      channelName: 'default',
      participant: 'tg:12345',
      qualifier: null,
      ccSessionId: 'sess-1',
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      ttl: null,
      status: 'active',
      summary: null,
    });

    store.expireConversation('key-1');

    expect(store.getActiveConversation('key-1')).toBeUndefined();
  });

  it('5: updateSummary stores summary and adds to completedSessions', () => {
    const store = new AgentStateStore(stateDir());
    store.upsertConversation('key-1', {
      channelName: 'default',
      participant: 'tg:12345',
      qualifier: null,
      ccSessionId: 'sess-1',
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      ttl: null,
      status: 'active',
      summary: null,
    });

    store.updateSummary('key-1', 'We discussed the weather.');

    const conv = store.getActiveConversation('key-1');
    expect(conv).toBeDefined();
    expect(conv!.summary).toBe('We discussed the weather.');

    // completedSessions should now include this entry
    const sessions = store.getPreviousSessions('default', 'tg:12345');
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions[0]!.summary).toBe('We discussed the weather.');
  });

  it('6: getPreviousSessions returns up to 3, stops after first with summary', () => {
    const store = new AgentStateStore(stateDir());

    // completedSessions only gains entries via updateSummary, so every entry has
    // a non-null summary. The method stops after the first entry with a summary,
    // which means it always returns exactly 1.  We verify that it:
    //   (a) returns the most recent by lastActive
    //   (b) caps at 3 via .slice(0, 3) (tested via count)
    //   (c) stops after first with summary
    for (let i = 0; i < 5; i++) {
      const key = `key-${i}`;
      const lastActive = new Date(Date.now() - (4 - i) * 1000).toISOString();
      store.upsertConversation(key, {
        channelName: 'default',
        participant: 'tg:12345',
        qualifier: null,
        ccSessionId: `sess-${i}`,
        createdAt: lastActive,
        lastActive,
        ttl: null,
        status: 'active',
        summary: null,
      });
      store.updateSummary(key, `Session ${i} summary`);
    }

    const sessions = store.getPreviousSessions('default', 'tg:12345');
    // Most recent (sess-4) has a summary → returns 1 entry then stops
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.summary).toBe('Session 4 summary');

    // Verify channel/participant filtering: different participant → empty
    const none = store.getPreviousSessions('default', 'tg:99999');
    expect(none).toHaveLength(0);
  });

  it('7: getConversationsWithSummaries filters by channel and age', () => {
    const store = new AgentStateStore(stateDir());

    // Recent session in 'default' channel
    store.upsertConversation('key-1', {
      channelName: 'default',
      participant: 'tg:12345',
      qualifier: null,
      ccSessionId: 'sess-1',
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      ttl: null,
      status: 'active',
      summary: null,
    });
    store.updateSummary('key-1', 'Recent default');

    // Old session in 'default' channel
    store.upsertConversation('key-2', {
      channelName: 'default',
      participant: 'tg:12345',
      qualifier: null,
      ccSessionId: 'sess-2',
      createdAt: '2020-01-01T00:00:00.000Z',
      lastActive: '2020-01-01T00:00:00.000Z',
      ttl: null,
      status: 'active',
      summary: null,
    });
    store.updateSummary('key-2', 'Old default');

    // Recent session in 'scratch' channel
    store.upsertConversation('key-3', {
      channelName: 'scratch',
      participant: 'tg:12345',
      qualifier: null,
      ccSessionId: 'sess-3',
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      ttl: null,
      status: 'active',
      summary: null,
    });
    store.updateSummary('key-3', 'Recent scratch');

    // Filter by 'default' channel, max 1 day
    const results = store.getConversationsWithSummaries(['default'], 24 * 60 * 60 * 1000);
    expect(results.length).toBe(1);
    expect(results[0]!.summary).toBe('Recent default');

    // No channel filter, wide age window
    const all = store.getConversationsWithSummaries(undefined, 100 * 365 * 24 * 60 * 60 * 1000);
    expect(all.length).toBe(3);
  });

  it('8: JSONL persistence — create store, upsert, create new store from same dir → state restored', () => {
    const dir = stateDir();
    const store1 = new AgentStateStore(dir);
    store1.upsertConversation('key-1', {
      channelName: 'default',
      participant: 'tg:12345',
      qualifier: null,
      ccSessionId: 'sess-1',
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      ttl: null,
      status: 'active',
      summary: null,
    });

    // Create a new store from the same dir — should reload the conversation
    const store2 = new AgentStateStore(dir);
    const conv = store2.getActiveConversation('key-1');
    expect(conv).toBeDefined();
    expect(conv!.ccSessionId).toBe('sess-1');
  });

  it('9: corrupt JSONL lines — constructor skips them gracefully', () => {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });

    // Write a JSONL file with a valid line and a corrupt line
    const validConv = {
      conversationKey: 'key-valid',
      channelName: 'default',
      participant: 'tg:12345',
      qualifier: null,
      ccSessionId: 'sess-valid',
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      ttl: null,
      status: 'active',
      summary: null,
    };
    const content = [
      JSON.stringify(validConv),
      'NOT VALID JSON {{{',
      '{"conversationKey": "key-bad", "missing": "fields"}',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'conversations.jsonl'), content);

    const store = new AgentStateStore(dir);

    // The valid conversation should be loaded
    expect(store.getActiveConversation('key-valid')).toBeDefined();
    // The corrupt lines should be skipped
    expect(store.getActiveConversation('key-bad')).toBeUndefined();
  });

  it('10: flush() compaction — write many entries, flush, re-read → same state, fewer lines', () => {
    const dir = stateDir();
    const store = new AgentStateStore(dir);

    // Upsert the same key multiple times — each appends a JSONL line
    for (let i = 0; i < 10; i++) {
      store.upsertConversation('key-1', {
        channelName: 'default',
        participant: 'tg:12345',
        qualifier: null,
        ccSessionId: 'sess-1',
        createdAt: new Date().toISOString(),
        lastActive: new Date(Date.now() + i * 1000).toISOString(),
        ttl: null,
        status: 'active',
        summary: null,
      });
    }

    // Count lines before flush (constructor already flushed once, but we appended 10 more)
    const beforeContent = fs.readFileSync(path.join(dir, 'conversations.jsonl'), 'utf-8');
    const linesBefore = beforeContent.split('\n').filter((l) => l.trim()).length;
    expect(linesBefore).toBeGreaterThan(1); // At least the initial flush + appends

    store.flush();

    const afterContent = fs.readFileSync(path.join(dir, 'conversations.jsonl'), 'utf-8');
    const linesAfter = afterContent.split('\n').filter((l) => l.trim()).length;

    // Compacted file should have fewer lines (just 1 current-state entry for key-1)
    expect(linesAfter).toBeLessThan(linesBefore);

    // Re-read from disk — state should be identical
    const store2 = new AgentStateStore(dir);
    const conv = store2.getActiveConversation('key-1');
    expect(conv).toBeDefined();
    expect(conv!.ccSessionId).toBe('sess-1');
  });
});

// =========================================================================
// Tasks
// =========================================================================

describe('AgentStateStore — tasks', () => {
  it('11: createTask + getTaskById roundtrip', () => {
    const store = new AgentStateStore(stateDir());
    const task = makeTask({ id: 'task-roundtrip' });
    store.createTask(task);

    const fetched = store.getTaskById('task-roundtrip');
    expect(fetched).toBeDefined();
    expect(fetched!.prompt).toBe('test prompt');
    expect(fetched!.status).toBe('active');
  });

  it('12: updateTask partial updates', () => {
    const store = new AgentStateStore(stateDir());
    const task = makeTask({ id: 'task-update' });
    store.createTask(task);

    store.updateTask('task-update', { prompt: 'updated prompt', status: 'paused' });

    const fetched = store.getTaskById('task-update');
    expect(fetched).toBeDefined();
    expect(fetched!.prompt).toBe('updated prompt');
    expect(fetched!.status).toBe('paused');
    // Unchanged fields remain intact
    expect(fetched!.address).toBe('test-agent');
  });

  it('13: deleteTask removes task and its run logs', () => {
    const store = new AgentStateStore(stateDir());
    const task = makeTask({ id: 'task-delete' });
    store.createTask(task);

    store.logTaskRun({
      task_id: 'task-delete',
      run_at: new Date().toISOString(),
    });

    store.deleteTask('task-delete');

    expect(store.getTaskById('task-delete')).toBeUndefined();
    // Run logs for this task should also be gone
    const runs = store.getRecentTaskRuns(null, 100);
    expect(runs.filter((r) => r.task_id === 'task-delete')).toHaveLength(0);
  });

  it('14: getDueTasksForAgent filters by address, status=active, next_run <= now', () => {
    const store = new AgentStateStore(stateDir());

    // Due task for our agent
    store.createTask(makeTask({
      id: 'due',
      address: 'agent-a',
      status: 'active',
      next_run: new Date(Date.now() - 5000).toISOString(),
    }));

    // Future task for our agent — not due
    store.createTask(makeTask({
      id: 'future',
      address: 'agent-a',
      status: 'active',
      next_run: new Date(Date.now() + 600000).toISOString(),
    }));

    // Due task for different agent
    store.createTask(makeTask({
      id: 'other-agent',
      address: 'agent-b',
      status: 'active',
      next_run: new Date(Date.now() - 5000).toISOString(),
    }));

    // Due task but paused
    store.createTask(makeTask({
      id: 'paused',
      address: 'agent-a',
      status: 'paused',
      next_run: new Date(Date.now() - 5000).toISOString(),
    }));

    const due = store.getDueTasksForAgent('agent-a');
    expect(due).toHaveLength(1);
    expect(due[0]!.id).toBe('due');
  });

  it('15: recoverStuckTasks transitions running → active', () => {
    const store = new AgentStateStore(stateDir());

    store.createTask(makeTask({ id: 'stuck', address: 'agent-a', status: 'running' }));
    store.createTask(makeTask({ id: 'ok', address: 'agent-a', status: 'active' }));
    store.createTask(makeTask({ id: 'other', address: 'agent-b', status: 'running' }));

    const recovered = store.recoverStuckTasks('agent-a');
    expect(recovered).toBe(1);
    expect(store.getTaskById('stuck')!.status).toBe('active');
    expect(store.getTaskById('ok')!.status).toBe('active');
    // Different agent's task unchanged
    expect(store.getTaskById('other')!.status).toBe('running');
  });

  it('16: logTaskRun appends to run logs, capped at 100', () => {
    const store = new AgentStateStore(stateDir());
    const task = makeTask({ id: 'task-logs' });
    store.createTask(task);

    // Add 105 run logs with strictly increasing run_at timestamps.
    const t0 = Date.now();
    for (let i = 0; i < 105; i++) {
      store.logTaskRun({
        task_id: 'task-logs',
        run_at: new Date(t0 + i * 1000).toISOString(),
      });
    }

    const runs = store.getRecentTaskRuns(null, 200);
    expect(runs.length).toBe(100);
    // Sorted newest-first; should match the last appended timestamp.
    expect(runs[0]!.run_at).toBe(new Date(t0 + 104 * 1000).toISOString());
  });

  it('17: task persistence — create store, add tasks, create new store from same dir → tasks restored', () => {
    const dir = stateDir();
    const store1 = new AgentStateStore(dir);
    store1.createTask(makeTask({ id: 'persist-1', prompt: 'alpha' }));
    store1.createTask(makeTask({ id: 'persist-2', prompt: 'beta' }));

    store1.logTaskRun({
      task_id: 'persist-1',
      run_at: new Date().toISOString(),
    });

    // New store from same dir — should reload everything
    const store2 = new AgentStateStore(dir);
    expect(store2.getTaskById('persist-1')).toBeDefined();
    expect(store2.getTaskById('persist-1')!.prompt).toBe('alpha');
    expect(store2.getTaskById('persist-2')).toBeDefined();

    const runs = store2.getRecentTaskRuns(null, 10);
    expect(runs.length).toBe(1);
    expect(runs[0]!.task_id).toBe('persist-1');
  });
});
