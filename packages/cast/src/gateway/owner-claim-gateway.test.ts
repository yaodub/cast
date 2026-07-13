/**
 * Gateway interception of `/claim`.
 *
 * The security-critical property: a `/claim <code>` message is intercepted at
 * the gateway and routed as an `owner-claim` control packet — it must NEVER take
 * the normal conversation path to the runner, or the bearer code would reach the
 * agent's LLM. These assert the interception fires and the conversation path is
 * skipped (no per-message `routeEvent` ack, no `ingested` routeMessage).
 */
import { describe, it, expect, vi } from 'vitest';

import { MessageGateway } from './message-gateway.js';

function makeGateway() {
  const routeMessage = vi.fn();
  const routeEvent = vi.fn();
  const bus = {
    resolve: vi.fn(() => ({})),       // target agent resolves (handler exists)
    routeMessage,
    routeEvent,
    resolveAddress: vi.fn(),
    getMetadata: vi.fn(),
  };
  const identityProvider = {
    // operator handle short-circuits to its own identity (no auto-register, no firewall)
    resolve: vi.fn((h: string) => ({ id: h, declaredName: 'op', handle: h })),
    register: vi.fn(),
  };
  const gw = new MessageGateway({
    bus: bus as never,
    transports: () => [],
    identityProvider: identityProvider as never,
  });
  return { gw, routeMessage, routeEvent };
}

describe('gateway /claim interception', () => {
  it('routes a code as an owner-claim control packet, not a conversation', () => {
    const { gw, routeMessage, routeEvent } = makeGateway();
    gw.ingestInbound('cli:op', 'a:agent@iss', '/claim a3f9c20b14', 'cli:op');
    // exactly one route — the owner-claim — and no conversation-path ack
    expect(routeMessage).toHaveBeenCalledTimes(1);
    expect(routeMessage).toHaveBeenCalledWith(
      'cli:op', 'a:agent@iss',
      { type: 'owner-claim', code: 'a3f9c20b14', channel: 'default' },
    );
    expect(routeEvent).not.toHaveBeenCalled();
  });

  it('carries the arrival channel through to the owner-claim packet', () => {
    const { gw, routeMessage } = makeGateway();
    gw.ingestInbound('cli:op', 'a:agent@iss', '/claim abc', 'cli:op', { channel: 'room' });
    expect(routeMessage).toHaveBeenCalledWith(
      'cli:op', 'a:agent@iss',
      { type: 'owner-claim', code: 'abc', channel: 'room' },
    );
  });

  // A lookalike like `/claimfoo` does NOT match (`trimmed === '/claim' ||
  // startsWith('/claim ')`) and falls through to the normal conversation path —
  // verified by the prefix guard itself; not exercised here, since the
  // fall-through hits the gateway packet store this unit test doesn't wire up.
});
