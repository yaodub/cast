import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ApprovalsStore, installApprovalsSchema } from './approvals-store.js';

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
