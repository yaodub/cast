import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentDb } from './agent/agent-db.js';

describe('AgentDb event log', () => {
  let tmpDir: string;
  let db: AgentDb;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-agent-db-events-'));
    db = new AgentDb(path.join(tmpDir, 'agent.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a basic error event', () => {
    db.logEvent('error', 'container', 'spawn_failed', 'Container spawn syscall failed');
    const events = db.readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'error',
      component: 'container',
      event_name: 'spawn_failed',
      message: 'Container spawn syscall failed',
      conversation_key: null,
      context: null,
    });
    expect(events[0].id).toBeGreaterThan(0);
    expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves conversation_key and context across round-trip', () => {
    db.logEvent('warn', 'conversation', 'attachment_too_large', 'Outbox file too large', {
      conversationKey: 'tg|tg:12345|q1',
      context: { file: 'large.bin', size: 99_999, limit: 50_000 },
    });
    const [evt] = db.readEvents();
    expect(evt.conversation_key).toBe('tg|tg:12345|q1');
    expect(evt.context).toEqual({ file: 'large.bin', size: 99_999, limit: 50_000 });
  });

  it('returns events newest-first', () => {
    db.logEvent('info', 'conversation', 'started', 'first');
    db.logEvent('info', 'conversation', 'started', 'second');
    db.logEvent('info', 'conversation', 'started', 'third');
    const events = db.readEvents();
    expect(events.map((e) => e.message)).toEqual(['third', 'second', 'first']);
  });

  it('filters by level', () => {
    db.logEvent('error', 'container', 'spawn_failed', 'e1');
    db.logEvent('warn', 'service', 'manifest_missing', 'w1');
    db.logEvent('info', 'scheduler', 'fired', 'i1');
    expect(db.readEvents({ level: 'error' })).toHaveLength(1);
    expect(db.readEvents({ level: 'warn' })).toHaveLength(1);
    expect(db.readEvents({ level: 'info' })).toHaveLength(1);
  });

  it('filters by component', () => {
    db.logEvent('error', 'container', 'a', 'a');
    db.logEvent('error', 'service', 'b', 'b');
    db.logEvent('error', 'container', 'c', 'c');
    expect(db.readEvents({ component: 'container' })).toHaveLength(2);
    expect(db.readEvents({ component: 'service' })).toHaveLength(1);
  });

  it('filters by since timestamp', () => {
    db.logEvent('info', 'conversation', 'started', 'old');
    const cutoff = new Date().toISOString();
    // Force a small gap so the next event is strictly after `cutoff`.
    const wait = Date.now() + 10;
    while (Date.now() < wait) { /* spin */ }
    db.logEvent('info', 'conversation', 'started', 'new');
    const filtered = db.readEvents({ since: cutoff });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].message).toBe('new');
  });

  it('filters by conversationKey', () => {
    db.logEvent('info', 'conversation', 'started', 'a', { conversationKey: 'k1' });
    db.logEvent('info', 'conversation', 'started', 'b', { conversationKey: 'k2' });
    db.logEvent('info', 'conversation', 'started', 'c', { conversationKey: 'k1' });
    expect(db.readEvents({ conversationKey: 'k1' })).toHaveLength(2);
    expect(db.readEvents({ conversationKey: 'k2' })).toHaveLength(1);
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) db.logEvent('info', 'conversation', 'started', `m${i}`);
    expect(db.readEvents({ limit: 3 })).toHaveLength(3);
    expect(db.readEvents({ limit: 100 })).toHaveLength(10);
    expect(db.readEvents()).toHaveLength(10);
  });

  it('countEvents matches readEvents under same filters', () => {
    db.logEvent('error', 'container', 'a', 'a');
    db.logEvent('warn', 'container', 'b', 'b');
    db.logEvent('error', 'service', 'c', 'c');
    expect(db.countEvents()).toBe(3);
    expect(db.countEvents({ level: 'error' })).toBe(2);
    expect(db.countEvents({ component: 'container' })).toBe(2);
    expect(db.countEvents({ level: 'error', component: 'container' })).toBe(1);
  });

  it('applies WAL journal mode on file-backed DB', () => {
    const direct = new Database(path.join(tmpDir, 'agent.db'), { readonly: true });
    const row = direct.pragma('journal_mode', { simple: true });
    direct.close();
    expect(row).toBe('wal');
  });
});
