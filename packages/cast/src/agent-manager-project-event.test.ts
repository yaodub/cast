/**
 * `Bus.projectEventForIdentity` + `AgentManager.projectEventForIdentity` —
 * per-identity ACL gate for outbound bus events on the web transport.
 *
 * Tests target the public Bus method (which delegates to the agent
 * handler's `projectEventForIdentity` hook), exercising the full path:
 * `Bus → AgentManager → checkAcl`. Prototype-harness AgentManager via
 * `Object.create` for the same reason as `agent-manager-pair.test.ts` —
 * constructing a real manager would require a half-dozen collaborators
 * unrelated to the ACL gate under test.
 *
 * Replaces `transports/web.test.ts` (which tested the deleted
 * `decideEventDelivery` helper after a later refactor moved
 * event-delivery ACL out of the transport).
 *
 * Both-branches discipline: every ACL-gated
 * path is exercised with an allow case and a reject case — always-allow
 * stubs would let the gate ship untested.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

import type { ConsoleIsolation } from './config.js';

let testIsolation: ConsoleIsolation = 'normal';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    agentPath: (folder: string, ...segments: string[]) =>
      path.join('/tmp/test-agents', folder, ...segments),
    readServerConfig: () => ({
      consoleModel: 'claude-opus-4-7',
      consoleIsolation: testIsolation,
    }),
  };
});

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

import fs from 'fs';
import { Bus, type BusHandler } from './gateway/bus.js';
import { AgentManager } from './agent/agent-manager.js';
import { _setMockWatcher } from './lib/config-reader.js';
import type { Evt } from './types.js';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

const watcherFiles = new Map<string, string>();

beforeEach(() => {
  watcherFiles.clear();
  _setMockWatcher({ get: (p) => watcherFiles.get(p) ?? null });
  mockExistsSync.mockReset();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReset();
  mockReadFileSync.mockImplementation(() => { throw new Error('not found'); });
  testIsolation = 'normal';
});

const AGENT_ADDR = 'agent:test-agent';
const AGENT_FOLDER = 'test-agent';
const AGENT_ALIAS = 'test-agent';

/**
 * Minimal AgentManager harness — enough fields for `projectEventForIdentity`
 * to operate without constructing the full manager. Method walks the
 * prototype chain to find `projectEventForIdentity` and the inherited
 * `handleMessage`/`handleEvent` (required by `BusHandler`).
 */
function makeAgentHandler(bus: Bus): AgentManager {
  const harness = Object.create(AgentManager.prototype) as AgentManager;
  Object.assign(harness, {
    folder: AGENT_FOLDER,
    agentId: AGENT_ADDR,
    bus,
  });
  return harness;
}

function busWithAgent(): Bus {
  const bus = new Bus();
  const handler = makeAgentHandler(bus);
  bus.register(AGENT_ADDR, handler, 'exact', {
    label: AGENT_ALIAS,
    type: 'agent',
    folderPath: AGENT_FOLDER,
  });
  return bus;
}

const noopHandler: BusHandler = {
  handleMessage: async () => {},
  handleEvent: async () => {},
};

function mockAclFile(content: object, folder = AGENT_FOLDER): void {
  const aclPath = path.join('/tmp/test-agents', folder, 'config', 'acl.json');
  watcherFiles.set(aclPath, JSON.stringify(content));
}

const PEER_ALICE = 'u:alice@test';
const PEER_BOB = 'u:bob@test';

function typingEvt(channel = 'default'): Evt {
  return { type: 'typing', from: AGENT_ADDR, to: 'web', data: { channel } };
}

function typingStoppedEvt(channel = 'default'): Evt {
  return { type: 'typing_stopped', from: AGENT_ADDR, to: 'web', data: { channel } };
}

function lifecycleEvt(channel = 'default'): Evt {
  return { type: 'lifecycle', from: AGENT_ADDR, to: 'web', data: { phase: 'fresh_conversation', channel } };
}

