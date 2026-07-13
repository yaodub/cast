/**
 * Real-boundary coverage for `conversation__push_to_channel`.
 *
 * Both-branches discipline for tests of security gates:
 * `participantExists`, `gateInbound`, and the guard composers MUST
 * be exercised at the real boundary. The previous test surface mocked
 * `deliverToChannel`/`deliverToAgent` at the handler level, which is exactly
 * the failure mode that shipped the original `participantExists` bug
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
import { channelAuthDenial } from './auth/conversation-context.js';
import { registerPushToChannelTool } from './agent/mcp-server.js';
import type { LocalPushActor } from './agent/push-actor.js';
import type { McpServerDeps } from './agent/mcp-server.js';
import type { RouteResult } from './types.js';
import type { ApprovalHandler } from './agent/approval-handler.js';
import { agentPath } from './config.js';
import { grantUserPush, tombstoneUserPush } from './auth/user-push-store.js';

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
const ADMIN_PARTICIPANT = 'admin:local';

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
  /** Scripted per-call route results, consumed in order. An `Error` entry
   *  makes that call reject; a `RouteResult` resolves as-is. Empty →
   *  `{ok: true}` (capture-only success, what pre-existing tests rely on). */
  routeResults: Array<RouteResult | Error>;
  cleanup: () => void;
}

