import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import { installTokenUsageSchema, TokenUsageStore } from './token-usage-store.js';

describe('TokenUsageStore', () => {
  let db: Database.Database;
  let store: TokenUsageStore;

  beforeEach(() => {
    db = new Database(':memory:');
    installTokenUsageSchema(db);
    store = new TokenUsageStore(db);
  });

  it('install is idempotent', () => {
    installTokenUsageSchema(db);
    installTokenUsageSchema(db);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'token_usage'").get();
    expect(row).toBeDefined();
  });

  it('UPSERT accumulates token + cost counters on the same key', () => {
    const ts = new Date('2026-05-23T10:00:00Z');
    const baseInput = {
      conversationId: 'conv-1',
      channel: 'default',
      phase: 'main' as const,
      model: 'claude-opus-4-7',
      ts,
    };

    store.record({
      ...baseInput,
      usage: { input: 100, output: 50, cacheCreation: 10, cacheRead: 200 },
      costUsd: 0.025,
    });
    store.record({
      ...baseInput,
      ts: new Date('2026-05-23T11:00:00Z'),
      usage: { input: 200, output: 75, cacheCreation: 0, cacheRead: 400 },
      costUsd: 0.04,
    });

    const rows = store.byConversation();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.input_tokens).toBe(300);
    expect(r.output_tokens).toBe(125);
    expect(r.cache_creation_input_tokens).toBe(10);
    expect(r.cache_read_input_tokens).toBe(600);
    expect(r.cost_usd).toBeCloseTo(0.065, 6);
    expect(r.result_count).toBe(2);
  });

  it('separate keys produce separate rows', () => {
    const ts = new Date('2026-05-23T10:00:00Z');
    const usage = { input: 100, output: 50, cacheCreation: 0, cacheRead: 0 };

    store.record({ conversationId: 'c1', channel: 'default', phase: 'main',      model: 'opus',   usage, costUsd: 0.01, ts });
    store.record({ conversationId: 'c1', channel: 'default', phase: 'bootstrap', model: 'opus',   usage, costUsd: 0.02, ts });
    store.record({ conversationId: 'c1', channel: 'default', phase: 'main',      model: 'sonnet', usage, costUsd: 0.03, ts });
    store.record({ conversationId: 'c2', channel: 'default', phase: 'main',      model: 'opus',   usage, costUsd: 0.04, ts });

    const rows = store.byConversation();
    expect(rows).toHaveLength(4);
  });

  it('summary returns SUMs across all rows', () => {
    const ts = new Date('2026-05-23T10:00:00Z');
    store.record({
      conversationId: 'c1', channel: 'default', phase: 'main', model: 'opus',
      usage: { input: 100, output: 50, cacheCreation: 5, cacheRead: 200 },
      costUsd: 0.025, ts,
    });
    store.record({
      conversationId: 'c2', channel: 'default', phase: 'main', model: 'opus',
      usage: { input: 300, output: 150, cacheCreation: 15, cacheRead: 600 },
      costUsd: 0.075, ts,
    });

    const s = store.summary();
    expect(s.totals.input_tokens).toBe(400);
    expect(s.totals.output_tokens).toBe(200);
    expect(s.totals.cache_creation_input_tokens).toBe(20);
    expect(s.totals.cache_read_input_tokens).toBe(800);
    expect(s.totals.cost_usd).toBeCloseTo(0.1, 6);
    expect(s.totals.result_count).toBe(2);
  });

  it('summary on empty DB returns zeros, null dates', () => {
    const s = store.summary();
    expect(s.totals.input_tokens).toBe(0);
    expect(s.totals.cost_usd).toBe(0);
    expect(s.totals.result_count).toBe(0);
    expect(s.firstDate).toBeNull();
    expect(s.lastDate).toBeNull();
  });

  it('byDay groups across conversations on the same date', () => {
    const ts = new Date('2026-05-23T10:00:00Z');
    const usage = { input: 100, output: 50, cacheCreation: 0, cacheRead: 0 };
    store.record({ conversationId: 'c1', channel: 'd', phase: 'main', model: 'opus', usage, costUsd: 0.01, ts });
    store.record({ conversationId: 'c2', channel: 'd', phase: 'main', model: 'opus', usage, costUsd: 0.02, ts });

    const days = store.byDay();
    expect(days).toHaveLength(1);
    expect(days[0]!.input_tokens).toBe(200);
    expect(days[0]!.cost_usd).toBeCloseTo(0.03, 6);
    expect(days[0]!.result_count).toBe(2);
  });
});