function uiDirectiveEvt(channel = 'default'): Evt {
  return {
    type: 'ui_directive',
    from: AGENT_ADDR,
    to: 'web',
    data: {
      channel,
      directive: { type: 'show', target: '/agents/foo', reason: 'demo' },
    },
  };
}

function messageReceivedEvt(channel = 'default'): Evt {
  return {
    type: 'message_received',
    from: AGENT_ADDR,
    to: 'web',
    data: { id: 'pkt-1', channel, timestamp: '2026-05-15T00:00:00.000Z' },
  };
}

function approvalStaleEvt(): Evt {
  return {
    type: 'approval_stale',
    from: AGENT_ADDR,
    to: 'web',
    data: { approvalId: 'apr-1', status: 'expired', summary: 's' },
  };
}

// ---------------------------------------------------------------------------
// ACL gate — i-bit allow vs reject, both branches
// ---------------------------------------------------------------------------

describe('Bus.projectEventForIdentity — ACL gate (both branches)', () => {
  it('allows delivery when peer has the i bit on the event channel', () => {
    mockAclFile({ allowed: { [PEER_ALICE]: { default: 'io' } } });
    const decision = busWithAgent().projectEventForIdentity(typingEvt(), PEER_ALICE);
    expect(decision).toEqual({ alias: AGENT_ALIAS, channel: 'default' });
  });

  it('rejects delivery when peer lacks the i bit (has only a)', () => {
    mockAclFile({ allowed: { [PEER_BOB]: { default: 'a' } } });
    const decision = busWithAgent().projectEventForIdentity(typingEvt(), PEER_BOB);
    expect(decision).toBeNull();
  });

  it('rejects delivery when the peer is not in the ACL at all', () => {
    mockAclFile({ allowed: { [PEER_ALICE]: { default: 'io' } } });
    const decision = busWithAgent().projectEventForIdentity(typingEvt(), PEER_BOB);
    expect(decision).toBeNull();
  });

  it('rejects delivery when no acl.json exists (secure default — deny all external)', () => {
    // No mockAclFile — file-cache miss → empty bits.
    const decision = busWithAgent().projectEventForIdentity(typingEvt(), PEER_ALICE);
    expect(decision).toBeNull();
  });

  it('honors wildcard channel grants (peers."*")', () => {
    mockAclFile({ allowed: { [PEER_ALICE]: { '*': 'io' } } });
    const decision = busWithAgent().projectEventForIdentity(typingEvt('archive'), PEER_ALICE);
    expect(decision).toEqual({ alias: AGENT_ALIAS, channel: 'archive' });
  });
});

// ---------------------------------------------------------------------------
// Channel-specific filtering — i on one channel ≠ i on another
// ---------------------------------------------------------------------------

describe('Bus.projectEventForIdentity — channel-specific ACL', () => {
  it('allows on the granted channel, rejects on a different channel (both branches)', () => {
    mockAclFile({ allowed: { [PEER_ALICE]: { default: 'io', archive: '' } } });
    const bus = busWithAgent();
    const allow = bus.projectEventForIdentity(typingEvt('default'), PEER_ALICE);
    const reject = bus.projectEventForIdentity(typingEvt('archive'), PEER_ALICE);
    expect(allow).toEqual({ alias: AGENT_ALIAS, channel: 'default' });
    expect(reject).toBeNull();
  });

  it('honors system-owned channels — non-admin peers always denied on __design even with peers."*"', () => {
    // System-owned channels short-circuit the peers table; the only way to
    // hold `i` on them is via CONSOLE_INFRA_GRANTS (admin/local identities).
    mockAclFile({ allowed: { [PEER_ALICE]: { '*': 'ioaqr' } } });
    const decision = busWithAgent().projectEventForIdentity(typingEvt('__design'), PEER_ALICE);
    expect(decision).toBeNull();
  });

  it('allows the operator on any channel — operator tier has full implicit access', () => {
    // No ACL file — the operator (resolve().id is the bare handle) short-circuits
    // to full bits before file lookup.
    const decision = busWithAgent().projectEventForIdentity(typingEvt('__design'), 'admin:local');
    expect(decision).toEqual({ alias: AGENT_ALIAS, channel: '__design' });
  });
});

