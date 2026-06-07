/**
 * Route-parity assertion test.
 *
 * Both `agent-route.routeMessage` (user channels via AgentManager) and
 * `ConsoleManager.route` (console channels) are now thin façades over
 * `Conversations.deliver` / `Conversations.scheduleTtl`. The drift class this
 * guards: a side effect that must run on either side gets added to one route
 * and silently forgotten in the other.
 *
 * This is a static-text check, not a behavioral one — fragile to renames, but
 * the renames are easy to update and the test catches the actual drift class
 * (silent omission) which behavioral tests with always-allow mocks miss.
 *
 * The G5 trust-model guards remain critical: `ConsoleManager.route` must not
 * re-apply ACL gates that already ran at the bus boundary, and the absence is
 * load-bearing for local intra-agent dispatch (see comment in
 * `console/console-manager.ts:route`).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Agent-side routing lives in `agent-route.ts`; `agent-manager.ts` holds the
// thin wrapper that forwards into it. Concatenate so the parity grep sees
// the algorithm regardless of which file the line ended up in.
const AGENT_ROUTE = [
  fs.readFileSync(path.resolve(__dirname, 'agent/agent-manager.ts'), 'utf-8'),
  fs.readFileSync(path.resolve(__dirname, 'agent/agent-route.ts'), 'utf-8'),
].join('\n');
const CONSOLE_ROUTE = fs.readFileSync(
  path.resolve(__dirname, 'console/console-manager.ts'),
  'utf-8',
);

/**
 * Invariants both routes must implement, expressed as grepable structural
 * patterns over their façade calls.
 */
const SHARED_INVARIANTS: { name: string; agentPattern: RegExp; consolePattern: RegExp; reason: string }[] = [
  {
    name: 'delivery through Conversations façade',
    agentPattern: /conversations\.deliver</,
    consolePattern: /conversations\.deliver</,
    reason: 'Both routes must hand off to Conversations.deliver — slot acquisition, runner construction, and respawn-cycle ownership live in the façade.',
  },
  {
    name: 'TTL scheduling through Conversations.scheduleTtl',
    agentPattern: /scheduleTtl</,
    consolePattern: /conversations\.scheduleTtl</,
    reason: 'Both routes must schedule the idle-timeout via the façade so TTL ownership survives runner teardown (the structural fix from the audit).',
  },
  {
    name: 'isSystemSender TTL guard',
    agentPattern: /isSystemSender|isSystemInitiated/,
    consolePattern: /isSystemSender|isSystemInitiated/,
    reason: 'Both routes must skip TTL reset for system-flavored senders so scheduler activity does not extend operator idle clocks.',
  },
  {
    name: 'participant tracking via upsertParticipant',
    agentPattern: /upsertParticipant\(/,
    consolePattern: /upsertParticipant\(/,
    reason: 'Both routes must register the participant so the participantExists gate recognises subsequent delegations.',
  },
];

/**
 * Invariants present in the agent route but intentionally absent in the
 * console route. Each must have a written rationale.
 */
const DOCUMENTED_EXCEPTIONS: { invariant: string; reason: string }[] = [
  {
    invariant: 'persistAttachment',
    reason: 'Console channels are transient authoring surfaces — attachments are dropped with a warn (see ConsoleManager.route attachments handling). Message bodies route to the per-agent / server-scope console.db via the runner\'s messageLog slot (gated on channel.log_messages), not into the user-channel agent.db.',
  },
  {
    invariant: 'cleanup-message turn on expiry',
    reason: 'Console channels have cleanupEnabled: false — IdleTimeoutMeta.cleanup is undefined for console scopes, so ConversationTtl.fire hard-expires without a cleanup turn. AgentManager composes profile.cleanup + channel.cleanup; ConsoleManager has neither.',
  },
  {
    invariant: 'agent.db request closing on expiry',
    reason: 'Console sessions have no message log and no requests — `onExpiryComplete` in ConsoleManager only releases the slot/TTL via the façade; no agent.db side effects.',
  },
];

describe('route parity', () => {
  for (const inv of SHARED_INVARIANTS) {
    it(`agent route enforces "${inv.name}"`, () => {
      expect(AGENT_ROUTE).toMatch(inv.agentPattern);
    });
    it(`ConsoleManager.route enforces "${inv.name}" — ${inv.reason}`, () => {
      expect(CONSOLE_ROUTE).toMatch(inv.consolePattern);
    });
  }

  it('documented exceptions are non-empty (deters silent removal)', () => {
    expect(DOCUMENTED_EXCEPTIONS.length).toBeGreaterThan(0);
    for (const exc of DOCUMENTED_EXCEPTIONS) {
      expect(exc.reason.length).toBeGreaterThan(40);
    }
  });
});

/**
 * G5 regression guard — receiver-side ACL gate must NOT exist in
 * `ConsoleManager.route`.
 *
 * The G5 silent-drop bug (intra-agent `__design` → `__configure` push
 * dropped at the receiver) was caused by a duplicate ACL gate inside
 * `ConsoleManager.route` that re-applied a check already performed by
 * `agent-bus-handler.ts` for bus arrivals and was wrong-shaped for
 * local intra-agent dispatch (senderId === host agent's own bus
 * address has no entry in the infra-grants table). Trust boundaries
 * live at the bus; local dispatch is intra-agent operator-trust
 * enforced by sender-side guards in `handlePushToChannel`.
 *
 * If a future change reintroduces `checkAcl(` or `gateInbound(`
 * inside `ConsoleManager.route`, this test fails — forcing the author
 * to read the comment in console-manager.ts explaining why the gate
 * is intentionally absent.
 */
describe('ConsoleManager.route — trust model (G5)', () => {
  function consoleRouteBody(): string {
    // Extract the body of the `route(` method from the source — between
    // the opening of the method and the next method declaration. We use
    // the simpler "everything after `route(`" trick because there is
    // exactly one `route(` in the class.
    const start = CONSOLE_ROUTE.indexOf('  route(');
    expect(start).toBeGreaterThan(-1);
    // End at the next top-level method (`private buildRunnerOpts`).
    const end = CONSOLE_ROUTE.indexOf('  private buildRunnerOpts', start);
    expect(end).toBeGreaterThan(start);
    return CONSOLE_ROUTE.slice(start, end);
  }

  it('does not invoke checkAcl (gate lives upstream at agent-bus-handler.ts)', () => {
    expect(consoleRouteBody()).not.toMatch(/checkAcl\(/);
  });

  it('does not invoke gateInbound (gate lives upstream at agent-bus-handler.ts)', () => {
    expect(consoleRouteBody()).not.toMatch(/gateInbound\(/);
  });

  it('does not emit the "Console-channel message blocked" rejection', () => {
    expect(CONSOLE_ROUTE).not.toMatch(/Console-channel message blocked/);
  });

  it('does not import checkAcl or gateInbound (no future easy re-add)', () => {
    // The imports were removed when the gate was deleted. Re-adding them
    // would re-enable easy re-introduction of the duplicate gate. If a
    // future check genuinely needs ACL here, this test forces the author
    // to update both this assertion and the trust-model comment.
    expect(CONSOLE_ROUTE).not.toMatch(/from '\.\.\/auth\/acl\.js'/);
  });
});
