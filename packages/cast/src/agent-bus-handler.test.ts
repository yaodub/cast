/**
 * Receiver-side type-driven verb selection at the bus boundary.
 *
 * `handleBusMessage` dispatches on `parsed.type` (the bus payload
 * discriminant) — `type: 'push'` gates on `h`, `type: 'message'` /
 * `type: 'ingested'` gate on `i`. Channel class is irrelevant. A
 * regression that picked the wrong verb (e.g. always `i`) would
 * break the push case here even though the unit-tested `gateInbound`
 * mapping looks correct in isolation. Push denials route a
 * `type: 'rejection'` back to the sender carrying the correlation id
 * so the originating LLM sees a `<cast:rejection request="<id>">`.
 *
 * Both branches per §Runtime Validation Strategy in the style guide.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('./config.js', () => ({
  agentPath: (folder: string, ...segments: string[]) =>
    path.join('/tmp/test-agents', folder, ...segments),
  readServerConfig: () => ({
    consoleModel: 'claude-opus-4-7',
    consoleIsolation: 'normal',
  }),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => { throw new Error('not found'); }),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
    },
  };
});

import { handleBusMessage, _resetBounceStateForTest, deliverHeldMessage, rejectHeldMessage, deliverHeldPush, rejectHeldPush, type BusHandlerDeps } from './agent/agent-bus-handler.js';
import { Bus } from './gateway/bus.js';
import type { BusHandler } from './gateway/bus.js';
import { _setMockWatcher } from './lib/config-reader.js';

const watcherFiles = new Map<string, string>();

beforeEach(() => {
  watcherFiles.clear();
  _resetBounceStateForTest();
  _setMockWatcher({ get: (p) => watcherFiles.get(p) ?? null });
});

function mockAclFile(content: object, folder: string): void {
  const aclPath = path.join('/tmp/test-agents', folder, 'config', 'acl.json');
  watcherFiles.set(aclPath, JSON.stringify(content));
}

function makeBus(): Bus {
  const bus = new Bus();
  const noop: BusHandler = { handleMessage: async () => {}, handleEvent: async () => {} };
  bus.register('a:sender@srv', noop, 'exact', { label: 'sender', type: 'agent', folderPath: 'sender' });
  return bus;
}

function makeDeps(folder: string, opts: { draft?: boolean } = {}): BusHandlerDeps & {
  calls: { route: number; rejected: number; rejection: number };
  routeArgs: Array<{ kind?: string; attrs?: Record<string, string> }>;
  replies: string[];
  approvals: { createCount: number; lastSummary: string | null; lastPayload: string | null; pendingId: string | null };
} {
  const calls = { route: 0, rejected: 0, rejection: 0 };
  const routeArgs: Array<{ kind?: string; attrs?: Record<string, string> }> = [];
  const replies: string[] = [];
  const approvals = { createCount: 0, lastSummary: null as string | null, lastPayload: null as string | null, pendingId: null as string | null };
  const bus = makeBus();
  const originalRouteMessage = bus.routeMessage.bind(bus);
  bus.routeMessage = async (from, to, payload) => {
    if (typeof payload === 'object' && payload !== null && 'pkt' in payload) {
      calls.rejected += 1;
      replies.push(JSON.stringify((payload as { pkt: unknown }).pkt));
      // Don't actually dispatch — there's no receiver registered for the
      // sender in these tests; tracking the call is enough.
      return;
    }
    if (typeof payload === 'object' && payload !== null && (payload as { type?: unknown }).type === 'rejection') {
      calls.rejection += 1;
      return;
    }
    return originalRouteMessage(from, to, payload);
  };
  return {
    agentId: 'a:test-receiver@srv',
    folder,
    bus,
    // @ts-expect-error — agentDb is unused on the message-gate path; stubbed minimally.
    agentDb: { logEvent: vi.fn() },
    idp: undefined,
    getApprovals: () => ({
      createRequest: (data: { summary?: string; payload?: string }) => {
        approvals.createCount += 1;
        approvals.lastSummary = data.summary ?? null;
        approvals.lastPayload = data.payload ?? null;
      },
      pendingAclEdge: () => approvals.pendingId,
    } as never),
    getTimezone: () => 'UTC',
    isDraft: () => opts.draft === true,
    route: vi.fn(
      async (
        _addr: string,
        _sender: string,
        _text: string,
        _routing?: unknown,
        _rawText?: string,
        _declaredName?: string,
        _attachments?: unknown,
        kind?: string,
        attrs?: Record<string, string>,
      ) => {
        calls.route += 1;
        routeArgs.push({ kind, attrs });
        return { ok: true as const, result: null };
      },
    ),
    calls,
    routeArgs,
    replies,
    approvals,
  };
}

describe('handleBusMessage — intent-driven verb selection', () => {
  // Note: the i/o/h/p bits are restricted to user (u:*) and console (console:*)
  // identities by the agent-identity bit restriction in acl.ts. These receiver-
  // side gate tests use a `console:*` sender — that's the live path for inbound
  // pushes on the disk-ACL lane (manager consoles into user channels).
  it('allows conversation when sender has `i` on channel', async () => {
    const folder = 'r-conv-allow';
    mockAclFile({ owner: 'operator', allowed: { 'console:sender': { '*': 'io' } }, reject_message: null }, folder);
    const deps = makeDeps(folder);

    await handleBusMessage(deps, 'console:sender', deps.agentId, {
      type: 'message',
      text: 'hi',
      routing: { channel: 'default' },
    });

    expect(deps.calls.route).toBe(1);
    expect(deps.calls.rejected).toBe(0);
  });

  it('denies push when sender has `i` but not `h`', async () => {
    // Same grants as above (`io`) — the *only* difference is type. Proves
    // verb is bus-payload-type-driven, not channel-class-driven. Denied
    // push routes a `type: 'rejection'` back carrying the correlation id.
    const folder = 'r-deleg-deny';
    mockAclFile({ owner: 'operator', allowed: { 'console:sender': { '*': 'io' } }, reject_message: null }, folder);
    const deps = makeDeps(folder);

    await handleBusMessage(deps, 'console:sender', deps.agentId, {
      type: 'push',
      text: 'hi',
      requestId: 'req-push-1',
      returnToParticipant: 'u:alice@idp',
      returnToChannel: 'origin',
      routing: { channel: 'default' },
    });

    expect(deps.calls.route).toBe(0);
    // ACL deny on push now routes a rejection back to the sender carrying
    // the requestId — the LLM sees `<cast:rejection request="<id>">` and
    // can correlate against the push tool's earlier `id` field.
    expect(deps.calls.rejection).toBe(1);
  });

  it('allows push when sender has `h` AND originating user has `i` on channel', async () => {
    // Three-check model: sender must have `h`, originating user
    // (returnToParticipant) must have `i`. Without the user-side grant,
    // push is denied even when the sender-level check passes.
    const folder = 'r-push-allow';
    mockAclFile({
      owner: 'operator',
      allowed: {
        'console:sender': { '*': 'io' },
        'u:alice@idp': { '*': 'io' },
      },
      reject_message: null,
    }, folder);
    const deps = makeDeps(folder);

    await handleBusMessage(deps, 'console:sender', deps.agentId, {
      type: 'push',
      text: 'hi',
      requestId: 'req-push-2',
      returnToParticipant: 'u:alice@idp',
      returnToChannel: 'origin',
      routing: { channel: 'default' },
    });

    expect(deps.calls.route).toBe(1);
    // Cross-sender push → kind='push'; tier attrs identify the foreign sender
    // and the originating user (colleague trust posture). Note:
    // `fromChannel` now populates uniformly because `returnToChannel`
    // travels on the payload (bonus side-effect of the type promotion).
    expect(deps.routeArgs[0]!.kind).toBe('push');
    expect(deps.routeArgs[0]!.attrs).toEqual({
      fromAgent: 'console:sender',
      fromParticipant: 'u:alice@idp',
      fromChannel: 'origin',
    });
  });

  it('non-push (conversation) routes without kind/attrs (no tier tagging)', async () => {
    const folder = 'r-conv-no-kind';
    mockAclFile({
      owner: 'operator',
      allowed: { 'console:sender': { '*': 'io' } },
      reject_message: null,
    }, folder);
    const deps = makeDeps(folder);

    await handleBusMessage(deps, 'console:sender', deps.agentId, {
      type: 'message',
      text: 'hello',
      routing: { channel: 'default' },
    });

    expect(deps.calls.route).toBe(1);
    expect(deps.routeArgs[0]!.kind).toBeUndefined();
    expect(deps.routeArgs[0]!.attrs).toBeUndefined();
  });

  it('denies push when sender has `h` but originating user lacks `i` on target channel', async () => {
    // Three-check model: even with sender's `h` granted, the originating
    // user must have `i`. Receiver-side user-level ACL check on
    // cross-sender push routes a rejection back with the requestId.
    const folder = 'r-push-user-deny';
    mockAclFile({
      owner: 'operator',
      allowed: {
        'console:sender': { '*': 'io' },
        // No grant for u:alice — they're a stranger to this agent.
      },
      reject_message: null,
    }, folder);
    const deps = makeDeps(folder);

    await handleBusMessage(deps, 'console:sender', deps.agentId, {
      type: 'push',
      text: 'hi',
      requestId: 'req-push-3',
      returnToParticipant: 'u:alice@idp',
      returnToChannel: 'origin',
      routing: { channel: 'default' },
    });

    expect(deps.calls.route).toBe(0);
    // Originating-user denial also routes a rejection back to the sender.
    expect(deps.calls.rejection).toBe(1);
  });

  // --- Agent-sender push ---
  // For an agent sender (a pure conduit that cannot hold `i`/`o`), gate 2 reads
  // the originating USER's `i`, not the sending agent's bits (the host
  // bit `h` folded into `i`). The agent's own grant is irrelevant to host
  // authorization. Console/user senders (covered above) hold `io` themselves.

  it('allows agent-sent push when the originating user holds `io` (sender absent from ACL)', async () => {
    // The discriminating case: the old code read the sending agent's bits at
    // gate 2 (absent → deny). The re-key reads the user (`io` → allow). The
    // sending agent holds nothing — it is a pure conduit.
    const folder = 'r-agent-push-allow';
    mockAclFile({
      owner: 'operator',
      allowed: { 'u:alice@idp': { 'default': 'io' } },
      reject_message: null,
    }, folder);
    const deps = makeDeps(folder);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'push',
      text: 'handing alice over',
      requestId: 'req-agent-1',
      returnToParticipant: 'u:alice@idp',
      returnToChannel: 'origin',
      routing: { channel: 'default' },
    });

    expect(deps.calls.route).toBe(1);
    expect(deps.calls.rejection).toBe(0);
  });

  it('allows agent-sent push regardless of the sending agent\'s own bits', async () => {
    // Same verdict as above with the sender carrying its full legal grant
    // (`qra`) — proof the sending agent's bits never affect host authorization.
    const folder = 'r-agent-push-sender-irrelevant';
    mockAclFile({
      owner: 'operator',
      allowed: {
        'a:sender@srv': { 'default': 'qra' },
        'u:alice@idp': { 'default': 'io' },
      },
      reject_message: null,
    }, folder);
    const deps = makeDeps(folder);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'push',
      text: 'handing alice over',
      requestId: 'req-agent-2',
      returnToParticipant: 'u:alice@idp',
      returnToChannel: 'origin',
      routing: { channel: 'default' },
    });

    expect(deps.calls.route).toBe(1);
    expect(deps.calls.rejection).toBe(0);
  });

  // Post-fold: gate 2's host bit `h` folded into `i`, so a user with `io` (a
  // member) is now pushable — the old "io is not enough without h" deny is
  // exactly what the fold removes (covered positively above, where the
  // formerly-`ioh` fixtures are now `io`). The remaining deny is non-membership:
  // gate 3 reads `membershipBits` (no `*` expansion, no god-mode), so a
  // wildcard-only grant passes gate 2 (`checkAcl` expands `*`) yet is blocked at
  // gate 3 as a member of nothing.
  it('denies agent-sent push when the originating user is not a concrete member (wildcard grant: gate 3)', async () => {
    const folder = 'r-agent-push-non-member';
    mockAclFile({
      owner: 'operator',
      allowed: { 'u:alice@idp': { '*': 'io' } },
      reject_message: null,
    }, folder);
    const deps = makeDeps(folder);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'push',
      text: 'handing alice over',
      requestId: 'req-agent-4',
      returnToParticipant: 'u:alice@idp',
      returnToChannel: 'origin',
      routing: { channel: 'default' },
    });

    expect(deps.calls.route).toBe(0);
    expect(deps.calls.rejection).toBe(1);
  });

  it('denies agent-sent push carrying the OPERATOR with no concrete placement (god-mode is not membership)', async () => {
    // The conduit hole this gate closes: a relaying/compromised agent names the
    // operator as the originating user. `checkAcl` god-modes the operator to
    // full bits on every channel, so gate 2 (`i`) passes — but gate 3 reads
    // `membershipBits`, which treats the operator tier as a member of nothing.
    // With no concrete placement the push is refused, so an agent cannot puppet
    // the operator's reach into a channel the operator never joined. (Before the
    // membershipBits gate, gate 3's checkAcl god-moded the operator → allow.)
    const folder = 'r-agent-push-operator-no-placement';
    mockAclFile({
      owner: 'operator',
      allowed: {}, // operator carries no disk grant; it god-modes checkAcl only
      reject_message: null,
    }, folder);
    const deps = makeDeps(folder);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'push',
      text: 'handing the operator over',
      requestId: 'req-agent-operator-deny',
      returnToParticipant: 'admin:local',
      returnToChannel: 'origin',
      routing: { channel: 'default' },
    });

    expect(deps.calls.route).toBe(0);
    expect(deps.calls.rejection).toBe(1);
  });

  it('allows agent-sent push carrying the operator when the operator IS concretely placed', async () => {
    // The fix is consistency, not a blanket operator ban: an explicit
    // per-channel placement (the "explicit in the right places" model the
    // console managers already follow) restores the ferry. membershipBits reads
    // the concrete `io`, so gate 3 passes.
    const folder = 'r-agent-push-operator-placed';
    mockAclFile({
      owner: 'operator',
      allowed: { 'admin:local': { 'default': 'io' } },
      reject_message: null,
    }, folder);
    const deps = makeDeps(folder);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'push',
      text: 'handing the operator over',
      requestId: 'req-agent-operator-allow',
      returnToParticipant: 'admin:local',
      returnToChannel: 'origin',
      routing: { channel: 'default' },
    });

    expect(deps.calls.route).toBe(1);
    expect(deps.calls.rejection).toBe(0);
  });

  // Removed: "denies push when replyTo is missing (malformed payload)".
  // With the `type: 'push'` schema, `returnToParticipant` is required —
  // a payload without it fails at Zod parse, not at the ACL gate.

  // Removed (post-fold): "denies conversation when sender has only `h` (push
  // grant alone is not a conversation grant)". Post-fold there is no push grant
  // distinct from a conversation grant — `h` folded into `i`, so push *is* `io`
  // conversation. The premise no longer exists.

  it('defaults missing intent to conversation (Zod default)', async () => {
    const folder = 'r-default-conv';
    mockAclFile({ owner: 'operator', allowed: { 'console:sender': { '*': 'io' } }, reject_message: null }, folder);
    const deps = makeDeps(folder);

    await handleBusMessage(deps, 'console:sender', deps.agentId, {
      type: 'message',
      text: 'hi',
      routing: { channel: 'default' }, // no intent — Zod fills 'conversation'
    });

    expect(deps.calls.route).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Push receiver-side ACCESS — reactive `io` gate for an agent-conduit push.
// The carried user's CONCRETE placement is three-state: granted (concrete
// member) → host; askable (acl.json, no placement, no tombstone) → raise an `io`
// approval to the destination owner + held-notice over the rejection rail;
// rejected (tombstone) → hard deny, never asked. Mirrors the q/r inbound gate, on
// the carried user's `i`.
// ---------------------------------------------------------------------------

describe('handleBusMessage — push receiver-side access flip (2B.6)', () => {
  const ALICE = 'u:alice@idp';
  const pushFrom = async (deps: ReturnType<typeof makeDeps>, reqId = 'req-rx') =>
    handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'push', text: 'handing alice over', requestId: reqId,
      returnToParticipant: ALICE, returnToChannel: 'origin',
      routing: { channel: 'default' },
    });

  it('askable carried user raises an owner `io` approval + held-notice, push not delivered', async () => {
    mockAclFile({ owner: 'u:owner@iss', allowed: {} }, 'rx-askable');
    const deps = makeDeps('rx-askable');
    await pushFrom(deps);
    expect(deps.calls.route).toBe(0);                          // held, not delivered
    expect(deps.approvals.createCount).toBe(1);               // owner approval raised
    expect(deps.approvals.lastSummary).toContain('wants to bring');
    expect(deps.approvals.lastPayload).toContain('"bit":"io"'); // conversant grant
    expect(deps.approvals.lastPayload).toContain('"carry":"push"'); // push-delivery carry
    expect(deps.calls.rejection).toBe(1);                      // held-notice to the conduit
  });

  it('a tombstoned carried user is hard-denied, never asked', async () => {
    mockAclFile({ owner: 'u:owner@iss', allowed: {}, rejected: { [ALICE]: { default: 'i' } } }, 'rx-tomb');
    const deps = makeDeps('rx-tomb');
    await pushFrom(deps);
    expect(deps.approvals.createCount).toBe(0);               // no approval
    expect(deps.calls.route).toBe(0);
    expect(deps.calls.rejection).toBe(1);                     // hard-deny back to sender
  });

  it('a duplicate while one is pending informs once, no second approval', async () => {
    mockAclFile({ owner: 'u:owner@iss', allowed: {} }, 'rx-dup');
    const deps = makeDeps('rx-dup');
    deps.approvals.pendingId = 'ap-push-1';                    // a decision is in flight
    await pushFrom(deps, 'req-dup-1');
    expect(deps.approvals.createCount).toBe(0);               // no second approval
    expect(deps.calls.rejection).toBe(1);                     // informed once
  });

  it('deliverHeldPush replays the push (resume on grant)', () => {
    const deps = makeDeps('rx-resume');
    deliverHeldPush(deps, {
      carry: 'push', to: deps.agentId, from: 'a:sender@srv', text: 'hi',
      channel: 'default', requestId: 'req-resume', returnToParticipant: ALICE,
      returnToChannel: 'origin', routing: { channel: 'default' },
    });
    expect(deps.calls.route).toBe(1);
    expect(deps.routeArgs[0]!.kind).toBe('push');              // re-delivered on the push tier
  });

  it('rejectHeldPush routes a rejection back to the conduit (resume on decline)', () => {
    const deps = makeDeps('rx-resume-reject');
    rejectHeldPush(deps, {
      carry: 'push', to: deps.agentId, from: 'a:sender@srv', text: 'hi',
      channel: 'default', requestId: 'req-resume-rej', returnToParticipant: ALICE,
      returnToChannel: 'origin', routing: { channel: 'default' },
    }, 'Owner declined.');
    expect(deps.calls.rejection).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// First-contact user message flip (single-store reactive gate).
// A stranger (u:) with no grant used to hard-deny with "Not authorized." Now the
// non-agent deny path is three-state: askable → raise an owner-directed acl-edge
// approval and hold the message; rejected → the hard deny it always was. Only
// people (u:) trigger the flip — consoles/services keep the plain deny.
// ---------------------------------------------------------------------------

describe('handleBusMessage — first-contact user message flip', () => {
  const USER = 'u:stranger@iss';

  it('a stranger with no grant raises an owner approval (grant io) + a pending notice, message not delivered', async () => {
    mockAclFile({ owner: 'u:owner@iss', allowed: {} }, 'fc-askable');
    const deps = makeDeps('fc-askable');
    await handleBusMessage(deps, USER, deps.agentId, { type: 'message', text: 'hi', routing: { channel: 'default' } });
    expect(deps.calls.route).toBe(0);                        // held, not delivered
    expect(deps.approvals.createCount).toBe(1);              // owner approval raised
    expect(deps.approvals.lastSummary).toContain('wants to message');
    expect(deps.approvals.lastPayload).toContain('"bit":"io"'); // two-way conversation grant
    expect(deps.replies.some((r) => /reference \d{4}/.test(r))).toBe(true); // pending notice w/ ref
  });

  it('the correlation ref matches between the owner approval and the held-notice', async () => {
    mockAclFile({ owner: 'u:owner@iss', allowed: {} }, 'fc-ref');
    const deps = makeDeps('fc-ref');
    await handleBusMessage(deps, USER, deps.agentId, { type: 'message', text: 'hi', routing: { channel: 'default' } });
    const summaryRef = deps.approvals.lastSummary?.match(/ref (\d{4})/)?.[1];
    const noticeRef = deps.replies.join(' ').match(/reference (\d{4})/)?.[1];
    expect(summaryRef).toBeDefined();
    expect(noticeRef).toBe(summaryRef);
  });

  it('a duplicate while one is pending informs once, then blackholes (no second approval)', async () => {
    mockAclFile({ owner: 'u:owner@iss', allowed: {} }, 'fc-dup');
    const deps = makeDeps('fc-dup');
    deps.approvals.pendingId = 'ap-1';                       // a decision is already in flight
    await handleBusMessage(deps, USER, deps.agentId, { type: 'message', text: 'again', routing: { channel: 'default' } });
    expect(deps.approvals.createCount).toBe(0);              // no second approval
    expect(deps.replies.some((r) => /already have a request pending/i.test(r))).toBe(true);
    expect(deps.calls.rejected).toBe(1);                     // informed once
    await handleBusMessage(deps, USER, deps.agentId, { type: 'message', text: 'again2', routing: { channel: 'default' } });
    expect(deps.calls.rejected).toBe(1);                     // 2nd dup is silent
  });

  it('a tombstoned stranger is hard-denied, never asked', async () => {
    mockAclFile({ owner: 'u:owner@iss', allowed: {}, rejected: { [USER]: { default: 'i' } } }, 'fc-rejected');
    const deps = makeDeps('fc-rejected');
    await handleBusMessage(deps, USER, deps.agentId, { type: 'message', text: 'hi', routing: { channel: 'default' } });
    expect(deps.approvals.createCount).toBe(0);              // no approval
    expect(deps.calls.route).toBe(0);
    expect(deps.calls.rejected).toBe(1);                     // hard-deny reply (once)
  });

  it('a console sender with no conversation grant is plainly denied, never asked', async () => {
    // `a` (answerer) is a non-conversation grant — no `i`, so message delivery
    // is denied; consoles never bootstrap via owner approval (not a `u:` sender).
    mockAclFile({ owner: 'operator', allowed: { 'console:x': { '*': 'a' } } }, 'fc-console');
    const deps = makeDeps('fc-console');
    await handleBusMessage(deps, 'console:x', deps.agentId, { type: 'message', text: 'hi', routing: { channel: 'default' } });
    expect(deps.approvals.createCount).toBe(0);              // consoles don't bootstrap via owner approval
    expect(deps.calls.route).toBe(0);
  });

  it('deliverHeldMessage replays the held message into the conversation (resume on grant)', () => {
    const deps = makeDeps('fc-resume');
    deliverHeldMessage(deps, { msgType: 'message', from: USER, to: deps.agentId, text: 'hi', channel: 'default', routing: { channel: 'default' } });
    expect(deps.calls.route).toBe(1);
  });

  it('rejectHeldMessage notifies the user of the owner decline', () => {
    const deps = makeDeps('fc-resume-reject');
    rejectHeldMessage(deps, { msgType: 'message', from: USER, to: deps.agentId, text: 'hi', channel: 'default' }, 'No thanks.');
    expect(deps.replies.some((r) => /No thanks/.test(r))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Carried-principal — origin-keyed inbound request (two-axis access, R1.1+R1.2).
// A `<cast:query>`/`<cast:request>` relayed by an agent is gated and cell-keyed
// on the carried ORIGIN (`returnToParticipant`), never the relay sender. The
// access axis binds to the origin so "Alice cannot reach Y" holds on every path
// (the confused-deputy fix); the cell lands in the origin's own square so a
// multi-origin cell can never form. `gateInbound('request')` checks the `a` bit
// against the origin's grant.
// ---------------------------------------------------------------------------

function makeInboundReqDeps(folder: string): BusHandlerDeps & {
  recorded: Array<{ participant: string; fromAgent: string; channel: string }>;
  routeRoutings: unknown[];
  calls: { route: number; rejection: number; pending: number; aclEdge: number };
  setPendingAclEdge: (id: string | null) => void;
  captured: { approvalSummary: string | null; rejectionReason: string | null; pendingReason: string | null };
} {
  const recorded: Array<{ participant: string; fromAgent: string; channel: string }> = [];
  const routeRoutings: unknown[] = [];
  const calls = { route: 0, rejection: 0, pending: 0, aclEdge: 0 };
  // Last owner-side approval summary + last requester-side notice reason (split
  // by outcome rail) — for asserting the correlation code surfaces on both
  // sides. A terminal deny rides `rejection`; an askable hold rides the
  // non-terminal `pending`.
  const captured: { approvalSummary: string | null; rejectionReason: string | null; pendingReason: string | null } =
    { approvalSummary: null, rejectionReason: null, pendingReason: null };
  // Mutable so a test can simulate "a decision for this edge is already in flight."
  let pendingAclEdgeId: string | null = null;
  const bus = makeBus();
  const originalRouteMessage = bus.routeMessage.bind(bus);
  bus.routeMessage = async (from, to, payload) => {
    const type = (payload as { type?: unknown } | null)?.type;
    if (typeof payload === 'object' && payload !== null && type === 'rejection') {
      calls.rejection += 1;
      captured.rejectionReason = (payload as { reason?: string }).reason ?? null;
      return;
    }
    if (typeof payload === 'object' && payload !== null && type === 'pending') {
      calls.pending += 1;
      captured.pendingReason = (payload as { reason?: string }).reason ?? null;
      return;
    }
    return originalRouteMessage(from, to, payload);
  };
  return {
    agentId: 'a:test-receiver@srv',
    folder,
    bus,
    // @ts-expect-error — only recordInboundRequest + logEvent are exercised here.
    agentDb: {
      recordInboundRequest: vi.fn((data: { participant: string; fromAgent: string; channel: string }) => {
        recorded.push({ participant: data.participant, fromAgent: data.fromAgent, channel: data.channel });
      }),
      logEvent: vi.fn(),
    },
    idp: undefined,
    getApprovals: () => ({
      createRequest: vi.fn((data: { type?: string; summary?: string }) => {
        if (data.type === 'acl-edge') calls.aclEdge += 1;
        captured.approvalSummary = data.summary ?? null;
        return 'approval-id';
      }),
      pendingAclEdge: () => pendingAclEdgeId,
    } as never),
    getTimezone: () => 'UTC',
    isDraft: () => false,
    route: vi.fn(async (_addr: string, _sender: string, _text: string, routing?: unknown) => {
      calls.route += 1;
      routeRoutings.push(routing);
      return { ok: true as const, result: null };
    }),
    recorded,
    routeRoutings,
    calls,
    setPendingAclEdge: (id: string | null) => { pendingAclEdgeId = id; },
    captured,
  };
}

function targetOf(routing: unknown): string | undefined {
  return (routing as { targetParticipant?: string }).targetParticipant;
}

describe('handleBusMessage — carried-principal origin-keyed inbound request', () => {
  it('keys a carried query on the origin (returnToParticipant), not the relay', async () => {
    // Only the ORIGIN (alice) holds `a`; the relay holds nothing. The query
    // flows because access binds to the carried origin, and both the recorded
    // cell participant and the routed cell key are alice — not the relay.
    const folder = 'carried-origin-key';
    mockAclFile({
      owner: 'operator',
      allowed: { 'u:alice@idp': { 'default': 'a' } },
      reject_message: null,
    }, folder);
    const deps = makeInboundReqDeps(folder);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'request',
      kind: 'query',
      requestId: 'req-c1',
      text: "on alice's behalf",
      channel: 'default',
      returnToAgent: 'a:sender@srv',
      returnToChannel: 'origin',
      returnToParticipant: 'u:alice@idp',
      upstreamSet: [],
    });

    expect(deps.calls.route).toBe(1);
    expect(deps.calls.rejection).toBe(0);
    expect(deps.recorded[0]!.participant).toBe('u:alice@idp');
    // The relay stays recorded as `from_agent` — the cycle detector keys on it.
    expect(deps.recorded[0]!.fromAgent).toBe('a:sender@srv');
    expect(targetOf(deps.routeRoutings[0])).toBe('u:alice@idp');
  });

  it('does not lend the relay grant to a carried origin — holds the ungranted origin for owner approval (confused deputy)', async () => {
    // The RELAY holds `a`; the carried origin (alice) holds nothing. Pre-fix
    // the gate keyed on the relay → would have ALLOWED, lending the relay's
    // reach to whatever principal it carries. Origin-keyed → alice is evaluated
    // on her own: ungranted but *askable* (acl.json exists, no tombstone), so
    // the request is held and an owner-directed acl-edge approval is raised. The
    // privilege-lending property holds — alice is never delivered (route=0), the
    // relay's grant buys her nothing.
    const folder = 'carried-confused-deputy';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': 'a' } },
      reject_message: null,
    }, folder);
    const deps = makeInboundReqDeps(folder);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'request',
      kind: 'query',
      requestId: 'req-cd',
      text: 'smuggling alice in',
      channel: 'default',
      returnToAgent: 'a:sender@srv',
      returnToChannel: 'origin',
      returnToParticipant: 'u:alice@idp',
      upstreamSet: [],
    });

    expect(deps.calls.route).toBe(0);
    expect(deps.calls.pending).toBe(1); // non-terminal pending notice tells the sender it's parked
    expect(deps.calls.aclEdge).toBe(1);
  });

  it('an ungranted-but-askable origin raises an acl-edge approval, not a silent reject', async () => {
    // No grant, no tombstone — the canonical askable edge. The gate holds the
    // request and asks the owner instead of dropping it.
    const folder = 'carried-askable';
    mockAclFile({ owner: 'operator', allowed: {}, reject_message: null }, folder);
    const deps = makeInboundReqDeps(folder);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'request', kind: 'query', requestId: 'req-ask',
      text: 'may I reach you', channel: 'default',
      returnToAgent: 'a:sender@srv', returnToChannel: 'origin',
      returnToParticipant: 'u:alice@idp', upstreamSet: [],
    });

    expect(deps.calls.route).toBe(0);
    expect(deps.calls.pending).toBe(1); // non-terminal pending notice tells the sender it's parked
    expect(deps.calls.aclEdge).toBe(1);
  });

  it('an explicit reject tombstone hard-denies — no approval raised (rejected, not askable)', async () => {
    // alice is tombstoned on `default`: the operator has spoken, so aclVerdict is
    // 'rejected' — a hard no that rejects rather than asking the owner. This is
    // the security-critical half of the three-state split.
    const folder = 'carried-tombstoned';
    mockAclFile({
      owner: 'operator',
      allowed: {},
      rejected: { 'u:alice@idp': { 'default': 'a' } },
      reject_message: null,
    }, folder);
    const deps = makeInboundReqDeps(folder);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'request', kind: 'query', requestId: 'req-tomb',
      text: 'tombstoned', channel: 'default',
      returnToAgent: 'a:sender@srv', returnToChannel: 'origin',
      returnToParticipant: 'u:alice@idp', upstreamSet: [],
    });

    expect(deps.calls.route).toBe(0);
    expect(deps.calls.rejection).toBe(1);
    expect(deps.calls.aclEdge).toBe(0);
  });

  it('surfaces one correlation code on both the owner approval and the requester held-notice', async () => {
    // The disambiguation join-key: the owner sees a `ref NNNN` on
    // the approval, the requester gets the SAME `reference NNNN` in the pending
    // notice, so the owner can recognize which human is asking.
    const folder = 'carried-askable-ref';
    mockAclFile({ owner: 'operator', allowed: {}, reject_message: null }, folder);
    const deps = makeInboundReqDeps(folder);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'request', kind: 'query', requestId: 'req-ref',
      text: 'may I reach you', channel: 'default',
      returnToAgent: 'a:sender@srv', returnToChannel: 'origin',
      returnToParticipant: 'u:alice@idp', upstreamSet: [],
    });

    const ownerRef = deps.captured.approvalSummary?.match(/\bref (\d{4})\b/)?.[1];
    const reqRef = deps.captured.pendingReason?.match(/\breference (\d{4})\b/)?.[1];
    expect(ownerRef).toMatch(/^\d{4}$/);
    expect(reqRef).toBe(ownerRef); // same join-key on both sides
  });

  it('dedups a duplicate askable inbound — one approval per edge, an "already pending" notice, no second approval', async () => {
    // A decision for this edge is already in flight (pendingAclEdge returns an
    // id). The owner decides the edge, not each message, and on grant only the
    // first held request is released — so a second inbound must NOT raise a
    // second approval. The sender is told once it's already pending.
    const folder = 'carried-askable-dup';
    mockAclFile({ owner: 'operator', allowed: {}, reject_message: null }, folder);
    const deps = makeInboundReqDeps(folder);
    deps.setPendingAclEdge('pid-1');

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'request', kind: 'query', requestId: 'req-dup1',
      text: 'again', channel: 'default',
      returnToAgent: 'a:sender@srv', returnToChannel: 'origin',
      returnToParticipant: 'u:alice@idp', upstreamSet: [],
    });

    expect(deps.calls.aclEdge).toBe(0); // no second approval for the same edge
    expect(deps.calls.route).toBe(0);   // not delivered
    expect(deps.calls.rejection).toBe(1); // told it's already pending
  });

  it('blackholes a second duplicate askable inbound — informs once, then silence', async () => {
    // The graduated response: first duplicate gets "already pending", subsequent
    // duplicates get nothing, so a retry loop can't keep eliciting replies.
    const folder = 'carried-askable-dup2';
    mockAclFile({ owner: 'operator', allowed: {}, reject_message: null }, folder);
    const deps = makeInboundReqDeps(folder);
    deps.setPendingAclEdge('pid-2');

    for (const reqId of ['dup-a', 'dup-b']) {
      await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
        type: 'request', kind: 'query', requestId: reqId,
        text: 'spam', channel: 'default',
        returnToAgent: 'a:sender@srv', returnToChannel: 'origin',
        returnToParticipant: 'u:alice@idp', upstreamSet: [],
      });
    }

    expect(deps.calls.aclEdge).toBe(0);
    expect(deps.calls.rejection).toBe(1); // first dup informed, second blackholed
  });

  it('blackholes a hammering rejected sender — bounces the reason once, then silence', async () => {
    // The reject path mirrors the askable graduation: a standing tombstone
    // bounces the deny reason at most once per window, then goes silent.
    const folder = 'carried-tombstoned-spam';
    mockAclFile({
      owner: 'operator',
      allowed: {},
      rejected: { 'u:alice@idp': { 'default': 'a' } },
      reject_message: null,
    }, folder);
    const deps = makeInboundReqDeps(folder);

    for (const reqId of ['t-a', 't-b', 't-c']) {
      await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
        type: 'request', kind: 'query', requestId: reqId,
        text: 'denied', channel: 'default',
        returnToAgent: 'a:sender@srv', returnToChannel: 'origin',
        returnToParticipant: 'u:alice@idp', upstreamSet: [],
      });
    }

    expect(deps.calls.aclEdge).toBe(0);
    expect(deps.calls.route).toBe(0);
    expect(deps.calls.rejection).toBe(1); // one bounce, then blackhole
  });

  it('fans two origins through one relay into two distinct cells (no multi-origin aggregation)', async () => {
    const folder = 'carried-fan-in';
    mockAclFile({
      owner: 'operator',
      allowed: {
        'u:alice@idp': { 'default': 'a' },
        'u:bob@idp': { 'default': 'a' },
      },
      reject_message: null,
    }, folder);
    const deps = makeInboundReqDeps(folder);

    for (const [participant, reqId] of [
      ['u:alice@idp', 'req-a'],
      ['u:bob@idp', 'req-b'],
    ] as const) {
      await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
        type: 'request',
        kind: 'query',
        requestId: reqId,
        text: 'q',
        channel: 'default',
        returnToAgent: 'a:sender@srv',
        returnToChannel: 'origin',
        returnToParticipant: participant,
        upstreamSet: [],
      });
    }

    expect(deps.calls.route).toBe(2);
    expect(deps.recorded.map((r) => r.participant)).toEqual(['u:alice@idp', 'u:bob@idp']);
    expect(deps.routeRoutings.map(targetOf)).toEqual(['u:alice@idp', 'u:bob@idp']);
  });

  it('keys a self-originated agent query on the agent itself (origin == relay)', async () => {
    // A self-fire (scheduled/service/watch): the agent is its own origin, so
    // `returnToParticipant == from`. Access gates on `reach(agent, channel)`
    // and the cell keys on the agent — the as-self case is just the carried
    // model with the two identities coincident.
    const folder = 'carried-self-origin';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': 'a' } },
      reject_message: null,
    }, folder);
    const deps = makeInboundReqDeps(folder);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'request',
      kind: 'query',
      requestId: 'req-self',
      text: 'peer question',
      channel: 'default',
      returnToAgent: 'a:sender@srv',
      returnToChannel: 'peer',
      returnToParticipant: 'a:sender@srv',
      upstreamSet: [],
    });

    expect(deps.calls.route).toBe(1);
    expect(deps.recorded[0]!.participant).toBe('a:sender@srv');
    expect(targetOf(deps.routeRoutings[0])).toBe('a:sender@srv');
  });
});

describe('handleBusMessage — draft-mode auto-reply', () => {
  it('bounces external message with draft reply and skips route()', async () => {
    // Even with a valid `io` grant the message must not reach route() while
    // the agent is in draft. The bounce uses the conversation reply path so
    // the sender sees a human-readable explanation rather than silence.
    const folder = 'd-msg-bounce';
    mockAclFile({ owner: 'operator', allowed: { 'u:sender@srv': { '*': 'io' } }, reject_message: null }, folder);
    const deps = makeDeps(folder, { draft: true });

    await handleBusMessage(deps, 'u:sender@srv', deps.agentId, {
      type: 'message',
      text: 'hi',
      routing: { channel: 'default' },
    });

    expect(deps.calls.route).toBe(0);
    expect(deps.calls.rejected).toBe(1);
  });

  it('lets operator (admin:*) traffic through while draft', async () => {
    // Draft is a "not ready for the world" signal, not a kill switch — the
    // operator must still be able to exercise the agent during composition.
    const folder = 'd-admin-bypass';
    mockAclFile({ owner: 'operator', allowed: { 'admin:local': { '*': 'io' } }, reject_message: null }, folder);
    const deps = makeDeps(folder, { draft: true });

    await handleBusMessage(deps, 'admin:local', deps.agentId, {
      type: 'message',
      text: 'hi',
      routing: { channel: 'default' },
    });

    // No draft bounce; ACL passes and the message reaches route().
    expect(deps.calls.rejected).toBe(0);
    expect(deps.calls.route).toBe(1);
  });

  it('bounces inbound request with rejection when draft', async () => {
    // Q/A requests are answer-expected — the sender's prompt is waiting on a
    // reply. Silent drop would hang; we issue a typed rejection instead.
    // Agent senders carry `q` legitimately under the agent-identity bit
    // restriction; we drop the i/o bits this test never relied on.
    const folder = 'd-req-bounce';
    mockAclFile({ owner: 'operator', allowed: { 'a:sender@srv': { '*': 'q' } }, reject_message: null }, folder);
    const deps = makeDeps(folder, { draft: true });

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'request',
      requestId: 'req-1',
      text: 'q?',
      channel: 'default',
      returnToAgent: 'a:sender@srv',
      returnToChannel: 'default',
      returnToParticipant: 'u:alice@idp',
      upstreamSet: [],
    });

    expect(deps.calls.route).toBe(0);
    expect(deps.calls.rejection).toBe(1);
  });

  it('lets Design Manager (console:design-manager) reach a draft agent', async () => {
    // The whole point of draft is "compose the agent" — and Design Manager
    // is the tool that composes. Bouncing its pushes makes the very tool
    // meant for drafts unusable on drafts. Authoring envelope includes
    // operator + `console:*` (see isAuthoringSender); every `console:*`
    // manager (Config Manager included) rides this same arm.
    const folder = 'd-design-manager-bypass';
    mockAclFile({
      owner: 'operator',
      allowed: { 'console:design-manager': { '__design': 'io' } },
      reject_message: null,
    }, folder);
    const deps = makeDeps(folder, { draft: true });

    await handleBusMessage(deps, 'console:design-manager', deps.agentId, {
      type: 'push',
      text: 'brief',
      requestId: 'req-dm-1',
      returnToParticipant: 'admin:local',
      returnToChannel: '__design-manager',
      routing: { channel: '__design' },
    });

    expect(deps.calls.rejection).toBe(0);
    expect(deps.calls.route).toBe(1);
  });

  it('still bounces peer agents at draft (regression guard for envelope boundary)', async () => {
    // Authoring envelope widening must NOT pull peer agents in. A sibling
    // agent reaching a draft is exactly the cross-wiring that should only
    // be exercised post-finalize.
    // The agent-identity bit restriction means peer agents can carry only q/r/a;
    // we use `q` here so the ACL parses and the test exercises the draft-bounce
    // path rather than failing at the schema layer.
    const folder = 'd-peer-still-bounced';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sibling@srv': { 'default': 'q' } },
      reject_message: null,
    }, folder);
    const deps = makeDeps(folder, { draft: true });

    await handleBusMessage(deps, 'a:sibling@srv', deps.agentId, {
      type: 'message',
      text: 'hello',
      routing: { channel: 'default' },
    });

    expect(deps.calls.route).toBe(0);
    expect(deps.calls.rejected).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reply delivery is capability redemption, not a standing-edge re-check: the
// open outbound row is the round-trip authorization the query was emitted under,
// and the answer redeems it. The recorded `kind` is what the capability may
// redeem — a `query` redeems one answer; a fire-and-forget `request` redeems
// only a bounce (rejection), never an answer (the r-bit anti-injection promise).
// ---------------------------------------------------------------------------

function makeReplyDeps(
  folder: string,
  outboundRow: { target_agent: string; target_channel: string; status: string; kind?: 'query' | 'request' } | undefined,
): BusHandlerDeps & {
  calls: { route: number };
  routeTexts: string[];
  statusUpdates: Array<{ table: string; status: string }>;
} {
  const calls = { route: 0 };
  const routeTexts: string[] = [];
  const statusUpdates: Array<{ table: string; status: string }> = [];
  const bus = makeBus();
  const fullRow = outboundRow
    ? {
        request_id: 'req-1',
        target_agent: outboundRow.target_agent,
        target_channel: outboundRow.target_channel,
        channel: 'origin',
        participant: 'u:alice@idp',
        status: outboundRow.status,
        kind: outboundRow.kind ?? 'query',
        created_at: '2026-05-12T00:00:00Z',
      }
    : undefined;
  return {
    agentId: 'a:test-receiver@srv',
    folder,
    bus,
    // @ts-expect-error — only the request-lookup methods are exercised here.
    agentDb: {
      getOutboundRequest: vi.fn(() => fullRow),
      updateRequestStatus: vi.fn((table: string, _id: string, status: string) => {
        statusUpdates.push({ table, status });
      }),
      logEvent: vi.fn(),
    },
    idp: undefined,
    getApprovals: () => ({} as never),
    getTimezone: () => 'UTC',
    isDraft: () => false,
    route: vi.fn(async (_addr: string, _sender: string, text: string) => {
      calls.route += 1;
      routeTexts.push(text);
      return { ok: true as const, result: null };
    }),
    calls,
    routeTexts,
    statusUpdates,
  };
}

describe('handleBusMessage — q/r split on reply delivery', () => {
  const outboundRow = { target_agent: 'a:sender@srv', target_channel: 'default', status: 'open' };

  it('delivers response when sender holds `q` on target channel', async () => {
    const folder = 'rq-deliver';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': 'q' } },
      reject_message: null,
    }, folder);
    const deps = makeReplyDeps(folder, outboundRow);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'response',
      requestId: 'req-1',
      text: 'answer payload',
      originChannel: 'default',
      originParticipant: 'u:alice@idp',
    });

    expect(deps.calls.route).toBe(1);
    expect(deps.statusUpdates).toEqual([{ table: 'outbound', status: 'fulfilled' }]);
  });

  it('delivers an allow-once query answer with no standing grant (the once-q fix)', async () => {
    // The headline fix. A query approved allow-once persists no `q` grant, yet
    // its answer must come back. The open row is the capability the once-approval
    // minted; the answer redeems it. Pre-fix this blackholed on the absent `q`.
    const folder = 'rq-once-no-grant';
    mockAclFile({ owner: 'operator', allowed: {}, reject_message: null }, folder);
    const deps = makeReplyDeps(folder, outboundRow); // kind defaults to 'query'

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'response',
      requestId: 'req-1',
      text: 'the secret',
      originChannel: 'default',
      originParticipant: 'u:alice@idp',
    });

    expect(deps.calls.route).toBe(1);
    expect(deps.statusUpdates).toEqual([{ table: 'outbound', status: 'fulfilled' }]);
  });

  it('still delivers a query answer after the standing grant is emptied (capability, not standing bit)', async () => {
    // Sender held `q` at send; the operator emptied the bits before the reply.
    // The open row is the round-trip authorization the query was emitted under,
    // so the answer redeems it regardless of the now-empty edge. Revoking an
    // in-flight request is explicit (close it → the status guard drops the late
    // answer), not a silent standing-bit re-check.
    const folder = 'rq-emptied';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': '' } },
      reject_message: null,
    }, folder);
    const deps = makeReplyDeps(folder, outboundRow);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'response',
      requestId: 'req-1',
      text: 'answer payload',
      originChannel: 'default',
      originParticipant: 'u:alice@idp',
    });

    expect(deps.calls.route).toBe(1);
    expect(deps.statusUpdates).toEqual([{ table: 'outbound', status: 'fulfilled' }]);
  });

  it('drops a late answer for a closed request (revoke by close)', async () => {
    // The explicit revocation rail: close the request, and the open-row guard
    // drops any answer that arrives after — without touching the row again.
    const folder = 'rq-closed';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': 'q' } },
      reject_message: null,
    }, folder);
    const deps = makeReplyDeps(folder, { ...outboundRow, status: 'closed' });

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'response',
      requestId: 'req-1',
      text: 'too late',
      originChannel: 'default',
      originParticipant: 'u:alice@idp',
    });

    expect(deps.calls.route).toBe(0);
    expect(deps.statusUpdates).toEqual([]);
  });

  it('drops a stray answer to a fire-and-forget request, leaving the row open (r-bit anti-injection)', async () => {
    // A `request` authorized no answer into the sender's session. If a misbehaving
    // peer emits one anyway, the recorded `kind` drops it — the capability redeems
    // only a bounce, never an answer — and the row is left untouched (not
    // "fulfilled" by an answer it never wanted). The grant string is irrelevant.
    const folder = 'rq-stray-answer';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': 'r' } },
      reject_message: null,
    }, folder);
    const deps = makeReplyDeps(folder, { ...outboundRow, kind: 'request' as const });

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'response',
      requestId: 'req-1',
      text: 'answer payload',
      originChannel: 'default',
      originParticipant: 'u:alice@idp',
    });

    expect(deps.calls.route).toBe(0);
    expect(deps.statusUpdates).toEqual([]); // never authorized an answer — not fulfilled
  });

  it('delivers a pending notice as a <cast:pending> tag and never transitions the row', async () => {
    // The crux of the q/a-answer-orphaned fix: a held query's pending notice is
    // non-terminal. It must reach the sender (so it stops resending) WITHOUT
    // closing the outbound row — otherwise the owner-approved <cast:answer>,
    // which returns on this same requestId, has no open row to land on.
    const folder = 'rq-pending-deliver';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': 'q' } },
      reject_message: null,
    }, folder);
    const deps = makeReplyDeps(folder, outboundRow);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'pending',
      requestId: 'req-1',
      reason: "Your request is pending the owner's approval (reference 0420). You'll get a reply once it's decided. Please don't resend.",
      originChannel: 'default',
      originParticipant: 'u:alice@idp',
    });

    expect(deps.calls.route).toBe(1);
    expect(deps.statusUpdates).toEqual([]); // non-terminal — the row stays `open`
    const text = deps.routeTexts[0];
    expect(text).toContain('&lt;cast:pending');
    expect(text).toContain('from=&quot;a:sender@srv&quot;');
    expect(text).toContain('request=&quot;req-1&quot;');
    expect(text).toContain('&lt;/cast:pending&gt;');
  });

  it('delivers a pending notice for a fire-and-forget request too (framework status, kind-agnostic)', async () => {
    // Pending is framework-authored status, not peer data, so the r-bit reply
    // restriction does not apply — a held `request` is told it is parked, and the
    // row is still never transitioned.
    const folder = 'rq-pending-request';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': 'r' } },
      reject_message: null,
    }, folder);
    const deps = makeReplyDeps(folder, { ...outboundRow, kind: 'request' as const });

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'pending',
      requestId: 'req-1',
      reason: 'pending notice',
      originChannel: 'default',
      originParticipant: 'u:alice@idp',
    });

    expect(deps.calls.route).toBe(1);
    expect(deps.statusUpdates).toEqual([]);
  });

  it('a pending notice leaves the row open so a later answer still delivers (orphan regression)', async () => {
    // End-to-end of the fix on the sender side: pending arrives first (row stays
    // open, notice delivered), then the owner-approved answer arrives on the same
    // requestId and fulfills the still-open row. Pre-fix the pending rode the
    // rejection rail and closed the row, dropping this answer.
    const folder = 'rq-pending-then-answer';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': 'q' } },
      reject_message: null,
    }, folder);
    const deps = makeReplyDeps(folder, outboundRow);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'pending', requestId: 'req-1', reason: 'pending notice',
      originChannel: 'default', originParticipant: 'u:alice@idp',
    });
    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'response', requestId: 'req-1', text: 'the real answer',
      originChannel: 'default', originParticipant: 'u:alice@idp',
    });

    expect(deps.calls.route).toBe(2); // the pending notice, then the answer
    expect(deps.statusUpdates).toEqual([{ table: 'outbound', status: 'fulfilled' }]);
    expect(deps.routeTexts[1]).toContain('the real answer');
  });

  it('delivers a bounce to a fire-and-forget request too (rejection is kind-agnostic)', async () => {
    // A bounce tells the sender its call did not land — useful for both a query
    // and a fire-and-forget request (the docs promise an undeliverable request
    // surfaces as <cast:rejection>). The open row authorizes it; no standing-edge
    // re-check, and the grant string is irrelevant.
    const folder = 'rq-reject-request';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': 'r' } },
      reject_message: null,
    }, folder);
    const deps = makeReplyDeps(folder, { ...outboundRow, kind: 'request' as const });

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'rejection',
      requestId: 'req-1',
      reason: 'busy',
      originChannel: 'default',
      originParticipant: 'u:alice@idp',
    });

    expect(deps.calls.route).toBe(1);
    expect(deps.statusUpdates).toEqual([{ table: 'outbound', status: 'rejected' }]);
  });

  it('delivers rejection when sender holds `q`', async () => {
    const folder = 'rq-reject-deliver';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': 'q' } },
      reject_message: null,
    }, folder);
    const deps = makeReplyDeps(folder, outboundRow);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'rejection',
      requestId: 'req-1',
      reason: 'busy',
      originChannel: 'default',
      originParticipant: 'u:alice@idp',
    });

    expect(deps.calls.route).toBe(1);
  });

  it('rejection delivered as structured <cast:rejection> tag (symmetric with <cast:answer>)', async () => {
    // Prior to this, rejections landed as plaintext ("Request to X was rejected: …"),
    // forcing the source agent's LLM to parse natural language instead of a
    // structured signal. Symmetry with <cast:answer> matters for programmatic
    // handling and for the LLM to distinguish outcomes structurally.
    //
    // `formatMessages` XML-escapes the entire content (same path as the answer
    // tag today), so assertions match the escaped form the LLM will actually see.
    const folder = 'rq-reject-tag-shape';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': 'q' } },
      reject_message: null,
    }, folder);
    const deps = makeReplyDeps(folder, outboundRow);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'rejection',
      requestId: 'req-1',
      reason: 'Target agent is in draft mode — not yet ready to respond.',
      originChannel: 'default',
      originParticipant: 'u:alice@idp',
    });

    expect(deps.calls.route).toBe(1);
    const text = deps.routeTexts[0];
    expect(text).toContain('&lt;cast:rejection');
    expect(text).toContain('from=&quot;a:sender@srv&quot;');
    expect(text).toContain('request=&quot;req-1&quot;');
    expect(text).toContain('Target agent is in draft mode');
    expect(text).toContain('&lt;/cast:rejection&gt;');
    // Sanity: the legacy plaintext format is gone.
    expect(text).not.toContain('Request to a:sender@srv was rejected:');
  });

  it('response delivered as structured <cast:answer> tag (unchanged behavior)', async () => {
    const folder = 'rq-answer-tag-shape';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': 'q' } },
      reject_message: null,
    }, folder);
    const deps = makeReplyDeps(folder, outboundRow);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'response',
      requestId: 'req-1',
      text: 'answer payload',
      originChannel: 'default',
      originParticipant: 'u:alice@idp',
    });

    expect(deps.calls.route).toBe(1);
    const text = deps.routeTexts[0];
    expect(text).toContain('&lt;cast:answer');
    expect(text).toContain('from=&quot;a:sender@srv&quot;');
    expect(text).toContain('request=&quot;req-1&quot;');
    expect(text).toContain('answer payload');
    expect(text).toContain('&lt;/cast:answer&gt;');
  });
});

// ---------------------------------------------------------------------------
// Answer-path qualifier inheritance — sharded query/answer must return the
// answer (or rejection) to the caller's qualified sub-conversation, not the
// null shard. Pre-fix bug: routeRequestReply only carried channel + replyTo,
// so origin-side qualifier was always dropped. Both response and rejection
// must inherit (both-branches discipline).
// ---------------------------------------------------------------------------

function makeQualifierReplyDeps(folder: string): BusHandlerDeps & {
  routeRoutings: unknown[];
} {
  const routeRoutings: unknown[] = [];
  const bus = makeBus();
  return {
    agentId: 'a:test-receiver@srv',
    folder,
    bus,
    // @ts-expect-error — only the request-lookup methods are exercised here.
    agentDb: {
      getOutboundRequest: vi.fn(() => ({
        request_id: 'req-1',
        target_agent: 'a:sender@srv',
        target_channel: 'default',
        channel: 'origin',
        participant: 'u:alice@idp',
        status: 'open',
        kind: 'query' as const,
        created_at: '2026-05-12T00:00:00Z',
      })),
      updateRequestStatus: vi.fn(),
      logEvent: vi.fn(),
    },
    idp: undefined,
    getApprovals: () => ({} as never),
    getTimezone: () => 'UTC',
    isDraft: () => false,
    route: vi.fn(async (_addr: string, _sender: string, _text: string, routing?: unknown) => {
      routeRoutings.push(routing);
      return { ok: true as const, result: null };
    }),
    routeRoutings,
  };
}

describe('handleBusMessage — answer-path qualifier inheritance', () => {
  it('threads originQualifier into the reply routing on response', async () => {
    const folder = 'reply-qual-response';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': 'q' } },
      reject_message: null,
    }, folder);
    const deps = makeQualifierReplyDeps(folder);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'response',
      requestId: 'req-1',
      text: 'answer payload',
      originChannel: 'team-chat',
      originParticipant: 'u:alice@idp',
      originQualifier: 'daily-standup',
    });

    expect(deps.routeRoutings).toHaveLength(1);
    expect(deps.routeRoutings[0]).toEqual({
      channel: 'team-chat',
      qualifier: 'daily-standup',
      targetParticipant: 'u:alice@idp',
    });
  });

  it('omits qualifier from reply routing when originQualifier is absent (un-qualified caller)', async () => {
    const folder = 'reply-qual-absent';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': 'q' } },
      reject_message: null,
    }, folder);
    const deps = makeQualifierReplyDeps(folder);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'response',
      requestId: 'req-1',
      text: 'answer payload',
      originChannel: 'default',
      originParticipant: 'u:alice@idp',
      // originQualifier intentionally omitted
    });

    expect(deps.routeRoutings[0]).toEqual({
      channel: 'default',
      qualifier: undefined,
      targetParticipant: 'u:alice@idp',
    });
  });

  it('threads originQualifier into the reply routing on rejection (symmetric with response)', async () => {
    const folder = 'reply-qual-rejection';
    mockAclFile({
      owner: 'operator',
      allowed: { 'a:sender@srv': { 'default': 'q' } },
      reject_message: null,
    }, folder);
    const deps = makeQualifierReplyDeps(folder);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'rejection',
      requestId: 'req-1',
      reason: 'busy',
      originChannel: 'team-chat',
      originParticipant: 'u:alice@idp',
      originQualifier: 'daily-standup',
    });

    expect(deps.routeRoutings).toHaveLength(1);
    expect(deps.routeRoutings[0]).toEqual({
      channel: 'team-chat',
      qualifier: 'daily-standup',
      targetParticipant: 'u:alice@idp',
    });
  });
});

describe('per-turn wire containment — sourceHandle dies at the bus-handler boundary', () => {
  it('an ingested payload with sourceHandle delivers with no trace of the wire in any route() argument', async () => {
    // Blindness is total: the wire is pairing-only metadata. Nothing routed
    // into a runner — text, routing, attrs — may carry it.
    const folder = 'r-wire-containment';
    mockAclFile({ owner: 'operator', allowed: { 'u:remote@idp': { '*': 'io' } }, reject_message: null }, folder);
    const deps = makeDeps(folder);

    await handleBusMessage(deps, 'u:remote@idp', deps.agentId, {
      type: 'ingested',
      text: 'hello there',
      declaredName: 'Remote',
      routing: { channel: 'default' },
      sourceHandle: 'tg:424242',
    });

    expect(deps.calls.route).toBe(1);
    const routeMock = deps.route as unknown as { mock: { calls: unknown[][] } };
    const allArgs = JSON.stringify(routeMock.mock.calls);
    expect(allArgs).not.toContain('tg:424242');
  });
});