// ---------------------------------------------------------------------------
// Sender shape — Bus-level filtering before delegation
// ---------------------------------------------------------------------------

describe('Bus.projectEventForIdentity — sender filtering (bus-level)', () => {
  it('drops events from unknown bus entities (no metadata)', () => {
    mockAclFile({ allowed: { [PEER_ALICE]: { default: 'io' } } });
    const bus = busWithAgent();
    const evt: Evt = { type: 'typing', from: 'agent:ghost', to: 'web', data: { channel: 'default' } };
    const decision = bus.projectEventForIdentity(evt, PEER_ALICE);
    expect(decision).toBeNull();
  });

  it('drops events from non-agent entities (services have no ACL surface)', () => {
    const bus = new Bus();
    bus.register('service:bgtask', noopHandler, 'exact', {
      label: 'bgtask',
      type: 'service',
      folderPath: 'svc',
    });
    mockAclFile({ allowed: { [PEER_ALICE]: { default: 'io' } } }, 'svc');
    const evt: Evt = { type: 'typing', from: 'service:bgtask', to: 'web', data: { channel: 'default' } };
    const decision = bus.projectEventForIdentity(evt, PEER_ALICE);
    expect(decision).toBeNull();
  });

  it('returns null when an agent handler has no projectEventForIdentity hook', () => {
    // Agent entity registered with a vanilla BusHandler that omits the
    // optional hook — bus must not invoke an undefined method.
    const bus = new Bus();
    bus.register(AGENT_ADDR, noopHandler, 'exact', {
      label: AGENT_ALIAS,
      type: 'agent',
      folderPath: AGENT_FOLDER,
    });
    mockAclFile({ allowed: { [PEER_ALICE]: { default: 'io' } } });
    const decision = bus.projectEventForIdentity(typingEvt(), PEER_ALICE);
    expect(decision).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// All Evt variants route through the same gate
// ---------------------------------------------------------------------------

describe('Bus.projectEventForIdentity — every Evt variant', () => {
  it('routes typing, typing_stopped, lifecycle, ui_directive, message_received on their own channel', () => {
    mockAclFile({ allowed: { [PEER_ALICE]: { default: 'io', archive: 'io' } } });
    const bus = busWithAgent();

    expect(bus.projectEventForIdentity(typingEvt('default'), PEER_ALICE)).toEqual({
      alias: AGENT_ALIAS, channel: 'default',
    });
    expect(bus.projectEventForIdentity(typingStoppedEvt('archive'), PEER_ALICE)).toEqual({
      alias: AGENT_ALIAS, channel: 'archive',
    });
    expect(bus.projectEventForIdentity(lifecycleEvt('default'), PEER_ALICE)).toEqual({
      alias: AGENT_ALIAS, channel: 'default',
    });
    expect(bus.projectEventForIdentity(uiDirectiveEvt('default'), PEER_ALICE)).toEqual({
      alias: AGENT_ALIAS, channel: 'default',
    });
    expect(bus.projectEventForIdentity(messageReceivedEvt('archive'), PEER_ALICE)).toEqual({
      alias: AGENT_ALIAS, channel: 'archive',
    });
  });

  it('treats approval_stale as channel=default (the approval flow is default-channel-only)', () => {
    mockAclFile({ allowed: { [PEER_ALICE]: { default: 'io' } } });
    const decision = busWithAgent().projectEventForIdentity(approvalStaleEvt(), PEER_ALICE);
    expect(decision).toEqual({ alias: AGENT_ALIAS, channel: 'default' });
  });

  it('approval_stale is denied when peer has no default-channel access', () => {
    mockAclFile({ allowed: { [PEER_ALICE]: { archive: 'io' } } });
    const decision = busWithAgent().projectEventForIdentity(approvalStaleEvt(), PEER_ALICE);
    expect(decision).toBeNull();
  });
});
