/**
 * Focused tests for the `outbound_pushes` correlation table — used by the
 * push-rejection round-trip path. Tests the CRUD round-trip and (critically)
 * that the TTL purge cutoff format matches what SQLite's
 * `DEFAULT (datetime('now'))` stores in `created_at`.
 *
 * Why the format thing matters: SQLite's `datetime('now')` writes
 * `YYYY-MM-DD HH:MM:SS` (space separator, no `T`/`Z`). A JS `toISOString()`
 * cutoff is `YYYY-MM-DDTHH:MM:SS.sssZ`. Under SQLite's text comparison,
 * `' '` (0x20) < `'T'` (0x54), so every stored row's `created_at` is
 * lexicographically less than any `toISOString()` cutoff regardless of
 * actual time — without this guard the sweep would wipe every row on
 * every tick.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AgentDb } from './agent/agent-db.js';

let tmpDir: string;
let db: AgentDb;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-db-test-'));
  db = new AgentDb(path.join(tmpDir, 'agent.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('outbound_pushes CRUD', () => {
  it('records, reads back, and updates status', () => {
    db.recordOutboundPush({
      requestId: 'req-abc',
      targetAgent: 'a:peer@srv',
      targetChannel: 'default',
      channel: 'origin',
      participant: 'u:alice@idp',
      qualifier: 'shard-1',
    });

    const row = db.getOutboundPush('req-abc');
    expect(row).toBeDefined();
    expect(row?.request_id).toBe('req-abc');
    expect(row?.status).toBe('open');
    expect(row?.qualifier).toBe('shard-1');

    db.updateOutboundPushStatus('req-abc', 'rejected');
    expect(db.getOutboundPush('req-abc')?.status).toBe('rejected');
  });

  it('returns undefined for missing rows (sender lookup miss path)', () => {
    expect(db.getOutboundPush('req-nope')).toBeUndefined();
  });

  it('accepts null qualifier when caller cell is un-sharded', () => {
    db.recordOutboundPush({
      requestId: 'req-noqual',
      targetAgent: 'a:peer@srv',
      targetChannel: 'default',
      channel: 'origin',
      participant: 'u:alice@idp',
      // qualifier omitted
    });
    expect(db.getOutboundPush('req-noqual')?.qualifier).toBeNull();
  });
});

describe('outbound_pushes TTL purge', () => {
  it('uses SQLite-text-compatible cutoff format (regression guard)', () => {
    // SQLite default `datetime('now')` stores `YYYY-MM-DD HH:MM:SS`. The
    // purge caller (in `agent-manager.ts`) converts JS `toISOString()` to
    // that shape before comparing. If a caller passes a bare `toISOString()`
    // cutoff, the comparison goes wrong (`' '` < `'T'`), and every row
    // string-compares less than the cutoff regardless of age. This test
    // would expose that regression.
    db.recordOutboundPush({
      requestId: 'req-fresh',
      targetAgent: 'a:peer@srv',
      targetChannel: 'default',
      channel: 'origin',
      participant: 'u:alice@idp',
    });

    // Cutoff from one hour in the past, in SQLite's space-separator format.
    const oneHourAgoSqlite = new Date(Date.now() - 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    const removed = db.purgeExpiredOutboundPushes(oneHourAgoSqlite);
    expect(removed).toBe(0);
    expect(db.getOutboundPush('req-fresh')).toBeDefined();
  });

  it('purges rows older than the cutoff', () => {
    db.recordOutboundPush({
      requestId: 'req-stale',
      targetAgent: 'a:peer@srv',
      targetChannel: 'default',
      channel: 'origin',
      participant: 'u:alice@idp',
    });

    // Cutoff in the far future — anything ever inserted is "older."
    const farFutureSqlite = new Date(Date.now() + 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    const removed = db.purgeExpiredOutboundPushes(farFutureSqlite);
    expect(removed).toBe(1);
    expect(db.getOutboundPush('req-stale')).toBeUndefined();
  });

  it('returns 0 when there is nothing to purge', () => {
    const cutoff = new Date(Date.now() + 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    expect(db.purgeExpiredOutboundPushes(cutoff)).toBe(0);
  });
});

describe('listRequests status filter — the outbox model', () => {
  const CTX = { channel: 'default', participant: 'u:abc@srv' };

  function seed(): void {
    // Outbound: one open, one fulfilled, one rejected
    db.recordOutboundRequest({ requestId: 'out-open', targetAgent: 'a:p@s', targetChannel: 'work', ...CTX, kind: 'query' });
    db.recordOutboundRequest({ requestId: 'out-done', targetAgent: 'a:p@s', targetChannel: 'work', ...CTX, kind: 'query' });
    db.updateRequestStatus('outbound', 'out-done', 'fulfilled');
    db.recordOutboundRequest({ requestId: 'out-bounced', targetAgent: 'a:p@s', targetChannel: 'work', ...CTX, kind: 'request' });
    db.updateRequestStatus('outbound', 'out-bounced', 'rejected');
    // Inbound: one open, one closed
    db.recordInboundRequest({ requestId: 'in-open', fromAgent: 'a:q@s', returnToAgent: 'a:q@s', returnToChannel: 'default', returnToParticipant: 'u:abc@srv', ...CTX, upstreamSet: '[]', queryText: 'hi' });
    db.recordInboundRequest({ requestId: 'in-closed', fromAgent: 'a:q@s', returnToAgent: 'a:q@s', returnToChannel: 'default', returnToParticipant: 'u:abc@srv', ...CTX, upstreamSet: '[]', queryText: 'hi' });
    db.updateRequestStatus('inbound', 'in-closed', 'closed');
  }

  it('defaults to open only — the working set', () => {
    seed();
    const { inbound, outbound } = db.listRequests(CTX.channel, CTX.participant);
    expect(outbound.map((r) => r.request_id)).toEqual(['out-open']);
    expect(inbound.map((r) => r.request_id)).toEqual(['in-open']);
  });

  it('returns full history with "all" — rows are never deleted', () => {
    seed();
    const { inbound, outbound } = db.listRequests(CTX.channel, CTX.participant, 'all');
    expect(outbound).toHaveLength(3);
    expect(inbound).toHaveLength(2);
  });

  it('filters by a terminal status — the bounce-audit view', () => {
    seed();
    const { inbound, outbound } = db.listRequests(CTX.channel, CTX.participant, 'rejected');
    expect(outbound.map((r) => r.request_id)).toEqual(['out-bounced']);
    expect(inbound).toHaveLength(0);
  });

  it('scopes to the (channel, participant) context regardless of filter', () => {
    seed();
    db.recordOutboundRequest({ requestId: 'other-ctx', targetAgent: 'a:p@s', targetChannel: 'work', channel: 'other', participant: 'u:zzz@srv', kind: 'query' });
    const { outbound } = db.listRequests(CTX.channel, CTX.participant, 'all');
    expect(outbound.map((r) => r.request_id)).not.toContain('other-ctx');
  });
});
