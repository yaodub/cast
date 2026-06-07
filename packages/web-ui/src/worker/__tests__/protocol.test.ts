/**
 * Protocol — Zod boundary validation. The worker validates every wire frame
 * from `/api/admin/events` at the boundary (validate at edges, trust
 * internally). These tests pin the AdminWireFrame shape so a server-side
 * change either updates this schema in lockstep or surfaces here as a
 * parse failure.
 */
import { describe, expect, it } from 'vitest';

import { AdminWireFrame, WorkerToTab, scopeKey } from '../protocol';

describe('AdminWireFrame parsing', () => {
  it('accepts an agent envelope with a packet payload', () => {
    const frame = {
      type: 'envelope',
      target: { kind: 'agent', alias: 'a', channel: '__design' },
      event: 'packet',
      data: {
        id: 'pkt-1',
        type: 'conversation',
        from: 'agent:a',
        to: 'local/admin:local',
        text: 'hi',
        timestamp: '2026-05-15T00:00:00.000Z',
      },
    };
    const result = AdminWireFrame.safeParse(frame);
    expect(result.success).toBe(true);
  });

  it('accepts a manager envelope', () => {
    const frame = {
      type: 'envelope',
      target: { kind: 'manager', slug: 'design-manager' },
      event: 'typing',
      data: {},
    };
    const result = AdminWireFrame.safeParse(frame);
    expect(result.success).toBe(true);
  });

  it('rejects a manager envelope with an unknown slug', () => {
    const frame = {
      type: 'envelope',
      target: { kind: 'manager', slug: 'unknown-manager' },
      event: 'typing',
      data: {},
    };
    const result = AdminWireFrame.safeParse(frame);
    expect(result.success).toBe(false);
  });

  it('rejects an agent envelope with an unknown channel', () => {
    const frame = {
      type: 'envelope',
      target: { kind: 'agent', alias: 'a', channel: 'main' },
      event: 'packet',
      data: {},
    };
    const result = AdminWireFrame.safeParse(frame);
    expect(result.success).toBe(false);
  });

  it('accepts a lifecycle agent_added with alias + address', () => {
    const frame = {
      type: 'envelope',
      target: { kind: 'lifecycle' },
      event: 'agent_added',
      data: { alias: 'a', address: 'agent:a' },
    };
    const result = AdminWireFrame.safeParse(frame);
    expect(result.success).toBe(true);
  });

  it('accepts a lifecycle agent_removed without alias (alias optional)', () => {
    const frame = {
      type: 'envelope',
      target: { kind: 'lifecycle' },
      event: 'agent_removed',
      data: { address: 'agent:a' },
    };
    const result = AdminWireFrame.safeParse(frame);
    expect(result.success).toBe(true);
  });

  it('rejects a lifecycle event other than agent_added/removed', () => {
    const frame = {
      type: 'envelope',
      target: { kind: 'lifecycle' },
      event: 'random',
      data: { address: 'agent:a' },
    };
    const result = AdminWireFrame.safeParse(frame);
    expect(result.success).toBe(false);
  });

  it('accepts a ready frame with agents + managers', () => {
    const frame = {
      type: 'ready',
      agents: [{ alias: 'a', address: 'agent:a' }],
      managers: ['design-manager', 'config-manager', 'security-manager'],
    };
    const result = AdminWireFrame.safeParse(frame);
    expect(result.success).toBe(true);
  });

  it('accepts a shutdown frame with reason', () => {
    const frame = { type: 'shutdown', reason: 'restart' };
    const result = AdminWireFrame.safeParse(frame);
    expect(result.success).toBe(true);
  });

  it('rejects a shutdown frame missing reason', () => {
    const frame = { type: 'shutdown' };
    const result = AdminWireFrame.safeParse(frame);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level type', () => {
    const frame = { type: 'gibberish' };
    const result = AdminWireFrame.safeParse(frame);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkerToTab — every variant parses. Catches duplicate-discriminator errors
// from Zod 4 (the `kind: 'ack'` success/failure split blew up at runtime on
// first parse because Zod 4 rejects sibling options sharing a discriminator
// value — the fix flattens ack into a single shape with optional fields).
// ---------------------------------------------------------------------------

describe('WorkerToTab parsing', () => {
  it('parses snapshot frames', () => {
    const frame = {
      kind: 'snapshot',
      scope: { kind: 'admin-global' },
      snapshot: {
        kind: 'admin-global',
        data: { initialAgents: [], connectionState: 'connecting', serverShutdownReason: null },
      },
    };
    expect(WorkerToTab.safeParse(frame).success).toBe(true);
  });

  it('parses mutation frames', () => {
    const frame = {
      kind: 'mutation',
      scope: { kind: 'admin-global' },
      snapshot: {
        kind: 'admin-global',
        data: { initialAgents: [], connectionState: 'open', serverShutdownReason: null },
      },
    };
    expect(WorkerToTab.safeParse(frame).success).toBe(true);
  });

  it('parses scoped-event frames', () => {
    const frame = {
      kind: 'scoped-event',
      scope: { kind: 'admin-target', target: { kind: 'manager', slug: 'design-manager' } },
      event: 'typing',
      data: { channel: 'default' },
    };
    expect(WorkerToTab.safeParse(frame).success).toBe(true);
  });

  it('parses successful ack frames (ok=true with result)', () => {
    const frame = { kind: 'ack', requestId: 'req-1', ok: true, result: { hello: 'world' } };
    expect(WorkerToTab.safeParse(frame).success).toBe(true);
  });

  it('parses successful ack frames (ok=true with no result)', () => {
    const frame = { kind: 'ack', requestId: 'req-1', ok: true };
    expect(WorkerToTab.safeParse(frame).success).toBe(true);
  });

  it('parses failure ack frames (ok=false with error)', () => {
    const frame = { kind: 'ack', requestId: 'req-1', ok: false, error: 'boom' };
    expect(WorkerToTab.safeParse(frame).success).toBe(true);
  });

  it('parses event frames', () => {
    const frame = {
      kind: 'event',
      event: { kind: 'identity-registered', identity: 'web:abc', identityId: 'u:1', name: 'Alice' },
    };
    expect(WorkerToTab.safeParse(frame).success).toBe(true);
  });

  it('parses hello-ack frames', () => {
    const frame = { kind: 'hello-ack', workerVersion: 'v0.2.0' };
    expect(WorkerToTab.safeParse(frame).success).toBe(true);
  });
});

describe('scopeKey', () => {
  it('produces a stable string per scope kind', () => {
    expect(scopeKey({ kind: 'admin-global' })).toBe('admin-global');
    expect(
      scopeKey({ kind: 'admin-target', target: { kind: 'agent', alias: 'a', channel: '__design' } }),
    ).toBe('admin-target:agent:a:__design');
    expect(
      scopeKey({ kind: 'admin-target', target: { kind: 'manager', slug: 'config-manager' } }),
    ).toBe('admin-target:manager:config-manager');
    expect(scopeKey({ kind: 'chat-identity', identity: 'web:abc' })).toBe('chat-identity:web:abc');
    expect(
      scopeKey({ kind: 'chat-conversation', identity: 'web:abc', agent: 'foo', channel: 'default' }),
    ).toBe('chat-conversation:web:abc:foo:default');
  });
});