function buildHarness(approvals?: ApprovalHandler): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-push-test-'));
  const agentDb = new AgentDb(path.join(tmpDir, 'agent.db'));
  const bus = new Bus();
  const noop: BusHandler = { handleMessage: async () => {}, handleEvent: async () => {} };
  bus.register(AGENT_ID, noop, 'exact', { label: AGENT_FOLDER, type: 'agent', folderPath: AGENT_FOLDER });
  bus.register(OTHER_AGENT_ID, noop, 'exact', { label: 'other', type: 'agent', folderPath: 'other' });

  const routeCalls: Harness['routeCalls'] = [];
  const routeResults: Harness['routeResults'] = [];
  const ctx: AgentMcpDepsContext = {
    agentId: AGENT_ID,
    folder: AGENT_FOLDER,
    bus,
    agentDb,
    route: async (address, senderId, text, routing, _rawText, _declaredName, _attachments, kind) => {
      routeCalls.push({ address, senderId, text, routing, kind });
      if (routeResults.length > 0) {
        const next = routeResults.shift()!;
        if (next instanceof Error) throw next;
        return next;
      }
      return { ok: true as const, result: null };
    },
    getApprovals: () => {
      if (approvals) return approvals;
      throw new Error('approvals not wired in test');
    },
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
    routeResults,
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
    // the operator admin handle as the target participant — `checkAcl`
    // short-circuits to `ALL_BITS` for the operator tier so the downstream
    // gate doesn't influence the outcome. The reject-branch test uses a
    // regular user identity to exercise the reject side of the same gate.
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
    // The operator caller passes the caller-standing gate (ALL_BITS), so
    // `participantExists` is the gate under test. No upsertParticipant → the
    // target is unregistered. (A regular user caller would trip the caller-
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
// gateInbound (`i` bit) — user-trust gate, reject branch
// (The allow branch is the operator ALL_BITS short-circuit, already covered by
// the participantExists allow case above — the same operator-tier bypass.)
// ----------------------------------------------------------------------------

describe('gateInbound — user-agent', () => {
  // The operator tier short-circuits to ALL_BITS in checkAcl, so we use a
  // regular user participant whose bits are controllable via acl.json. Without
  // an acl.json grant, the bits are empty → `i` missing → reject.
  it('user-agent push to a peer without `i` bit is rejected', async () => {
    harness.agentDb.upsertParticipant(USER_PARTICIPANT);
    // No acl.json on disk → checkAcl returns empty bits for regular user identities.
    const client = await clientFor(userAgentActor('default'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'side-channel', text: 'hi' },
    });
    // Outcome depends on whether the operator ALL_BITS short-circuit applies.
    // `u:test-user` resolves to a regular user identity, so it requires
    // acl.json grants. With no acl.json, bits are empty and `i` is missing.
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('not authorized');
    expect(harness.routeCalls).toHaveLength(0);
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
// Cross-agent push containment — the reactive `p`-edge. The user-agent
// cross-agent gate keys containment on the SENDER's `p` toward the TARGET AGENT
// (replacing the old carried-user `o` check). Three-state: granted → push;
// askable → hold + owner approval; rejected → deny. Reads acl.json off disk via
// the real-fs mock watcher, same as the q/r path.
// ----------------------------------------------------------------------------

const ACL_PATH = agentPath(AGENT_FOLDER, 'config', 'acl.json');
function writeAcl(content: object): void {
  fs.mkdirSync(path.dirname(ACL_PATH), { recursive: true });
  fs.writeFileSync(ACL_PATH, JSON.stringify(content));
}

describe('cross-agent push containment — p-edge', () => {
  afterEach(() => fs.rmSync(ACL_PATH, { force: true }));

  it('granted: a `p` grant on the target agent lets the push through', async () => {
    harness.agentDb.upsertParticipant(USER_PARTICIPANT);
    writeAcl({ owner: 'operator', allowed: { [OTHER_AGENT_ID]: { 'side-channel': 'p' } } });
    const client = await clientFor(userAgentActor('default'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'side-channel', text: 'hi', target_agent: 'other' },
    });
    expect(r.isError).toBeFalsy();
    expect(resultText(r)).toMatch(/Queued for delivery/i);
  });

  it('rejected: no acl.json denies with no reach hint (push is enforcement-only)', async () => {
    harness.agentDb.upsertParticipant(USER_PARTICIPANT);
    // No acl.json on disk → aclVerdict('p') resolves to 'rejected' (hard deny).
    const client = await clientFor(userAgentActor('default'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'side-channel', text: 'hi', target_agent: 'other' },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/Not authorized to route users into/i);
  });

  it('rejected: a `p` tombstone on the target denies', async () => {
    harness.agentDb.upsertParticipant(USER_PARTICIPANT);
    writeAcl({ owner: 'operator', allowed: {}, rejected: { [OTHER_AGENT_ID]: { 'side-channel': 'p' } } });
    const client = await clientFor(userAgentActor('default'), harness);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'side-channel', text: 'hi', target_agent: 'other' },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/Not authorized to route users into/i);
  });

  it('askable: no grant raises an owner-directed `p` acl-edge approval and holds the push', async () => {
    const createRequestCalls: Array<Record<string, unknown>> = [];
    const mockApprovals = {
      pendingAclEdge: () => null,
      createRequest: (data: Record<string, unknown>) => { createRequestCalls.push(data); return 'appr-1'; },
    } as unknown as ApprovalHandler;
    const h = buildHarness(mockApprovals);
    h.agentDb.upsertParticipant(USER_PARTICIPANT);
    // acl.json present but no `p` grant + no tombstone → 'askable'.
    writeAcl({ owner: 'operator', allowed: {} });
    const client = await clientFor(userAgentActor('default'), h);
    const r = await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'side-channel', text: 'held please', target_agent: 'other' },
    });
    // Held is informational, not an error — the push goes through on owner grant.
    expect(r.isError).toBeFalsy();
    expect(resultText(r)).toMatch(/Push held \(ref/i);
    expect(createRequestCalls).toHaveLength(1);
    const req = createRequestCalls[0]!;
    expect(req.type).toBe('acl-edge');
    expect(req.approver).toBe('owner');
    expect(req.participant).toBe(OTHER_AGENT_ID);
    const payload = JSON.parse(req.payload as string) as { bit: string; held: Record<string, unknown> };
    expect(payload.bit).toBe('p');
    expect(payload.held).toMatchObject({ target: OTHER_AGENT_ID, channel: 'side-channel', text: 'held please' });
    h.cleanup();
  });
});

// ----------------------------------------------------------------------------
// User↔user push consent — the reactive per-edge store. A non-member
// USER pusher reaching a member USER pushee on a channel requests the pushee's
// in-band consent. granted (a prior allow-always) → deliver; askable → raise a
// pushee-directed `user-push` approval (1-day TTL); rejected (tombstone) → deny.
// Co-members still push freely (no consent gate added to the existing allow path).
// Drives `dispatchLocalPush` directly via `deliverToChannel`.
// ----------------------------------------------------------------------------

const USER_PUSH_PATH = agentPath(AGENT_FOLDER, 'config', 'user-push.json');
const PUSHER = 'u:alice@idp';
const PUSHEE = 'u:bob@idp';
const ROOM = 'room';

