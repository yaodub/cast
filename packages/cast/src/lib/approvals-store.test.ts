import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ApprovalsStore, installApprovalsSchema, isExpired } from './approvals-store.js';

function makeStore(): ApprovalsStore {
  const db = new Database(':memory:');
  installApprovalsSchema(db);
  return new ApprovalsStore(db);
}

describe('ApprovalsStore.pendingAclEdge', () => {
  it('finds a pending acl-edge by (participant, channel)', () => {
    const store = makeStore();
    store.insertApproval({
      id: 'e1', type: 'acl-edge', summary: 'alice wants in',
      participant: 'u:alice@idp', channel: 'room',
      payload: JSON.stringify({ bit: 'a' }),
    });
    expect(store.pendingAclEdge('u:alice@idp', 'room')).toBe('e1');
    // off-edge: wrong channel or wrong participant is a different decision
    expect(store.pendingAclEdge('u:alice@idp', 'other')).toBeNull();
    expect(store.pendingAclEdge('u:bob@idp', 'room')).toBeNull();
  });

  it('a resolved acl-edge no longer dedups (the edge is decided)', () => {
    const store = makeStore();
    store.insertApproval({
      id: 'e2', type: 'acl-edge', summary: 's',
      participant: 'u:alice@idp', channel: 'room', payload: '{}',
    });
    store.updateApprovalStatus('e2', 'approved');
    expect(store.pendingAclEdge('u:alice@idp', 'room')).toBeNull();
  });

  it('a pending tool-call on the same participant is not an acl-edge match', () => {
    const store = makeStore();
    store.insertApproval({
      id: 't1', tool: 'send_email', args: { to: 'x' }, summary: 's',
      participant: 'u:alice@idp', channel: 'room',
    });
    expect(store.pendingAclEdge('u:alice@idp', 'room')).toBeNull();
  });

  it('the bit filter keeps inbound (a) and outbound (q) edges from cross-deduping (2B.5)', () => {
    const store = makeStore();
    // A mutual attempt on one (participant, channel): peer P queries us (inbound
    // access edge, bit a) AND we want to query P (outbound containment edge, bit q).
    store.insertApproval({
      id: 'in1', type: 'acl-edge', summary: 's',
      participant: 'a:peer@idp', channel: 'default', payload: JSON.stringify({ bit: 'a' }),
    });
    store.insertApproval({
      id: 'out1', type: 'acl-edge', summary: 's',
      participant: 'a:peer@idp', channel: 'default', payload: JSON.stringify({ bit: 'q' }),
    });
    // direction-filtered lookups resolve to the matching edge only
    expect(store.pendingAclEdge('a:peer@idp', 'default', ['a'])).toBe('in1');
    expect(store.pendingAclEdge('a:peer@idp', 'default', ['q', 'r'])).toBe('out1');
    // unfiltered still matches some pending edge (back-compat; which one is a
    // created_at tie-break, so just assert it resolves)
    expect(store.pendingAclEdge('a:peer@idp', 'default')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Expiry: swept, surfaced, dismissed
// ---------------------------------------------------------------------------

const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

describe('ApprovalsStore expiry lifecycle', () => {
  it('sweeps only rows whose expiry has passed', () => {
    const store = makeStore();
    store.insertApproval({ id: 'dead', summary: 's', participant: 'u:a@i', expiresAt: PAST });
    store.insertApproval({ id: 'live', summary: 's', participant: 'u:a@i', expiresAt: FUTURE });
    // A null expiry means "no deadline" and must never be swept.
    store.insertApproval({ id: 'forever', summary: 's', participant: 'u:a@i' });

    expect(store.expireStale()).toBe(1);
    expect(store.getApproval('dead')?.status).toBe('expired');
    expect(store.getApproval('live')?.status).toBe('pending');
    expect(store.getApproval('forever')?.status).toBe('pending');
  });

  it('is idempotent — a second sweep finds nothing', () => {
    const store = makeStore();
    store.insertApproval({ id: 'dead', summary: 's', participant: 'u:a@i', expiresAt: PAST });
    expect(store.expireStale()).toBe(1);
    expect(store.expireStale()).toBe(0);
  });

  it('leaves an already-decided row alone even if its expiry passed', () => {
    const store = makeStore();
    store.insertApproval({ id: 'done', summary: 's', participant: 'u:a@i', expiresAt: PAST });
    store.updateApprovalStatus('done', 'approved');
    expect(store.expireStale()).toBe(0);
    expect(store.getApproval('done')?.status).toBe('approved');
  });

  it('surfaces expired rows to the operator rather than hiding them', () => {
    const store = makeStore();
    store.insertApproval({ id: 'dead', summary: 's', participant: 'u:a@i', expiresAt: PAST });
    store.insertApproval({ id: 'live', summary: 's', participant: 'u:a@i', expiresAt: FUTURE });
    store.insertApproval({ id: 'gone', summary: 's', participant: 'u:a@i', expiresAt: PAST });
    store.updateApprovalStatus('gone', 'approved');
    store.expireStale();

    const ids = store.listOperatorApprovals().map((r) => r.id).sort();
    expect(ids).toEqual(['dead', 'live']);
    // The badge counts only what a decision can still clear.
    expect(store.listPendingApprovals().map((r) => r.id)).toEqual(['live']);
  });

  it('dismiss clears an expired row off the surface', () => {
    const store = makeStore();
    store.insertApproval({ id: 'dead', summary: 's', participant: 'u:a@i', expiresAt: PAST });
    store.expireStale();

    expect(store.dismissApproval('dead')).toBe(true);
    expect(store.getApproval('dead')?.status).toBe('dismissed');
    expect(store.listOperatorApprovals()).toEqual([]);
  });

  it('dismiss accepts a row that lapsed but has not been swept yet', () => {
    const store = makeStore();
    store.insertApproval({ id: 'lapsed', summary: 's', participant: 'u:a@i', expiresAt: PAST });
    // No sweep: the row still stores 'pending' while every surface shows it dead.
    expect(store.getApproval('lapsed')?.status).toBe('pending');
    expect(store.dismissApproval('lapsed')).toBe(true);
    expect(store.getApproval('lapsed')?.status).toBe('dismissed');
  });

  it('dismiss refuses a pending row — a live decision must be decided', () => {
    const store = makeStore();
    store.insertApproval({ id: 'live', summary: 's', participant: 'u:a@i', expiresAt: FUTURE });
    expect(store.dismissApproval('live')).toBe(false);
    expect(store.getApproval('live')?.status).toBe('pending');
  });
});

describe('deadline-awareness does not depend on a sweep having run', () => {
  it('listPendingApprovals ignores a lapsed row with no sweep in between', () => {
    const store = makeStore();
    store.insertApproval({ id: 'dead', summary: 's', participant: 'u:a@i', expiresAt: PAST });
    store.insertApproval({ id: 'live', summary: 's', participant: 'u:a@i', expiresAt: FUTURE });
    // Deliberately no expireStale() — the row is still stored as 'pending'.
    expect(store.getApproval('dead')?.status).toBe('pending');
    expect(store.listPendingApprovals().map((r) => r.id)).toEqual(['live']);
  });

  it('a lapsed acl-edge no longer dedups, so a fresh ask can be raised', () => {
    const store = makeStore();
    store.insertApproval({
      id: 'stale', type: 'acl-edge', summary: 's', participant: 'u:alice@idp',
      channel: 'room', payload: JSON.stringify({ bit: 'a' }), expiresAt: PAST,
    });
    // Without this, a dead edge suppresses every future request on it forever.
    expect(store.pendingAclEdge('u:alice@idp', 'room', ['a'])).toBeNull();
  });

  it('a live acl-edge still dedups — one decision per edge, not per message', () => {
    const store = makeStore();
    store.insertApproval({
      id: 'live', type: 'acl-edge', summary: 's', participant: 'u:alice@idp',
      channel: 'room', payload: JSON.stringify({ bit: 'a' }), expiresAt: FUTURE,
    });
    expect(store.pendingAclEdge('u:alice@idp', 'room', ['a'])).toBe('live');
  });

  it('isExpired agrees with the query predicate on both sides', () => {
    const store = makeStore();
    store.insertApproval({ id: 'dead', summary: 's', participant: 'u:a@i', expiresAt: PAST });
    store.insertApproval({ id: 'live', summary: 's', participant: 'u:a@i', expiresAt: FUTURE });
    store.insertApproval({ id: 'forever', summary: 's', participant: 'u:a@i' });
    const byId = Object.fromEntries(
      ['dead', 'live', 'forever'].map((id) => [id, store.getApproval(id)!]),
    );
    expect(isExpired(byId.dead!)).toBe(true);
    expect(isExpired(byId.live!)).toBe(false);
    expect(isExpired(byId.forever!)).toBe(false);
    // The query's answer and the row helper's answer must never disagree.
    const decidable = store.listPendingApprovals().map((r) => r.id).sort();
    expect(decidable).toEqual(['forever', 'live']);
  });
});

describe('interrupted: context-bound rows only, and never silently', () => {
  it('the shutdown sweep interrupts tool-calls and spares the policy shapes', () => {
    const store = makeStore();
    store.insertApproval({ id: 'tc', tool: 'fetch', summary: 's', participant: 'u:a@i', expiresAt: FUTURE });
    store.insertApproval({ id: 'edge', type: 'acl-edge', summary: 's', participant: 'u:a@i', payload: '{}', expiresAt: FUTURE });
    store.insertApproval({ id: 'push', type: 'user-push', summary: 's', participant: 'u:a@i', payload: '{}', expiresAt: FUTURE });

    expect(store.markPendingApprovalsInterrupted()).toBe(1);
    expect(store.getApproval('tc')?.status).toBe('interrupted');
    // Policy shapes are payload-complete and resolve statelessly — a restart
    // must not eat a decision that is still fully answerable.
    expect(store.getApproval('edge')?.status).toBe('pending');
    expect(store.getApproval('push')?.status).toBe('pending');
  });

  it('an interrupted row stays on the operator surface until dismissed', () => {
    const store = makeStore();
    store.insertApproval({ id: 'tc', tool: 'fetch', summary: 's', participant: 'u:a@i', expiresAt: FUTURE });
    store.markPendingApprovalsInterrupted();

    expect(store.listOperatorApprovals().map((r) => r.id)).toEqual(['tc']);
    expect(store.listPendingApprovals()).toEqual([]);
    expect(store.dismissApproval('tc')).toBe(true);
    expect(store.listOperatorApprovals()).toEqual([]);
  });

  it('a spared acl-edge still dedups after the sweep — the decision is alive', () => {
    const store = makeStore();
    store.insertApproval({
      id: 'edge', type: 'acl-edge', summary: 's', participant: 'u:alice@idp',
      channel: 'room', payload: JSON.stringify({ bit: 'a' }), expiresAt: FUTURE,
    });
    store.markPendingApprovalsInterrupted();
    expect(store.pendingAclEdge('u:alice@idp', 'room', ['a'])).toBe('edge');
  });
});
