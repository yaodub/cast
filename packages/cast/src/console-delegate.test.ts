/**
 * Cross-console push rules matrix — channel-based guard. Pure
 * function, no mocks beyond the isolation-mode hook.
 *
 * Identifiers here are **bus addresses** (same shape as `agentAuth.address`
 * in prod — `a:<folder>@<issuer>`). `resolveAgentByLabel` returns a bus
 * address, and `currentAgentId` is also a bus address. Mixing in a folder
 * path here would recreate the same shape-mismatch cockroach this test
 * is meant to catch.
 *
 * The isolation mode is mocked at module level so tests can flip between
 * `strict` and `normal`; `beforeEach` resets to `normal` (production
 * default). Tests that target strict-mode behavior call `setIsolation`
 * explicitly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ConsoleIsolation } from './config.js';

let testIsolation: ConsoleIsolation = 'normal';
function setIsolation(mode: ConsoleIsolation): void {
  testIsolation = mode;
}

vi.mock('./config.js', () => ({
  readServerConfig: () => ({
    consoleModel: 'claude-opus-4-7',
    consoleIsolation: testIsolation,
  }),
}));

import { evaluatePush } from './console/shared/delegate.js';
import { consoleSourceUserTargetGuard, intraAgentInfraGuard } from './console/shared/delegation-guards.js';

const SELF_ID = 'a:self@srv';
const OTHER_ID = 'a:other@srv';

const byLabel = (label: string): string | undefined => {
  if (label === 'self') return SELF_ID;
  if (label === 'other') return OTHER_ID;
  if (label === 'config-manager') return 'console:config-manager';
  return undefined;
};

beforeEach(() => {
  setIsolation('normal');
});

// ---------------------------------------------------------------------------
// evaluatePush — server-scope (DM/CM/SM) only callers.
//
// Server-scope consoles have bus address `console:*`, which never resolves
// equal to a target agent's address — so same-agent cases are unreachable
// from this evaluator. Per-agent consoles (`__design`, `__configure`)
// register the agent-side push verb in `console/tools.ts`; intra-agent
// rules for them live in `handlePushToChannel` via the guards composed in
// `agent/mcp-server.ts`.
// ---------------------------------------------------------------------------

describe('evaluatePush — mode-independent paths', () => {
  it('allows cross-agent delegation to a user channel', () => {
    const d = evaluatePush({
      currentAgentId: 'console:design-manager',
      currentChannelName: 'default',
      targetAgentLabel: 'other',
      targetChannel: 'general',
      resolveAgentByLabel: byLabel,
    });
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.targetAgentId).toBe(OTHER_ID);
  });

  it('blocks unknown target label', () => {
    const d = evaluatePush({
      currentAgentId: 'console:design-manager',
      currentChannelName: 'default',
      targetAgentLabel: 'ghost',
      targetChannel: 'general',
      resolveAgentByLabel: byLabel,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/Unknown agent: "ghost"/);
  });

  it('blocks when cross-agent delegation is not configured', () => {
    const d = evaluatePush({
      currentAgentId: 'console:design-manager',
      currentChannelName: 'default',
      targetAgentLabel: 'other',
      targetChannel: '__design',
      resolveAgentByLabel: undefined,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/not configured/i);
  });

  it('PERMANENT: CM has no outbound grant to __design in either mode (no exfil-carrier reverse)', () => {
    for (const mode of ['strict', 'normal'] as const) {
      setIsolation(mode);
      const d = evaluatePush({
        currentAgentId: 'console:config-manager',
        currentChannelName: 'default',
        targetAgentLabel: 'other',
        targetChannel: '__design',
        resolveAgentByLabel: byLabel,
      });
      expect(d.allow).toBe(false);
    }
  });

  it('agents have no entry in any OUTBOUND_ACLS table — cross-agent infra push always denied for agent senders', () => {
    // Note: per-agent consoles do not call evaluatePush anymore; this case
    // models a hypothetical agent-side caller hitting the cross-agent infra
    // path. The OUTBOUND_ACLS miss is still the gate.
    for (const mode of ['strict', 'normal'] as const) {
      setIsolation(mode);
      const d = evaluatePush({
        currentAgentId: SELF_ID,
        currentChannelName: '__configure',
        targetAgentLabel: 'other',
        targetChannel: '__configure',
        resolveAgentByLabel: byLabel,
      });
      expect(d.allow).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// evaluatePush — strict-mode-specific behavior
// ---------------------------------------------------------------------------

describe('evaluatePush — strict mode', () => {
  beforeEach(() => setIsolation('strict'));

  it('blocks DM → __configure (DM has no grant in strict)', () => {
    const d = evaluatePush({
      currentAgentId: 'console:design-manager',
      currentChannelName: 'default',
      targetAgentLabel: 'other',
      targetChannel: '__configure',
      resolveAgentByLabel: byLabel,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/Console isolation is currently `strict`/);
  });

  it('blocks DM → CM (no cross-manager grant in strict)', () => {
    const d = evaluatePush({
      currentAgentId: 'console:design-manager',
      currentChannelName: 'default',
      targetAgentLabel: 'config-manager',
      targetChannel: 'default',
      resolveAgentByLabel: byLabel,
    });
    expect(d.allow).toBe(false);
  });

  it('allows DM → __design (the one grant DM holds in strict)', () => {
    const d = evaluatePush({
      currentAgentId: 'console:design-manager',
      currentChannelName: 'default',
      targetAgentLabel: 'other',
      targetChannel: '__design',
      resolveAgentByLabel: byLabel,
    });
    expect(d.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluatePush — normal-mode-specific behavior
// ---------------------------------------------------------------------------

describe('evaluatePush — normal mode', () => {
  beforeEach(() => setIsolation('normal'));

  it('allows DM → __configure on any agent (new grant in normal)', () => {
    const d = evaluatePush({
      currentAgentId: 'console:design-manager',
      currentChannelName: 'default',
      targetAgentLabel: 'other',
      targetChannel: '__configure',
      resolveAgentByLabel: byLabel,
    });
    expect(d.allow).toBe(true);
  });

  it('allows DM → CM cross-manager push', () => {
    const d = evaluatePush({
      currentAgentId: 'console:design-manager',
      currentChannelName: 'default',
      targetAgentLabel: 'config-manager',
      targetChannel: 'default',
      resolveAgentByLabel: byLabel,
    });
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.targetAgentId).toBe('console:config-manager');
  });
});

// ---------------------------------------------------------------------------
// intraAgentInfraGuard — direct unit tests
// ---------------------------------------------------------------------------

describe('intraAgentInfraGuard', () => {
  beforeEach(() => setIsolation('normal'));

  it('PERMANENT: denies __configure → __design in both modes (exfil carrier)', () => {
    for (const mode of ['strict', 'normal'] as const) {
      setIsolation(mode);
      const r = intraAgentInfraGuard({
        sameAgent: true,
        sourceChannel: '__configure',
        targetChannel: '__design',
      });
      expect(r.deny).toBe(true);
      if (r.deny) expect(r.reason).toMatch(/Configure holds PII state and Design has network egress/);
    }
  });

  it('strict mode: denies __design → __configure', () => {
    setIsolation('strict');
    const r = intraAgentInfraGuard({
      sameAgent: true,
      sourceChannel: '__design',
      targetChannel: '__configure',
    });
    expect(r.deny).toBe(true);
    if (r.deny) expect(r.reason).toMatch(/Console isolation is currently `strict`/);
  });

  it('normal mode: allows __design → __configure', () => {
    setIsolation('normal');
    const r = intraAgentInfraGuard({
      sameAgent: true,
      sourceChannel: '__design',
      targetChannel: '__configure',
    });
    expect(r.deny).toBe(false);
  });

  it('allows same-agent + user channel (not infra) — caller applies own rules', () => {
    const r = intraAgentInfraGuard({
      sameAgent: true,
      sourceChannel: '__configure',
      targetChannel: 'general',
    });
    expect(r.deny).toBe(false);
  });

  it('allows cross-agent + __design — guard returns deny:false; sender-table is the real gate', () => {
    const r = intraAgentInfraGuard({
      sameAgent: false,
      sourceChannel: 'default',
      targetChannel: '__design',
    });
    expect(r.deny).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// consoleSourceUserTargetGuard — direct unit tests
// ---------------------------------------------------------------------------

describe('consoleSourceUserTargetGuard', () => {
  it('denies same-agent push from __configure to a user channel', () => {
    const r = consoleSourceUserTargetGuard({
      sameAgent: true,
      sourceChannel: '__configure',
      targetChannel: 'general',
    });
    expect(r.deny).toBe(true);
    if (r.deny) expect(r.reason).toMatch(/own user channel/);
  });

  it('denies same-agent push from __design to a user channel', () => {
    const r = consoleSourceUserTargetGuard({
      sameAgent: true,
      sourceChannel: '__design',
      targetChannel: 'default',
    });
    expect(r.deny).toBe(true);
  });

  it('allows same-agent push from a user channel to another user channel (not its concern)', () => {
    const r = consoleSourceUserTargetGuard({
      sameAgent: true,
      sourceChannel: 'default',
      targetChannel: 'research',
    });
    expect(r.deny).toBe(false);
  });

  it('allows same-agent push from a console channel to another console channel (intraAgentInfraGuard owns this)', () => {
    const r = consoleSourceUserTargetGuard({
      sameAgent: true,
      sourceChannel: '__design',
      targetChannel: '__configure',
    });
    expect(r.deny).toBe(false);
  });

  it('allows cross-agent push from a console channel (only intra-agent is gated here)', () => {
    const r = consoleSourceUserTargetGuard({
      sameAgent: false,
      sourceChannel: '__design',
      targetChannel: 'general',
    });
    expect(r.deny).toBe(false);
  });

  it('allows when sourceChannel is undefined (no claim to gate)', () => {
    const r = consoleSourceUserTargetGuard({
      sameAgent: true,
      sourceChannel: undefined,
      targetChannel: 'general',
    });
    expect(r.deny).toBe(false);
  });
});
