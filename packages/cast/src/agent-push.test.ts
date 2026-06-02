/**
 * Real-boundary coverage for `conversation__push_to_channel`.
 *
 * Both-branches discipline for tests of security gates:
 * `participantExists`, `gateInbound`, and the guard composers MUST
 * be exercised at the real boundary. The previous test surface mocked
 * `deliverToChannel`/`deliverToAgent` at the handler level, which is exactly
 * the failure mode that shipped the original Task-69 `participantExists` bug
 * and (later) our own `__design`→`__configure` parser regression. Boundary
 * tests use the real `buildAgentMcpDeps` over a real `Bus` + real `AgentDb`
 * + capturing `ctx.route` so every gate runs as it does in production.
 *
 * Coverage matrix mirrors the plan:
 *
 *   user-agent           × participantExists          × {known, unknown}
 *   per-agent-console    × participantExists skip     × admin handle reaches dispatch
 *   user-agent           × gateInbound (i bit)        × {allow, deny}
 *   per-agent-console    × gateInbound skip           × admin handle reaches dispatch
 *   user-agent           × parser regex               × {default ok, __configure rejected}
 *   per-agent-console    × parser regex               × {__configure ok, default rejected by guard}
 *   per-agent-console    × intraAgentInfraGuard       × {Configure→Design perm-deny;
 *                                                      Design→Configure strict-deny / normal-allow}
 *   per-agent-console    × consoleSourceUserTargetGuard × design→user-channel deny
 *   both                 × self-target ≡ omit         × identical guard outcomes
 *   per-agent-console    × cross-agent reject         × per-agent cannot push to other agent
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// `consoleIsolation` is read by `intraAgentInfraGuard` at call time. Mock the
// module so tests can flip the mode without writing a config file.
let testIsolation: 'normal' | 'strict' = 'normal';
function setIsolation(mode: 'normal' | 'strict'): void {
  testIsolation = mode;
}
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    readServerConfig: () => ({
      consoleModel: 'claude-opus-4-7',
      consoleIsolation: testIsolation,
    }),
  };
});

import { _setMockWatcher } from './lib/config-reader.js';
import { Bus, type BusHandler } from './gateway/bus.js';
import { AgentDb } from './agent/agent-db.js';
import { buildAgentMcpDeps, type AgentMcpDepsContext } from './agent/agent-mcp-deps.js';
import { registerPushToChannelTool } from './agent/mcp-server.js';
import type { LocalPushActor } from './agent/push-actor.js';
import type { McpServerDeps } from './agent/mcp-server.js';

// Real-fs watcher so `checkAcl` can read mocked acl.json from disk (other
// tests in this repo follow the same pattern).
_setMockWatcher({
  get: (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } },
});

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const AGENT_ID = 'a:test-agent@srv';
const AGENT_FOLDER = 'test-agent';
const OTHER_AGENT_ID = 'a:other@srv';
const USER_PARTICIPANT = 'u:test-user';
const ADMIN_PARTICIPANT = 'local/admin:local';

interface Harness {
  bus: Bus;
  agentDb: AgentDb;
  deps: McpServerDeps;
  routeCalls: Array<{
    address: string;
    senderId: string;
    text: string;
    routing: unknown;
    kind: unknown;
  }>;
  cleanup: () => void;
}

function buildHarness(): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-push-test-'));
  const agentDb = new AgentDb(path.join(tmpDir, 'agent.db'));
  const bus = new Bus();
  const noop: BusHandler = { handleMessage: async () => {}, handleEvent: async () => {} };
  bus.register(AGENT_ID, noop, 'exact', { label: AGENT_FOLDER, type: 'agent', folderPath: AGENT_FOLDER });
  bus.register(OTHER_AGENT_ID, noop, 'exact', { label: 'other', type: 'agent', folderPath: 'other' });

  const routeCalls: Harness['routeCalls'] = [];
  const ctx: AgentMcpDepsContext = {
    agentId: AGENT_ID,
    folder: AGENT_FOLDER,
    bus,
    agentDb,
    route: async (address, senderId, text, routing, _rawText, _declaredName, _attachments, kind) => {
      routeCalls.push({ address, senderId, text, routing, kind });
      return null;
    },
    getApprovals: () => { throw new Error('approvals not wired in test'); },
    listSiblingAgents: undefined,
    requestConversationEnd: () => ({ accepted: false, cooldownSeconds: 0 }),
    getFileWatchService: () => { throw new Error('file-watch not wired in test'); },
  };
  const deps = buildAgentMcpDeps({}, ctx);

  return {
    bus,
    agentDb,
    deps,
    routeCalls,
    cleanup: () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

async function clientFor(actor: LocalPushActor, h: Harness): Promise<Client> {
  const server = new McpServer({ name: 'cast-test', version: '1.0.0' });
  registerPushToChannelTool(server, {
    actor,
    deliverToChannel: h.deps.deliverToChannel!,
    deliverToAgent: h.deps.deliverToAgent,
    resolveAgentByLabel: (label) => bus_resolveByLabel(h.bus, label),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

function bus_resolveByLabel(bus: Bus, label: string): string | undefined {
  return bus.resolveByLabel(label);
}

function resultText(r: Awaited<ReturnType<Client['callTool']>>): string {
  return (r.content as Array<{ type: string; text: string }>)[0].text;
}

let harness: Harness;
beforeEach(() => {
  setIsolation('normal');
  harness = buildHarness();
});
afterEach(() => {
  harness.cleanup();
});

function userAgentActor(channel = 'default'): LocalPushActor {
  return {
    kind: 'user-agent',
    agentId: AGENT_ID,
    channel,
    participant: USER_PARTICIPANT,
  };
}

function perAgentConsoleActor(channel: '__design' | '__configure' = '__design'): LocalPushActor {
  return {
    kind: 'per-agent-console',
    agentId: AGENT_ID,
    channel,
    participant: ADMIN_PARTICIPANT,
  };
}

// ----------------------------------------------------------------------------
// participantExists — user-trust gate, both branches
// ----------------------------------------------------------------------------

describe('participantExists gate — user-agent', () => {
  it('user-agent push to a registered peer succeeds (allow branch)', async () => {
    // Allow branch isolates `participantExists` from `gateInbound` by using
    // the local-identity admin handle as the target participant — `checkAcl`
    // short-circuits to `ALL_BITS` for identity=`local` so the downstream
    // gate doesn't influence the outcome. The reject-branch test uses a
    // non-local identity to exercise the reject side of the same gate.
    harness.agentDb.upsertParticipant(ADMIN_PARTICIPANT);
    const actor: LocalPushActor = {
      kind: 'user-agent',
      agentId: AGENT_ID,
      channel: 'default',
      participant: ADMIN_PARTICIPANT,
    };
    const client = await clientFor(actor, harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'side-channel', text: 'hi' },
    });
    expect(r.isError).toBeFalsy();
    expect(harness.routeCalls).toHaveLength(1);
  });

  it('user-agent push to an unregistered peer is rejected (reject branch)', async () => {
    // Local-identity caller passes the caller-standing gate (ALL_BITS), so
    // `participantExists` is the gate under test. No upsertParticipant → the
    // target is unregistered. (A non-local caller would trip the caller-
    // standing gate first, before participantExists is ever reached.)
    const actor: LocalPushActor = {
      kind: 'user-agent',
      agentId: AGENT_ID,
      channel: 'default',
      participant: ADMIN_PARTICIPANT,
    };
    const client = await clientFor(actor, harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'side-channel', text: 'hi' },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain(`Unknown participant: ${ADMIN_PARTICIPANT}`);
    expect(harness.routeCalls).toHaveLength(0);
  });
});

describe('participantExists gate — per-agent-console (skipped)', () => {
  it('per-agent-console push reaches dispatch even though admin handle is not in participants table', async () => {
    // No upsertParticipant — admin handle is NOT registered. User-agent
    // would reject here; per-agent-console skips the gate.
    expect(harness.agentDb.participantExists(ADMIN_PARTICIPANT)).toBe(false);
    const client = await clientFor(perAgentConsoleActor('__design'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: '__configure', text: 'task: bind cast-source slot' },
    });
    expect(r.isError).toBeFalsy();
    expect(harness.routeCalls).toHaveLength(1);
    expect(harness.routeCalls[0]!.routing).toMatchObject({ channel: '__configure', targetParticipant: ADMIN_PARTICIPANT });
  });
});

// ----------------------------------------------------------------------------
// gateInbound (`i` bit) — user-trust gate, both branches
// ----------------------------------------------------------------------------

describe('gateInbound — user-agent', () => {
  // `local` identity short-circuits to ALL_BITS in checkAcl, so we use a
  // non-local participant whose bits are controllable via acl.json. Without
  // an acl.json grant, the bits are empty → `i` missing → reject.
  it('user-agent push to a peer without `i` bit is rejected', async () => {
    harness.agentDb.upsertParticipant(USER_PARTICIPANT);
    // No acl.json on disk → checkAcl returns empty bits for non-local identities.
    const client = await clientFor(userAgentActor('default'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'side-channel', text: 'hi' },
    });
    // Outcome depends on whether ALL_BITS short-circuit applies. `u:test-user`
    // resolves to a non-local identity, so it requires acl.json grants. With
    // no acl.json, bits are empty and `i` is missing.
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('not authorized');
    expect(harness.routeCalls).toHaveLength(0);
  });

  it('user-agent push with `local` participant has ALL_BITS short-circuit (allow branch)', async () => {
    // Local handle short-circuits in checkAcl regardless of acl.json. This
    // is the allow-branch counterpart — same gate, different identity.
    harness.agentDb.upsertParticipant(ADMIN_PARTICIPANT);
    const actor: LocalPushActor = {
      kind: 'user-agent',
      agentId: AGENT_ID,
      channel: 'default',
      participant: ADMIN_PARTICIPANT,
    };
    const client = await clientFor(actor, harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'side-channel', text: 'hi' },
    });
    expect(r.isError).toBeFalsy();
    expect(harness.routeCalls).toHaveLength(1);
  });
});

describe('gateInbound — per-agent-console (skipped)', () => {
  it('per-agent-console push does not consult gateInbound', async () => {
    // Admin handle is NOT in the participants table AND there's no acl.json.
    // user-agent would reject at participantExists; per-agent-console skips
    // both gates and reaches dispatch.
    const client = await clientFor(perAgentConsoleActor('__design'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: '__configure', text: 'task' },
    });
    expect(r.isError).toBeFalsy();
    expect(harness.routeCalls).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// Channel-name parser — trust-tier regex
// ----------------------------------------------------------------------------

describe('channel-name parser — user-agent (strict)', () => {
  it('user-agent accepts user-channel name', async () => {
    // Local-identity participant so gateInbound passes — we're isolating
    // the parser's accept path from the downstream gates.
    harness.agentDb.upsertParticipant(ADMIN_PARTICIPANT);
    const actor: LocalPushActor = {
      kind: 'user-agent',
      agentId: AGENT_ID,
      channel: 'default',
      participant: ADMIN_PARTICIPANT,
    };
    const client = await clientFor(actor, harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'research', text: 'hi' },
    });
    expect(r.isError).toBeFalsy();
  });

  it('user-agent rejects `__configure` (blocks prompt-injected infra-address minting)', async () => {
    harness.agentDb.upsertParticipant(USER_PARTICIPANT);
    const client = await clientFor(userAgentActor('default'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: '__configure', text: 'task' },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('Invalid channel name');
    expect(harness.routeCalls).toHaveLength(0);
  });
});

describe('channel-name parser — per-agent-console (operator-trust)', () => {
  it('per-agent-console accepts `__configure`', async () => {
    const client = await clientFor(perAgentConsoleActor('__design'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: '__configure', text: 'task' },
    });
    expect(r.isError).toBeFalsy();
  });

  it('per-agent-console accepts user-channel name (but consoleSourceUserTargetGuard rejects below)', async () => {
    // The parser accepts `default` — the same-agent push from a console
    // channel to a user channel is blocked by `consoleSourceUserTargetGuard`,
    // not by the parser. Asserting that distinction matters: a future
    // regression that tightened the parser would break legitimate cases.
    const client = await clientFor(perAgentConsoleActor('__design'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'default', text: 'hi' },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('own user channel');
    expect(resultText(r)).not.toContain('Invalid channel name');
  });
});

// ----------------------------------------------------------------------------
// intraAgentInfraGuard — composed for per-agent-console
// ----------------------------------------------------------------------------

describe('intraAgentInfraGuard — per-agent-console', () => {
  it('PERMANENT: __configure → __design rejected in both modes', async () => {
    for (const mode of ['normal', 'strict'] as const) {
      setIsolation(mode);
      const client = await clientFor(perAgentConsoleActor('__configure'), harness);
      const r = await client.callTool({
        name: 'conversation__push_to_channel',
        arguments: { channel: '__design', text: 'try to exfil' },
      });
      expect(r.isError).toBe(true);
      expect(resultText(r)).toMatch(/Configure holds PII state and Design has network egress/);
      expect(harness.routeCalls).toHaveLength(0);
    }
  });

  it('strict mode: __design → __configure rejected', async () => {
    setIsolation('strict');
    const client = await clientFor(perAgentConsoleActor('__design'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: '__configure', text: 'handoff' },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/Console isolation is currently `strict`/);
    expect(harness.routeCalls).toHaveLength(0);
  });

  it('normal mode: __design → __configure allowed (delivers)', async () => {
    setIsolation('normal');
    const client = await clientFor(perAgentConsoleActor('__design'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: '__configure', text: 'handoff' },
    });
    expect(r.isError).toBeFalsy();
    expect(harness.routeCalls).toHaveLength(1);
    expect(harness.routeCalls[0]!.routing).toMatchObject({ channel: '__configure' });
  });
});

// ----------------------------------------------------------------------------
// consoleSourceUserTargetGuard
// ----------------------------------------------------------------------------

describe('consoleSourceUserTargetGuard — per-agent-console', () => {
  it('__design → user channel rejected', async () => {
    const client = await clientFor(perAgentConsoleActor('__design'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'default', text: 'hi' },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('own user channel');
    expect(harness.routeCalls).toHaveLength(0);
  });

  it('__configure → user channel rejected', async () => {
    const client = await clientFor(perAgentConsoleActor('__configure'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'default', text: 'hi' },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('own user channel');
  });
});

// ----------------------------------------------------------------------------
// Self-target ≡ omit equivalence — guards run identically on both shapes
// ----------------------------------------------------------------------------

describe('self-target equivalent to omit', () => {
  it('per-agent-console: passing own label produces same allow/deny as omitting', async () => {
    setIsolation('normal');
    // Omitted form — __design → __configure allow in normal mode.
    const client1 = await clientFor(perAgentConsoleActor('__design'), harness);
    const r1 = await client1.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: '__configure', text: 'handoff-A' },
    });
    expect(r1.isError).toBeFalsy();
    const callsAfterOmit = harness.routeCalls.length;

    // Self-target form — passing the agent's own label.
    const client2 = await clientFor(perAgentConsoleActor('__design'), harness);
    const r2 = await client2.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: '__configure', text: 'handoff-B', target_agent: AGENT_FOLDER },
    });
    expect(r2.isError).toBeFalsy();
    expect(harness.routeCalls.length).toBe(callsAfterOmit + 1);
  });

  it('per-agent-console: PERMANENT block fires whether `target_agent` is omitted or set to self', async () => {
    // Configure → Design must be denied in BOTH shapes. Previous bug:
    // self-target shape bypassed the guard composition and reached the
    // bus path. Both branches must reach the same outcome.
    setIsolation('normal');
    const client1 = await clientFor(perAgentConsoleActor('__configure'), harness);
    const r1 = await client1.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: '__design', text: 'omit form' },
    });
    expect(r1.isError).toBe(true);

    const client2 = await clientFor(perAgentConsoleActor('__configure'), harness);
    const r2 = await client2.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: '__design', text: 'self-target form', target_agent: AGENT_FOLDER },
    });
    expect(r2.isError).toBe(true);
    expect(resultText(r2)).toMatch(/Configure holds PII state and Design has network egress/);
    expect(harness.routeCalls).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Cross-agent push from per-agent-console: rejected
// ----------------------------------------------------------------------------

describe('cross-agent push from per-agent-console', () => {
  it('rejected with operator routing guidance', async () => {
    const client = await clientFor(perAgentConsoleActor('__design'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'default', text: 'hi', target_agent: 'other' },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/cannot push directly to other agents/i);
    expect(harness.routeCalls).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Self-loop guard (handler level + dispatchLocalPush internal check)
// ----------------------------------------------------------------------------

describe('selfLoopGuard', () => {
  it('user-agent: push to current channel rejected', async () => {
    harness.agentDb.upsertParticipant(USER_PARTICIPANT);
    const client = await clientFor(userAgentActor('default'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'default', text: 'self-push' },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('own active conversation');
    expect(harness.routeCalls).toHaveLength(0);
  });

  it('per-agent-console: push to current channel rejected', async () => {
    const client = await clientFor(perAgentConsoleActor('__design'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: '__design', text: 'self-push' },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('own active conversation');
  });
});

// ----------------------------------------------------------------------------
// Unknown target_agent label
// ----------------------------------------------------------------------------

describe('unknown target_agent label', () => {
  it('rejected before guards run', async () => {
    const client = await clientFor(perAgentConsoleActor('__design'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: '__configure', text: 'hi', target_agent: 'ghost' },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('Unknown agent: "ghost"');
  });
});

// ----------------------------------------------------------------------------
// Caller-standing gate — cross-channel injection guard (push_to_participant)
//
// `push_to_participant` can move BOTH axes at once: a different participant on
// a different channel. The gate must verify the *caller* (originating
// participant) is itself authorized on the target channel, not only the target
// participant — otherwise a user with rights on X could inject into Y via a
// target who has Y. The gate lives in `dispatchLocalPush`, so we drive the real
// `deliverToChannel` dep directly: `push_to_channel` can't express the
// caller≠target shape this guards, and mocking the dep is exactly what the
// boundary discipline at the top of this file forbids.
// ----------------------------------------------------------------------------

describe('caller-standing gate — push_to_participant cross-channel', () => {
  it('denies [A,#x] → [B,#y] when caller A lacks `i` on #y, before B is consulted', async () => {
    // Alice (a user, no acl.json grant → empty bits on #y) tries to reach Bob
    // on #y from her #x conversation. The gate denies on HER lack of standing.
    harness.agentDb.upsertParticipant('u:bob');
    const r = await harness.deps.deliverToChannel!(
      userAgentActor('x'), // actor.kind = user-agent
      'y',                 // target channel
      'injected text',
      'u:bob',             // target participant
      'x',                 // caller channel
      'u:alice',           // caller participant — no rights on #y
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('not authorized on channel "y"');
      // Caller-first: the denial must leak nothing about Bob (existence/roster).
      expect(r.reason).not.toContain('bob');
      expect(r.reason).not.toContain('Unknown participant');
    }
    expect(harness.routeCalls).toHaveLength(0);
  });

  it('allows a self-fire (agent-addressed caller) to push_to_participant — agent owns its channels', async () => {
    // schedule.txt / self-task fire: caller is the agent's own address, not a
    // user, so the caller-standing check is skipped (an `a:` identity can't
    // hold `i`). The target gate still applies — local handle → ALL_BITS.
    harness.agentDb.upsertParticipant(ADMIN_PARTICIPANT);
    const r = await harness.deps.deliverToChannel!(
      userAgentActor('x'),
      'y',               // target channel (differs from the self-fire channel)
      'scheduled nudge',
      ADMIN_PARTICIPANT, // target participant (local → ALL_BITS)
      'x',               // caller channel (the self-fire's own channel)
      AGENT_ID,          // caller participant = agent self-address
    );
    expect(r.ok).toBe(true);
    expect(harness.routeCalls).toHaveLength(1);
    expect(harness.routeCalls[0]!.routing).toMatchObject({ channel: 'y', targetParticipant: ADMIN_PARTICIPANT });
  });

  it('allows the two-axis move when the caller IS authorized on #y (no over-block)', async () => {
    // Counterpart to the denial: a caller with standing on the target channel
    // makes a legitimate two-axis push. The local handle → ALL_BITS gives the
    // caller `i` on #y without an acl.json fixture.
    harness.agentDb.upsertParticipant(ADMIN_PARTICIPANT);
    const r = await harness.deps.deliverToChannel!(
      userAgentActor('x'),
      'y',
      'authorized relay',
      ADMIN_PARTICIPANT, // target (local → ALL_BITS)
      'x',
      ADMIN_PARTICIPANT, // caller (local → ALL_BITS, has `i` on #y)
    );
    expect(r.ok).toBe(true);
    expect(harness.routeCalls).toHaveLength(1);
  });
});
