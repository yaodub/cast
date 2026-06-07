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

import { handleBusMessage, type BusHandlerDeps } from './agent/agent-bus-handler.js';
import { Bus } from './gateway/bus.js';
import type { BusHandler } from './gateway/bus.js';
import { _setMockWatcher } from './lib/config-reader.js';

const watcherFiles = new Map<string, string>();

beforeEach(() => {
  watcherFiles.clear();
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
} {
  const calls = { route: 0, rejected: 0, rejection: 0 };
  const routeArgs: Array<{ kind?: string; attrs?: Record<string, string> }> = [];
  const bus = makeBus();
  const originalRouteMessage = bus.routeMessage.bind(bus);
  bus.routeMessage = async (from, to, payload) => {
    if (typeof payload === 'object' && payload !== null && 'pkt' in payload) {
      calls.rejected += 1;
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
    getApprovals: () => ({} as never),
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
  };
}

describe('handleBusMessage — intent-driven verb selection', () => {
  // Note: the i/o/h/p bits are restricted to user (u:*) and console (console:*)
  // identities by the agent-identity bit restriction in acl.ts. These receiver-
  // side gate tests use a `console:*` sender — that's the live path for inbound
  // pushes on the disk-ACL lane (manager consoles into user channels).
  it('allows conversation when sender has `i` on channel', async () => {
    const folder = 'r-conv-allow';
    mockAclFile({ owner: 'operator', peers: { 'console:sender': { '*': 'io' } }, reject_message: null }, folder);
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
    mockAclFile({ owner: 'operator', peers: { 'console:sender': { '*': 'io' } }, reject_message: null }, folder);
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
      peers: {
        'console:sender': { '*': 'ioh' },
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
      peers: { 'console:sender': { '*': 'io' } },
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
      peers: {
        'console:sender': { '*': 'ioh' },
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
  // For an agent sender (a pure conduit that cannot hold `h`), gate 2 reads
  // the originating USER's `h`, not the sending agent's bits. The agent's
  // own grant is irrelevant to host authorization. Console/user senders
  // (covered above) are unchanged — they hold `h` themselves.

  it('allows agent-sent push when the originating user holds `h`+`i` (sender absent from ACL)', async () => {
    // The discriminating case: the old code read the sending agent's bits at
    // gate 2 (absent → deny). The re-key reads the user (`ioh` → allow). The
    // sending agent holds nothing — it is a pure conduit.
    const folder = 'r-agent-push-allow';
    mockAclFile({
      owner: 'operator',
      peers: { 'u:alice@idp': { 'default': 'ioh' } },
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
      peers: {
        'a:sender@srv': { 'default': 'qra' },
        'u:alice@idp': { 'default': 'ioh' },
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

  it('denies agent-sent push when the originating user lacks `h` (gate 2)', async () => {
    // User is a member (`io`) but the operator never conferred `h`, the
    // cross-agent host grant. Gate 2 denies even though gate 3 (`i`) would pass.
    const folder = 'r-agent-push-no-h';
    mockAclFile({
      owner: 'operator',
      peers: { 'u:alice@idp': { 'default': 'io' } },
      reject_message: null,
    }, folder);
    const deps = makeDeps(folder);

    await handleBusMessage(deps, 'a:sender@srv', deps.agentId, {
      type: 'push',
      text: 'handing alice over',
      requestId: 'req-agent-3',
      returnToParticipant: 'u:alice@idp',
      returnToChannel: 'origin',
      routing: { channel: 'default' },
    });

    expect(deps.calls.route).toBe(0);
    expect(deps.calls.rejection).toBe(1);
  });

  it('denies agent-sent push when the originating user lacks `i` (gate 3)', async () => {
    // User holds the host grant `h` but is not a member of the channel (`i`
    // absent) — gate 3 still blocks introducing a non-member user.
    const folder = 'r-agent-push-no-i';
    mockAclFile({
      owner: 'operator',
      peers: { 'u:alice@idp': { 'default': 'h' } },
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
    // full bits on every channel, so gate 2 (`h`) passes — but gate 3 reads
    // `membershipBits`, which treats the operator tier as a member of nothing.
    // With no concrete placement the push is refused, so an agent cannot puppet
    // the operator's reach into a channel the operator never joined. (Before the
    // membershipBits gate, gate 3's checkAcl god-moded the operator → allow.)
    const folder = 'r-agent-push-operator-no-placement';
    mockAclFile({
      owner: 'operator',
      peers: {}, // operator carries no disk grant; it god-modes checkAcl only
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
    // the concrete `ioh`, so gate 3 passes.
    const folder = 'r-agent-push-operator-placed';
    mockAclFile({
      owner: 'operator',
      peers: { 'admin:local': { 'default': 'ioh' } },
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

  it('denies conversation when sender has only `h` (push grant alone is not a conversation grant)', async () => {
    const folder = 'r-conv-deny';
    mockAclFile({ owner: 'operator', peers: { 'console:sender': { '*': 'h' } }, reject_message: null }, folder);
    const deps = makeDeps(folder);

    await handleBusMessage(deps, 'console:sender', deps.agentId, {
      type: 'message',
      text: 'hi',
      routing: { channel: 'default' },
    });

    expect(deps.calls.route).toBe(0);
  });

  it('defaults missing intent to conversation (Zod default)', async () => {
    const folder = 'r-default-conv';
    mockAclFile({ owner: 'operator', peers: { 'console:sender': { '*': 'io' } }, reject_message: null }, folder);
    const deps = makeDeps(folder);

    await handleBusMessage(deps, 'console:sender', deps.agentId, {
      type: 'message',
      text: 'hi',
      routing: { channel: 'default' }, // no intent — Zod fills 'conversation'
    });

    expect(deps.calls.route).toBe(1);
  });
});

describe('handleBusMessage — draft-mode auto-reply', () => {
  it('bounces external message with draft reply and skips route()', async () => {
    // Even with a valid `io` grant the message must not reach route() while
    // the agent is in draft. The bounce uses the conversation reply path so
    // the sender sees a human-readable explanation rather than silence.
    const folder = 'd-msg-bounce';
    mockAclFile({ owner: 'operator', peers: { 'u:sender@srv': { '*': 'io' } }, reject_message: null }, folder);
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
    mockAclFile({ owner: 'operator', peers: { 'admin:local': { '*': 'io' } }, reject_message: null }, folder);
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
    mockAclFile({ owner: 'operator', peers: { 'a:sender@srv': { '*': 'q' } }, reject_message: null }, folder);
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
      peers: { 'console:design-manager': { '__design': 'ioh' } },
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
      peers: { 'a:sibling@srv': { 'default': 'q' } },
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
// q / r split — re-check sender ACL at reply-delivery time so the live grant
// decides whether an answer enters the sender's session (q) or is blackholed
// (r-only, or revoked between send and reply).
// ---------------------------------------------------------------------------

function makeReplyDeps(
  folder: string,
  outboundRow: { target_agent: string; target_channel: string; status: string } | undefined,
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
      peers: { 'a:sender@srv': { 'default': 'q' } },
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

  it('suppresses response when sender holds only `r` (no q)', async () => {
    // The mechanical guarantee of `r`: the target's reply never enters the
    // sender's session, so a compromised peer cannot prompt-inject the asker.
    const folder = 'rq-suppress';
    mockAclFile({
      owner: 'operator',
      peers: { 'a:sender@srv': { 'default': 'r' } },
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

    expect(deps.calls.route).toBe(0);
    // Still fulfilled so retries don't accumulate — the row tracks completion
    // independently of delivery.
    expect(deps.statusUpdates).toEqual([{ table: 'outbound', status: 'fulfilled' }]);
  });

  it('suppresses response when grant was revoked between send and reply', async () => {
    // Sender held `q` at send time, request landed at the peer, but the
    // operator yanked the grant before the reply came back. Live ACL wins:
    // no derived state caches the original grant, so the new posture applies.
    const folder = 'rq-revoked';
    mockAclFile({
      owner: 'operator',
      peers: { 'a:sender@srv': { 'default': '' } },
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

    expect(deps.calls.route).toBe(0);
  });

  it('suppresses rejection too (same q/r split applies to the rejection path)', async () => {
    const folder = 'rq-reject-suppress';
    mockAclFile({
      owner: 'operator',
      peers: { 'a:sender@srv': { 'default': 'r' } },
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

    expect(deps.calls.route).toBe(0);
    expect(deps.statusUpdates).toEqual([{ table: 'outbound', status: 'rejected' }]);
  });

  it('delivers rejection when sender holds `q`', async () => {
    const folder = 'rq-reject-deliver';
    mockAclFile({
      owner: 'operator',
      peers: { 'a:sender@srv': { 'default': 'q' } },
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
      peers: { 'a:sender@srv': { 'default': 'q' } },
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
      peers: { 'a:sender@srv': { 'default': 'q' } },
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
      peers: { 'a:sender@srv': { 'default': 'q' } },
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
      peers: { 'a:sender@srv': { 'default': 'q' } },
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
      peers: { 'a:sender@srv': { 'default': 'q' } },
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

describe('pairing — per-turn source wire (transport-blind ferry)', () => {
  // Above the gateway the from-address is the bare identity, so the wire a
  // pairing code binds to rides as explicit payload metadata (`sourceHandle`).
  it('binds the pairing code to the payload sourceHandle, not the from-address', async () => {
    const folder = 'r-pair-wire';
    const deps = makeDeps(folder);
    const pairSpy = vi.fn((handle: string, _code: string) => ({
      success: true,
      message: `paired ${handle}`,
    }));
    deps.idp = {} as never;
    deps.pair = pairSpy as never;

    await handleBusMessage(deps, 'u:abc@srv', deps.agentId, {
      type: 'pairing',
      code: 'C0DE',
      sourceHandle: 'tg:42',
    });

    expect(pairSpy).toHaveBeenCalledWith('tg:42', 'C0DE');
  });

  it('falls back to the from-address wire when no sourceHandle rides the payload', async () => {
    // Legacy producer shape — the gateway always stamps sourceHandle now, but
    // a raw-wire from-address (pre-resolution sender) still pairs.
    const folder = 'r-pair-wire-fallback';
    const deps = makeDeps(folder);
    const pairSpy = vi.fn((handle: string, _code: string) => ({
      success: true,
      message: `paired ${handle}`,
    }));
    deps.idp = {} as never;
    deps.pair = pairSpy as never;

    await handleBusMessage(deps, 'tg:42', deps.agentId, {
      type: 'pairing',
      code: 'C0DE',
    });

    expect(pairSpy).toHaveBeenCalledWith('tg:42', 'C0DE');
  });
});

describe('per-turn wire containment — sourceHandle dies at the bus-handler boundary', () => {
  it('an ingested payload with sourceHandle delivers with no trace of the wire in any route() argument', async () => {
    // Blindness is total: the wire is pairing-only metadata. Nothing routed
    // into a runner — text, routing, attrs — may carry it.
    const folder = 'r-wire-containment';
    mockAclFile({ owner: 'operator', peers: { 'u:remote@idp': { '*': 'io' } }, reject_message: null }, folder);
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
