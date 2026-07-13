/**
 * Unit tests for ApprovalHandler answerer authentication.
 *
 * The hole: handleResponse used to look up the approval row by id only and
 * execute on anyone's say-so. The fix gates on whoever the approval was routed
 * to (`row.participant`) — or the operator — resolving the answerer's transport
 * handle to its identity first, since `from` arrives unresolved on the thin
 * approval path.
 *
 * Both-branches discipline: authorized (resolved handle / bare identity /
 * compound / operator) proceeds; unauthorized (different identity) drops +
 * surfaces a host-event; no-idp fails open.
 *
 * Uses `rejected` decisions throughout so the test never reaches
 * executeApprovedTool (extensions/service) — the auth gate runs before the
 * decision split, so this exercises it fully.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ApprovalHandler, type ApprovalDeps } from './approval-handler.js';

// Stub owner resolution (2A.4/2A.6) + spy the single-store acl-edge writers (the
// acl-edge outcome side, 2B) — both live in acl.js now (no separate reactive store).
// Existing tests pass `controller` explicitly, bypassing the owner-lookup path.
vi.mock('../auth/acl.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/acl.js')>()),
  getOwner: vi.fn(() => 'u:owner@iss'),
  getOwnerConversation: vi.fn(() => null),
  grantAclEdge: vi.fn(),
  tombstoneAclEdge: vi.fn(),
}));
import { getOwnerConversation, grantAclEdge, tombstoneAclEdge } from '../auth/acl.js';

function makeHandler(overrides: Partial<ApprovalDeps> = {}, rowExtra: Record<string, unknown> = {}) {
  const updateApprovalStatus = vi.fn();
  const insertApproval = vi.fn();
  const routeMessage = vi.fn();
  const logHostEvent = vi.fn();
  const routeOutcome = vi.fn();
  const deliverHeldRequest = vi.fn();
  const rejectHeldRequest = vi.fn();
  const reEmitHeldRequest = vi.fn();
  const declineHeldRequest = vi.fn();
  const row = {
    id: 'abc', tool: 'noop', args: '{}', summary: 'do the thing', details: null,
    participant: 'u:alice@iss', channel: null, conversation_key: null,
    status: 'pending', created_at: '', expires_at: null, resolved_at: null, reason: null,
    ...rowExtra,
  };
  const idp = {
    resolve: (handle: string) => {
      const map: Record<string, string> = {
        'tg:111': 'u:alice@iss',   // Alice's Telegram handle
        'tg:999': 'u:mallory@iss', // a different user
      };
      const id = map[handle];
      return id ? { id, declaredName: 'x', handle } : null;
    },
  };
  const deps = {
    agentId: 'a:self@iss', folder: 'self',
    bus: { routeMessage, routeEvent: vi.fn() },
    agentDb: { approvals: { insertApproval, getApproval: vi.fn(() => row), updateApprovalStatus } },
    service: {}, extensions: { instances: [] },
    idp, logHostEvent,
    getTimezone: () => 'UTC',
    routeOutcome,
    deliverHeldRequest,
    rejectHeldRequest,
    reEmitHeldRequest,
    declineHeldRequest,
    ...overrides,
  } as unknown as ApprovalDeps;
  return {
    handler: new ApprovalHandler(deps), updateApprovalStatus, logHostEvent, routeMessage,
    insertApproval, deliverHeldRequest, rejectHeldRequest, reEmitHeldRequest, declineHeldRequest,
  };
}

const reject = (id = 'abc') => ({ id, decision: 'rejected' as const });

describe('ApprovalHandler answerer authentication', () => {
  it('accepts the routed participant via a resolved transport handle', async () => {
    const { handler, updateApprovalStatus, logHostEvent } = makeHandler();
    await handler.handleResponse('tg:111', reject()); // → u:alice@iss == participant
    expect(updateApprovalStatus).toHaveBeenCalledWith('abc', 'rejected', undefined, undefined);
    expect(logHostEvent).not.toHaveBeenCalled();
  });

  it('accepts a bare identity answerer (email/web already resolved)', async () => {
    const { handler, updateApprovalStatus } = makeHandler();
    await handler.handleResponse('u:alice@iss', reject());
    expect(updateApprovalStatus).toHaveBeenCalledWith('abc', 'rejected', undefined, undefined);
  });

  it('accepts a compound answerer by stripping the handle suffix', async () => {
    const { handler, updateApprovalStatus } = makeHandler();
    await handler.handleResponse('u:alice@iss/tg:111', reject());
    expect(updateApprovalStatus).toHaveBeenCalledWith('abc', 'rejected', undefined, undefined);
  });

  it('accepts the operator (god-mode backstop) regardless of recipient', async () => {
    const { handler, updateApprovalStatus } = makeHandler();
    await handler.handleResponse('cli:bob', reject());
    expect(updateApprovalStatus).toHaveBeenCalledWith('abc', 'rejected', undefined, undefined);
  });

  it('DENIES the operator for a `user-push` approval — no operator backstop (2B.3 decision 4)', async () => {
    // The pushee's in-band consent is theirs alone; operator god-mode is skipped
    // for user-push so the operator cannot override "your conversation is yours".
    const { handler, updateApprovalStatus, logHostEvent } = makeHandler(
      {}, { type: 'user-push', controller: 'u:alice@iss' });
    await handler.handleResponse('cli:bob', reject()); // operator → must be dropped
    expect(updateApprovalStatus).not.toHaveBeenCalled();
    expect(logHostEvent).toHaveBeenCalledWith(
      'warn', 'approval', 'approval_answerer_mismatch', expect.any(String), expect.any(Object));
  });

  it('accepts the PUSHEE (controller) for a `user-push` approval', async () => {
    const { handler, updateApprovalStatus } = makeHandler(
      {}, { type: 'user-push', controller: 'u:alice@iss' });
    await handler.handleResponse('u:alice@iss', reject()); // the pushee answers in-band
    expect(updateApprovalStatus).toHaveBeenCalledWith('abc', 'rejected', undefined, undefined);
  });

  it('drops an unauthorized answerer (different identity) and surfaces a host-event', async () => {
    const { handler, updateApprovalStatus, logHostEvent } = makeHandler();
    await handler.handleResponse('tg:999', reject()); // → u:mallory@iss != participant
    expect(updateApprovalStatus).not.toHaveBeenCalled();
    expect(logHostEvent).toHaveBeenCalledTimes(1);
    expect(logHostEvent).toHaveBeenCalledWith(
      'warn', 'approval', 'approval_answerer_mismatch',
      expect.any(String), expect.objectContaining({ fromAddr: 'tg:999' }),
    );
  });

  it('fails open when no identity provider is available (degenerate config)', async () => {
    const { handler, updateApprovalStatus } = makeHandler({ idp: undefined });
    await handler.handleResponse('tg:111', reject());
    expect(updateApprovalStatus).toHaveBeenCalledWith('abc', 'rejected', undefined, undefined);
  });

  it('drops an ext:* answerer — an injection origin can never self-authorize', async () => {
    // ext:* is fire-and-forget injection, not a responding entity. The hard-deny
    // sits before the identity compare (and before the fail-open path), so even
    // a missing/forgiving idp cannot let a synthesized ext `from` authorize.
    const { handler, updateApprovalStatus, logHostEvent } = makeHandler();
    await handler.handleResponse('ext:email', reject());
    expect(updateApprovalStatus).not.toHaveBeenCalled();
    expect(logHostEvent).toHaveBeenCalledTimes(1);
    expect(logHostEvent).toHaveBeenCalledWith(
      'warn', 'approval', 'approval_answerer_mismatch',
      expect.any(String), expect.objectContaining({ fromAddr: 'ext:email' }),
    );
  });

  it('auths the controller, not the participant, when they differ (owner-approves) [2A.3]', async () => {
    // controller (the owner) = mallory; the conversing participant = alice.
    const ok = makeHandler({}, { controller: 'u:mallory@iss' });
    await ok.handler.handleResponse('tg:999', reject()); // tg:999 → mallory == controller
    expect(ok.updateApprovalStatus).toHaveBeenCalledWith('abc', 'rejected', undefined, undefined);

    const bad = makeHandler({}, { controller: 'u:mallory@iss' });
    await bad.handler.handleResponse('tg:111', reject()); // tg:111 → alice != controller
    expect(bad.updateApprovalStatus).not.toHaveBeenCalled();
    expect(bad.logHostEvent).toHaveBeenCalledTimes(1);
  });

  it('persists tier=always for an owner-directed approval (controller != participant) [2A.4]', async () => {
    const { handler, updateApprovalStatus } = makeHandler({}, { controller: 'u:mallory@iss' });
    await handler.handleResponse('tg:999', { id: 'abc', decision: 'rejected', tier: 'always' }); // mallory == controller
    expect(updateApprovalStatus).toHaveBeenCalledWith('abc', 'rejected', undefined, 'always');
  });

  it('ignores tier for a participant-directed approval (controller == participant) — no self-exemption [2A.4]', async () => {
    const { handler, updateApprovalStatus } = makeHandler(); // no controller -> controller == participant (alice)
    await handler.handleResponse('tg:111', { id: 'abc', decision: 'rejected', tier: 'always' }); // alice answers her own
    expect(updateApprovalStatus).toHaveBeenCalledWith('abc', 'rejected', undefined, undefined);
  });
});

describe('ApprovalHandler.createRequest — owner-routing [2A.4]', () => {
  it('owner-approves routes the request to the controller + marks the pkt tiered', () => {
    const { handler, routeMessage, insertApproval } = makeHandler();
    handler.createRequest({
      tool: 'noop', args: {}, summary: 'do it',
      participant: 'u:alice@iss', approver: 'owner', controller: 'cli:owner',
    });
    expect(routeMessage).toHaveBeenCalledWith(
      'a:self@iss', 'cli:owner',
      expect.objectContaining({ pkt: expect.objectContaining({ to: 'cli:owner', tiered: true }) }),
    );
    expect(insertApproval).toHaveBeenCalledWith(
      expect.objectContaining({ controller: 'cli:owner', participant: 'u:alice@iss' }),
    );
  });

  it('participant approvals route to the participant + are not tiered', () => {
    const { handler, routeMessage, insertApproval } = makeHandler();
    handler.createRequest({ tool: 'noop', args: {}, summary: 'do it', participant: 'u:alice@iss' });
    expect(routeMessage).toHaveBeenCalledWith(
      'a:self@iss', 'u:alice@iss',
      expect.objectContaining({ pkt: expect.objectContaining({ to: 'u:alice@iss', tiered: false }) }),
    );
    expect(insertApproval).toHaveBeenCalledWith(
      expect.objectContaining({ controller: 'u:alice@iss' }),
    );
  });

  it('the operator sentinel controller is recorded but not routed (deferred admin surface)', () => {
    const { handler, routeMessage, insertApproval } = makeHandler();
    handler.createRequest({
      tool: 'noop', args: {}, summary: 'do it',
      participant: 'u:alice@iss', approver: 'owner', controller: 'operator',
    });
    expect(routeMessage).not.toHaveBeenCalled();
    expect(insertApproval).toHaveBeenCalledWith(expect.objectContaining({ controller: 'operator' }));
  });
});

describe('ApprovalHandler.createRequest — owner conversation routing [2A.6]', () => {
  it('lands an owner-directed approval in the owner pinned channel when approval_channel is set', () => {
    vi.mocked(getOwnerConversation).mockReturnValueOnce({ id: 'u:owner@iss', channel: 'room' });
    const { handler, routeMessage } = makeHandler();
    handler.createRequest({
      tool: 'noop', args: {}, summary: 'do it', participant: 'u:alice@iss', approver: 'owner',
    });
    expect(routeMessage).toHaveBeenCalledWith(
      'a:self@iss', 'u:owner@iss',
      expect.objectContaining({ channel: 'room', pkt: expect.objectContaining({ tiered: true }) }),
    );
  });

  it('routes with no channel when no approval_channel is pinned (additive, 2A.4 behavior)', () => {
    // getOwnerConversation defaults to null → no pinned channel.
    const { handler, routeMessage } = makeHandler();
    handler.createRequest({
      tool: 'noop', args: {}, summary: 'do it', participant: 'u:alice@iss', approver: 'owner',
    });
    const payload = routeMessage.mock.calls[0]?.[2];
    expect(payload).toHaveProperty('pkt');
    expect(payload).not.toHaveProperty('channel');
  });
});

describe('ApprovalHandler acl-edge approvals [2B]', () => {
  beforeEach(() => {
    vi.mocked(grantAclEdge).mockClear();
    vi.mocked(tombstoneAclEdge).mockClear();
  });

  // An owner-directed acl-edge row: controller (owner) differs from the
  // participant (the principal the edge is granted to), so tiers are honored.
  const edgeRow = {
    type: 'acl-edge', participant: 'u:alice@iss', channel: 'default',
    controller: 'u:mallory@iss', tool: null, args: null,
    payload: JSON.stringify({ bit: 'a', heldRequestId: 'req-1' }),
  };

  it('createRequest carries type + payload, no tool, routes tiered to the owner', () => {
    const { handler, routeMessage, insertApproval } = makeHandler();
    handler.createRequest({
      type: 'acl-edge', summary: 'Alice wants in', participant: 'u:alice@iss',
      approver: 'owner', controller: 'cli:owner', channel: 'default',
      payload: JSON.stringify({ bit: 'a', heldRequestId: 'req-1' }),
    });
    expect(insertApproval).toHaveBeenCalledWith(expect.objectContaining({
      type: 'acl-edge', controller: 'cli:owner', channel: 'default',
      payload: JSON.stringify({ bit: 'a', heldRequestId: 'req-1' }),
    }));
    expect(routeMessage).toHaveBeenCalledWith(
      'a:self@iss', 'cli:owner',
      expect.objectContaining({ pkt: expect.objectContaining({ tiered: true }) }),
    );
  });

  it('approve+always persists the grant (not a tombstone)', async () => {
    const { handler } = makeHandler({}, edgeRow);
    await handler.handleResponse('cli:owner', { id: 'abc', decision: 'approved', tier: 'always' });
    expect(grantAclEdge).toHaveBeenCalledWith('self', 'u:alice@iss', 'default', 'a');
    expect(tombstoneAclEdge).not.toHaveBeenCalled();
  });

  it('reject+always persists the tombstone (not a grant)', async () => {
    const { handler } = makeHandler({}, edgeRow);
    await handler.handleResponse('cli:owner', { id: 'abc', decision: 'rejected', tier: 'always' });
    expect(tombstoneAclEdge).toHaveBeenCalledWith('self', 'u:alice@iss', 'default', 'a');
    expect(grantAclEdge).not.toHaveBeenCalled();
  });

  it('the once tier persists nothing (no standing edge from a one-shot decision)', async () => {
    const { handler } = makeHandler({}, edgeRow);
    await handler.handleResponse('cli:owner', { id: 'abc', decision: 'approved', tier: 'once' });
    expect(grantAclEdge).not.toHaveBeenCalled();
    expect(tombstoneAclEdge).not.toHaveBeenCalled();
  });

  // The held request rides in the payload; resolution forwards it opaquely to the
  // resume callbacks (the bus-handler owns + re-validates its shape).
  const held = { from: 'a:sender@iss', requestId: 'req-1', text: 'hi' };
  const heldRow = { ...edgeRow, payload: JSON.stringify({ bit: 'a', held }) };

  it('approve delivers (resumes) the held request', async () => {
    const { handler, deliverHeldRequest, rejectHeldRequest } = makeHandler({}, heldRow);
    await handler.handleResponse('cli:owner', { id: 'abc', decision: 'approved', tier: 'always' });
    expect(deliverHeldRequest).toHaveBeenCalledWith(held);
    expect(rejectHeldRequest).not.toHaveBeenCalled();
  });

  it('approve+once still releases the one held request (deliver without a standing grant)', async () => {
    const { handler, deliverHeldRequest } = makeHandler({}, heldRow);
    await handler.handleResponse('cli:owner', { id: 'abc', decision: 'approved', tier: 'once' });
    expect(deliverHeldRequest).toHaveBeenCalledTimes(1);
    expect(grantAclEdge).not.toHaveBeenCalled();
  });

  // An `io` (first-contact message) edge has no return rail — the agent's prose
  // reply needs standing `o` or it bounces. So an approved `io` edge ALWAYS
  // writes the grant: a stray `once` (forged/stale client; the io card drops it)
  // is coerced to `always`. Contrast the `bit:'a'` once case above (no grant).
  const ioHeldRow = { ...edgeRow, payload: JSON.stringify({ bit: 'io', held }) };

  it('approve+once on an io edge is coerced to a standing grant (no silent-reply bounce)', async () => {
    const { handler, deliverHeldRequest } = makeHandler({}, ioHeldRow);
    await handler.handleResponse('cli:owner', { id: 'abc', decision: 'approved', tier: 'once' });
    expect(grantAclEdge).toHaveBeenCalledWith('self', 'u:alice@iss', 'default', 'io');
    expect(deliverHeldRequest).toHaveBeenCalledTimes(1);
  });

  it('reject+once on an io edge is NOT coerced (declines this one, no tombstone)', async () => {
    const { handler, rejectHeldRequest } = makeHandler({}, ioHeldRow);
    await handler.handleResponse('cli:owner', { id: 'abc', decision: 'rejected', tier: 'once' });
    expect(tombstoneAclEdge).not.toHaveBeenCalled();
    expect(rejectHeldRequest).toHaveBeenCalledTimes(1);
  });

  it('reject routes a rejection back to the held request sender, carrying the reason', async () => {
    const { handler, deliverHeldRequest, rejectHeldRequest } = makeHandler({}, heldRow);
    await handler.handleResponse('cli:owner', { id: 'abc', decision: 'rejected', reason: 'no thanks', tier: 'always' });
    expect(rejectHeldRequest).toHaveBeenCalledWith(held, 'no thanks');
    expect(deliverHeldRequest).not.toHaveBeenCalled();
  });
});

// Outbound containment (2B.5): an acl-edge with bit `q`/`r` is the sender side —
// the participant is the TARGET agent, the grant is reach (q/r), and resume RE-
// EMITS the held outbound request rather than delivering it. The edge bit alone
// discriminates inbound (a/io → deliver/reject) from outbound (q/r → re-emit/decline).
describe('ApprovalHandler acl-edge outbound containment [2B.5]', () => {
  beforeEach(() => {
    vi.mocked(grantAclEdge).mockClear();
    vi.mocked(tombstoneAclEdge).mockClear();
  });

  const outHeld = { target: 'a:weather@iss', kind: 'query', requestId: 'req-9', text: 'forecast?' };
  // controller (owner) differs from participant (the target), so tiers are honored.
  const outRow = {
    type: 'acl-edge', participant: 'a:weather@iss', channel: 'default',
    controller: 'u:owner@iss', tool: null, args: null,
    payload: JSON.stringify({ bit: 'q', ref: '4242', held: outHeld }),
  };

  it('approve+always re-emits the held request and persists the q grant', async () => {
    const { handler, reEmitHeldRequest, deliverHeldRequest } = makeHandler({}, outRow);
    await handler.handleResponse('cli:owner', { id: 'abc', decision: 'approved', tier: 'always' });
    expect(reEmitHeldRequest).toHaveBeenCalledWith(outHeld);
    expect(deliverHeldRequest).not.toHaveBeenCalled();
    expect(grantAclEdge).toHaveBeenCalledWith('self', 'a:weather@iss', 'default', 'q');
  });

  it('approve+once re-emits the one held request but persists no grant', async () => {
    const { handler, reEmitHeldRequest } = makeHandler({}, outRow);
    await handler.handleResponse('cli:owner', { id: 'abc', decision: 'approved', tier: 'once' });
    expect(reEmitHeldRequest).toHaveBeenCalledTimes(1);
    expect(grantAclEdge).not.toHaveBeenCalled();
  });

  it('reject declines back to the agent (not a sender rejection) and tombstones on always', async () => {
    const { handler, declineHeldRequest, rejectHeldRequest } = makeHandler({}, outRow);
    await handler.handleResponse('cli:owner', { id: 'abc', decision: 'rejected', reason: 'no', tier: 'always' });
    expect(declineHeldRequest).toHaveBeenCalledWith(outHeld, 'no');
    expect(rejectHeldRequest).not.toHaveBeenCalled();
    expect(tombstoneAclEdge).toHaveBeenCalledWith('self', 'a:weather@iss', 'default', 'q');
  });
});
