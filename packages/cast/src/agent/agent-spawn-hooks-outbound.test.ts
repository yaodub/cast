/**
 * Outbound containment gate helpers — the sender-side of reactive
 * reach. `emitOutboundRequest` is the shared record+route tail (granted path and
 * owner-grant re-emit); `raiseOutboundContainmentApproval` holds an askable
 * outbound request and raises an owner-directed acl-edge approval.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  emitOutboundRequest,
  raiseOutboundContainmentApproval,
  type HeldOutboundRequest,
} from './agent-spawn-hooks.js';
import { _resetBounceStateForTest } from './agent-bus-handler.js';

const held: HeldOutboundRequest = {
  target: 'a:weather@iss',
  kind: 'query',
  text: 'forecast?',
  requestId: 'req-1',
  channel: 'default',
  returnToChannel: 'default',
  returnToParticipant: 'u:alice@iss',
  upstreamSet: [],
};

describe('emitOutboundRequest', () => {
  it('records the outbound request and routes a request packet to the target', () => {
    const recordOutboundRequest = vi.fn();
    const routeMessage = vi.fn(() => Promise.resolve());
    const deps = { agentId: 'a:talker@iss', bus: { routeMessage }, agentDb: { recordOutboundRequest } };
    emitOutboundRequest(deps as never, held);
    expect(recordOutboundRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-1', targetAgent: 'a:weather@iss', targetChannel: 'default',
      channel: 'default', participant: 'u:alice@iss',
    }));
    expect(routeMessage).toHaveBeenCalledWith('a:talker@iss', 'a:weather@iss', expect.objectContaining({
      type: 'request', kind: 'query', text: 'forecast?', requestId: 'req-1',
      returnToAgent: 'a:talker@iss', returnToParticipant: 'u:alice@iss',
    }));
  });
});

describe('raiseOutboundContainmentApproval', () => {
  beforeEach(() => _resetBounceStateForTest());

  function harness(pendingId: string | null) {
    const createRequest = vi.fn();
    const pendingAclEdge = vi.fn(() => pendingId);
    const deliver = vi.fn(() => Promise.resolve());
    const deps = { getTimezone: () => 'UTC' };
    const approvals = { createRequest, pendingAclEdge };
    const conv = { deliver };
    return { deps, approvals, conv, createRequest, pendingAclEdge, deliver };
  }

  it('raises an owner-directed acl-edge approval keyed on the target, holding the request', () => {
    const h = harness(null);
    raiseOutboundContainmentApproval(h.deps as never, h.approvals as never, h.conv as never, held, 'q', 'weather-reporter');
    // dedup is direction-aware (q/r)
    expect(h.pendingAclEdge).toHaveBeenCalledWith('a:weather@iss', 'default', ['q', 'r']);
    expect(h.createRequest).toHaveBeenCalledTimes(1);
    const arg = h.createRequest.mock.calls[0][0];
    expect(arg).toMatchObject({ type: 'acl-edge', approver: 'owner', participant: 'a:weather@iss', channel: 'default' });
    // the held request rides in the payload, with the q bit + a correlation ref
    const payload = JSON.parse(arg.payload);
    expect(payload.bit).toBe('q');
    expect(payload.held).toEqual(held);
    expect(typeof payload.ref).toBe('string');
    // a pending notice goes into the agent's own conversation
    expect(h.deliver).toHaveBeenCalledWith(expect.stringContaining('pending'), { kind: 'system' });
  });

  it('dedups when an outbound edge is already pending — informs once, no second approval', () => {
    const h = harness('existing-id');
    raiseOutboundContainmentApproval(h.deps as never, h.approvals as never, h.conv as never, held, 'q', 'weather-reporter');
    raiseOutboundContainmentApproval(h.deps as never, h.approvals as never, h.conv as never, held, 'q', 'weather-reporter');
    expect(h.createRequest).not.toHaveBeenCalled();
    // first dup informs, second is silent (graduated bounce)
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Preview-deny durable trace — a denied preview stream must leave exactly one
// message_log row per (conversation, channel, recipient) even though the
// conversation-facing notice is deferred to the seal. Covers the preview-only
// turn hole: without this, a turn that streams previews to a denied recipient
// and never seals to them vanishes without a trace anywhere.
// =============================================================================

vi.mock('../auth/acl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/acl.js')>();
  return { ...actual, checkAcl: vi.fn(() => ({ bits: '', rejectMessage: null })) };
});

import { buildSpawnHooks } from './agent-spawn-hooks.js';
import { checkAcl } from '../auth/acl.js';

describe('handleOutboundPreview — deny leaves one durable trace', () => {
  function previewHarness(channelOverrides: Record<string, unknown> = {}) {
    const logInbound = vi.fn();
    const routeMessage = vi.fn(() => Promise.resolve());
    const deps = {
      agentId: 'a:me@iss',
      folder: 'me',
      bus: { routeMessage, routeEvent: vi.fn() },
      agentDb: { messages: { logInbound }, logEvent: vi.fn() },
      store: {},
      getTimezone: () => 'UTC',
    };
    const conv = {
      scope: 'agent', key: 'default|u:alice@iss',
      ctx: {
        channelName: 'default',
        participant: 'u:alice@iss',
        channel: { idle_timeout: null, lifecycle: 'none', log_messages: true, use_sharding: false, disabled_tools: [], ...channelOverrides },
      },
    };
    const hooks = buildSpawnHooks(deps as never, conv as never);
    const frame = (to: string) => ({ from: 'a:me@iss', to, text: 'partial…' });
    return { hooks, frame, logInbound, routeMessage };
  }

  beforeEach(() => {
    vi.mocked(checkAcl).mockReset().mockReturnValue({ bits: '', rejectMessage: null } as never);
  });

  it('denied stream: many frames → exactly one system-sender row, nothing routed', () => {
    const h = previewHarness();
    h.hooks.onPreview!(h.frame('a:peer@iss') as never, 'default', 'default|u:alice@iss');
    h.hooks.onPreview!(h.frame('a:peer@iss') as never, 'default', 'default|u:alice@iss');
    h.hooks.onPreview!(h.frame('a:peer@iss') as never, 'default', 'default|u:alice@iss');

    expect(h.routeMessage).not.toHaveBeenCalled();
    expect(h.logInbound).toHaveBeenCalledTimes(1);
    const [participant, sender, text, channel] = h.logInbound.mock.calls[0]!;
    expect(participant).toBe('u:alice@iss');
    expect(sender).toBe('system');
    expect(text).toContain('<cast:system>');
    expect(text).toContain('a:peer@iss');
    expect(channel).toBe('default');
  });

  it('distinct recipients each get their own trace', () => {
    const h = previewHarness();
    h.hooks.onPreview!(h.frame('a:peer1@iss') as never, 'default', 'default|u:alice@iss');
    h.hooks.onPreview!(h.frame('a:peer2@iss') as never, 'default', 'default|u:alice@iss');
    expect(h.logInbound).toHaveBeenCalledTimes(2);
  });

  it('log_messages: false channel opts out — deny stays silent-drop', () => {
    const h = previewHarness({ log_messages: false });
    h.hooks.onPreview!(h.frame('a:peer@iss') as never, 'default', 'default|u:alice@iss');
    expect(h.logInbound).not.toHaveBeenCalled();
    expect(h.routeMessage).not.toHaveBeenCalled();
  });

  it('allowed stream routes the frame and writes nothing', () => {
    vi.mocked(checkAcl).mockReturnValue({ bits: 'io', rejectMessage: null } as never);
    const h = previewHarness();
    h.hooks.onPreview!(h.frame('a:peer@iss') as never, 'default', 'default|u:alice@iss');
    expect(h.routeMessage).toHaveBeenCalledTimes(1);
    expect(h.logInbound).not.toHaveBeenCalled();
  });
});