describe('user↔user push consent — per-edge store', () => {
  afterEach(() => {
    fs.rmSync(ACL_PATH, { force: true });
    fs.rmSync(USER_PUSH_PATH, { force: true });
  });

  // pushee is a concrete member of ROOM; pusher is absent from the ACL (non-member).
  const memberPusheeAcl = () => writeAcl({ owner: 'operator', allowed: { [PUSHEE]: { [ROOM]: 'io' } } });
  const push = (h: ReturnType<typeof buildHarness>) =>
    h.deps.deliverToChannel!(userAgentActor(ROOM), ROOM, 'ping bob', PUSHEE, ROOM, PUSHER, undefined, undefined);

  it('askable: a non-member pusher raises a pushee-directed `user-push` approval (1-day TTL), push held', async () => {
    memberPusheeAcl();
    const createReqCalls: Array<Record<string, unknown>> = [];
    const mockApprovals = {
      pendingUserPush: () => null,
      createRequest: (data: Record<string, unknown>) => { createReqCalls.push(data); return 'up-1'; },
    } as unknown as ApprovalHandler;
    const h = buildHarness(mockApprovals);
    const r = await push(h);
    expect(r.ok).toBe(false);
    expect('held' in r && r.held).toBe(true);
    expect(h.routeCalls).toHaveLength(0); // held, not delivered
    expect(createReqCalls).toHaveLength(1);
    const req = createReqCalls[0]!;
    expect(req.type).toBe('user-push');
    expect(req.approver).toBe('participant');
    expect(req.controller).toBe(PUSHEE); // the PUSHEE decides, in-band
    expect(req.participant).toBe(PUSHER);
    expect(req.expiresIn).toBe(86400); // 1-day TTL
    const payload = JSON.parse(req.payload as string) as { channel: string; pusher: string; pushee: string };
    expect(payload).toMatchObject({ channel: ROOM, pusher: PUSHER, pushee: PUSHEE });
    h.cleanup();
  });

  it('granted: a prior allow-always edge lets the push through (no new approval)', async () => {
    memberPusheeAcl();
    grantUserPush(AGENT_FOLDER, ROOM, PUSHER, PUSHEE);
    const r = await push(harness); // default harness: getApprovals throws if touched
    expect(r.ok).toBe(true);
    expect(harness.routeCalls).toHaveLength(1); // delivered
  });

  it('rejected: a tombstoned edge hard-denies, never re-asks', async () => {
    memberPusheeAcl();
    tombstoneUserPush(AGENT_FOLDER, ROOM, PUSHER, PUSHEE);
    const r = await push(harness);
    expect(r.ok).toBe(false);
    expect(harness.routeCalls).toHaveLength(0);
  });

  it('non-candidate: a non-member pushee is not askable — no conversation to push into', async () => {
    writeAcl({ owner: 'operator', allowed: {} }); // pushee is NOT a member
    const createReqCalls: Array<Record<string, unknown>> = [];
    const mockApprovals = {
      pendingUserPush: () => null,
      createRequest: (data: Record<string, unknown>) => { createReqCalls.push(data); return 'up-x'; },
    } as unknown as ApprovalHandler;
    const h = buildHarness(mockApprovals);
    const r = await push(h);
    expect(r.ok).toBe(false);
    expect(createReqCalls).toHaveLength(0); // structural deny, pushee consent cannot override
    h.cleanup();
  });

  it('regression: co-members still push freely — no consent gate on the existing allow path', async () => {
    writeAcl({ owner: 'operator', allowed: { [PUSHER]: { [ROOM]: 'io' }, [PUSHEE]: { [ROOM]: 'io' } } });
    harness.agentDb.upsertParticipant(PUSHEE); // the normal path checks participantExists
    const r = await push(harness); // default harness: no approval expected, getApprovals untouched
    expect(r.ok).toBe(true);
    expect(harness.routeCalls).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// Channel-name parser — trust-tier regex
// ----------------------------------------------------------------------------

describe('channel-name parser — user-agent (strict)', () => {
  it('user-agent accepts user-channel name', async () => {
    // Operator participant so gateInbound passes — we're isolating
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
    // hold `i`). The target gate still applies — operator handle → ALL_BITS.
    harness.agentDb.upsertParticipant(ADMIN_PARTICIPANT);
    const r = await harness.deps.deliverToChannel!(
      userAgentActor('x'),
      'y',               // target channel (differs from the self-fire channel)
      'scheduled nudge',
      ADMIN_PARTICIPANT, // target participant (operator → ALL_BITS)
      'x',               // caller channel (the self-fire's own channel)
      AGENT_ID,          // caller participant = agent self-address
    );
    expect(r.ok).toBe(true);
    expect(harness.routeCalls).toHaveLength(1);
    expect(harness.routeCalls[0]!.routing).toMatchObject({ channel: 'y', targetParticipant: ADMIN_PARTICIPANT });
  });

  it('closes the masquerade: a peer-agent caller cannot push to a user, even one with `i` (M3)', async () => {
    // The M3 write path: a peer agent (a non-user `a:` address) as caller. The
    // OLD caller-standing gate was scoped to `isUser`, so a peer skipped it and
    // only the TARGET's `i` was checked — with an operator target (ALL_BITS →
    // has `i`) the push SUCCEEDED, letting a prompt-injected peer inject into
    // the agent's user conversations. NEW: the peer caller is classified by
    // membership; with no grant on #default it is a non-member and is denied
    // outright, before the target is ever consulted.
    harness.agentDb.upsertParticipant(ADMIN_PARTICIPANT);
    const r = await harness.deps.deliverToChannel!(
      userAgentActor('intel'),
      'default',
      'injected directive',
      ADMIN_PARTICIPANT, // target with `i` (operator → ALL_BITS) — OLD would have allowed
      'intel',
      OTHER_AGENT_ID,    // caller participant = a PEER agent (a:other@srv)
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('not authorized on channel "default"');
    expect(harness.routeCalls).toHaveLength(0);
  });

  it('allows the two-axis move when the caller IS authorized on #y (no over-block)', async () => {
    // Counterpart to the denial: a caller with standing on the target channel
    // makes a legitimate two-axis push. The operator handle → ALL_BITS gives the
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

// ----------------------------------------------------------------------------
// Transport-blind addressing pins — the substrate participant discovery
// relies on. The registry is identity-keyed (`identityKey` strips the routing
// handle for `u:` rows), so the bare identity and any compound form address
// the same participant. Live delivery to bare targets is e2e-proven; these
// pin the unit boundary.
// ----------------------------------------------------------------------------

describe('transport-blind addressing — identity-keyed registry', () => {
  it('bare and compound forms of one identity both pass participantExists and dispatch', async () => {
    // Registered compound (as a routed message would be), targeted both ways.
    harness.agentDb.upsertParticipant('u:bob@srv/tg:42');
    for (const target of ['u:bob@srv', 'u:bob@srv/tg:42']) {
      const r = await harness.deps.deliverToChannel!(
        userAgentActor('x'), 'y', 'hello', target, 'x', ADMIN_PARTICIPANT,
      );
      expect(r.ok).toBe(true);
    }
    expect(harness.routeCalls).toHaveLength(2);
  });

  it('verdict deny precedes existence: an unauthorized caller learns nothing about an unregistered target', async () => {
    // u:ghost is NOT registered; alice has no standing on #y. The denial is
    // the caller-standing verdict — byte-identical to the chokepoint wording —
    // never "Unknown participant". Population-blind on deny.
    const r = await harness.deps.deliverToChannel!(
      userAgentActor('x'), 'y', 'probe', 'u:ghost@srv', 'x', 'u:alice',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(channelAuthDenial('y'));
      expect(r.reason).not.toContain('Unknown participant');
    }
    expect(harness.routeCalls).toHaveLength(0);
  });

  it('recordOutboundPush + routing carry the dispatched form — wire resolution is delivery-time', async () => {
    harness.agentDb.upsertParticipant('u:bob@srv');
    const r = await harness.deps.deliverToChannel!(
      userAgentActor('x'), 'y', 'hi', 'u:bob@srv/tg:42', 'x', ADMIN_PARTICIPANT,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const row = harness.agentDb.getOutboundPush(r.requestId);
      expect(row).toMatchObject({ target_channel: 'y', channel: 'x', participant: ADMIN_PARTICIPANT });
    }
    // The push gate passes the target through untouched.
    expect(harness.routeCalls[0]!.routing).toMatchObject({ targetParticipant: 'u:bob@srv/tg:42' });
  });
});

// ----------------------------------------------------------------------------
// Intra-agent push failure echo
// ----------------------------------------------------------------------------

describe('intra-agent push failure echo', () => {
  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  }

  function pushIdFrom(text: string): string {
    const m = text.match(/id: (req-[A-Za-z0-9-]+)\./);
    expect(m).not.toBeNull();
    return m![1]!;
  }

  it('route resolving {ok:false} marks the push rejected and echoes <cast:rejection> into the caller cell', async () => {
    harness.agentDb.upsertParticipant(ADMIN_PARTICIPANT);
    harness.routeResults.push({ ok: false, error: 'spawn failed' }); // dispatch leg
    harness.routeResults.push({ ok: true, result: null });           // echo leg
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
    // Fire-and-forget: the tool reports queued before the outcome exists.
    expect(r.isError).toBeFalsy();
    const requestId = pushIdFrom(resultText(r));

    await flush();

    // Second route call is the rejection echo into the caller's own cell.
    expect(harness.routeCalls).toHaveLength(2);
    const echo = harness.routeCalls[1]!;
    expect(echo.text).toContain('<cast:rejection');
    expect(echo.text).toContain(`request="${requestId}"`);
    expect(echo.text).toContain('spawn failed');
    const routing = echo.routing as { channel?: string; targetParticipant?: string };
    expect(routing.channel).toBe('default');
    expect(routing.targetParticipant).toBe(ADMIN_PARTICIPANT);

    // DB row marked — the echo rail's anchor.
    expect(harness.agentDb.getOutboundPush(requestId)?.status).toBe('rejected');
  });

  it('route rejecting (genuine throw) takes the same failure path', async () => {
    harness.agentDb.upsertParticipant(ADMIN_PARTICIPANT);
    harness.routeResults.push(new Error('pipeline exploded')); // dispatch leg rejects
    harness.routeResults.push({ ok: true, result: null });     // echo leg
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
    const requestId = pushIdFrom(resultText(r));

    await flush();

    expect(harness.routeCalls).toHaveLength(2);
    expect(harness.routeCalls[1]!.text).toContain('pipeline exploded');
    expect(harness.agentDb.getOutboundPush(requestId)?.status).toBe('rejected');
  });

  it('route resolving {ok:true} leaves the row open and produces no echo', async () => {
    harness.agentDb.upsertParticipant(ADMIN_PARTICIPANT);
    harness.routeResults.push({ ok: true, result: null });
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
    const requestId = pushIdFrom(resultText(r));

    await flush();

    expect(harness.routeCalls).toHaveLength(1);
    expect(harness.agentDb.getOutboundPush(requestId)?.status).toBe('open');
  });

  it('failure with no caller cell marks the row rejected without echoing', async () => {
    harness.agentDb.upsertParticipant(ADMIN_PARTICIPANT);
    harness.routeResults.push({ ok: false, error: 'spawn failed' });
    // Self-fire shape — no caller channel/participant (scheduler/service origin).
    const actor: LocalPushActor = {
      kind: 'user-agent',
      agentId: AGENT_ID,
      channel: 'default',
      participant: ADMIN_PARTICIPANT,
    };
    const result = await harness.deps.deliverToChannel!(
      actor, 'side-channel', 'hi', ADMIN_PARTICIPANT,
      undefined, undefined, undefined, undefined,
    );
    expect(result.ok).toBe(true);
    const requestId = (result as { requestId: string }).requestId;

    await flush();

    // Only the dispatch leg — no echo route call without a caller cell.
    expect(harness.routeCalls).toHaveLength(1);
    expect(harness.agentDb.getOutboundPush(requestId)?.status).toBe('rejected');
  });

  it('rejection echo text never carries a transport handle or compound form', async () => {
    harness.agentDb.upsertParticipant(ADMIN_PARTICIPANT);
    harness.routeResults.push({ ok: false, error: 'Delivery failed' });
    harness.routeResults.push({ ok: true, result: null });
    const actor: LocalPushActor = {
      kind: 'user-agent',
      agentId: AGENT_ID,
      channel: 'default',
      participant: ADMIN_PARTICIPANT,
    };
    const client = await clientFor(actor, harness);
    await client.callTool({
      name: 'conversation__push_to_channel',
      arguments: { channel: 'side-channel', text: 'hi' },
    });
    await flush();

    const echo = harness.routeCalls[1]!;
    // Blindness is total: the echo names the agent and the request id, never a wire.
    expect(echo.text).not.toContain('tg:');
    expect(echo.text).not.toContain('web:');
    expect(echo.text).not.toMatch(/u:[^"<\s]+\//);
  });
});
