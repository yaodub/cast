import { beforeEach, describe, expect, it, vi } from 'vitest';

// membershipBits is the room-placement oracle. Stub it so each test drives the
// verdict with controlled placement — member in some cases, empty in others
// (never an always-member stub, per the security-gate test discipline). The
// real `membershipBits` (no `*`, no operator short-circuit) is covered at the
// fs boundary in acl.test.ts; here we exercise the verdict logic on top of it.
vi.mock('./auth/acl.js', () => ({
  membershipBits: vi.fn(),
  isOperatorOrOwner: vi.fn(),
}));

import { isOperatorOrOwner, membershipBits } from './auth/acl.js';
import { canPushCrossConversation, resolveCallerContext } from './auth/conversation-context.js';
import { DEFAULT_CHANNEL } from './conversations/types.js';
import { Bus } from './gateway/bus.js';

const OWN = 'a:me@srv';
const FOLDER = 'test-agent';
const bus = new Bus();
const OPEN = DEFAULT_CHANNEL; // show_co_participants: true
const ISOLATED = { ...DEFAULT_CHANNEL, show_co_participants: false };

/** Drive the placement oracle: map of `${address}|${channel}` → bits. */
function stubMembership(map: Record<string, string>): void {
  vi.mocked(membershipBits).mockImplementation(
    (_bus, _folder, addr, channel) => map[`${addr}|${channel}`] ?? '',
  );
}

/** Drive the operator/owner oracle: the set of addresses that are god-mode. */
function stubOperators(...operators: string[]): void {
  vi.mocked(isOperatorOrOwner).mockImplementation((_bus, _folder, addr) => operators.includes(addr));
}

beforeEach(() => {
  vi.mocked(membershipBits).mockReset();
  vi.mocked(isOperatorOrOwner).mockReset();
  stubOperators(); // default: nobody is operator/owner unless a test says so
});

// ---------------------------------------------------------------------------
// resolveCallerContext — the discriminant, both branches
// ---------------------------------------------------------------------------

describe('resolveCallerContext', () => {
  it('classifies a null participant as owner-context', () => {
    stubMembership({});
    expect(resolveCallerContext(null, 'default', OWN, bus, FOLDER)).toEqual({ class: 'owner' });
    expect(resolveCallerContext(undefined, 'default', OWN, bus, FOLDER)).toEqual({ class: 'owner' });
  });

  it("classifies the agent's own address as owner-context", () => {
    stubMembership({ [`${OWN}|default`]: 'io' }); // even if it had bits, own-address wins
    expect(resolveCallerContext(OWN, 'default', OWN, bus, FOLDER)).toEqual({ class: 'owner' });
  });

  it('classifies the operator/owner as owner-context despite empty membership (god-mode)', () => {
    stubMembership({}); // operator is a member of nothing…
    stubOperators('admin:local'); // …but is god-mode
    expect(resolveCallerContext('admin:local', 'default', OWN, bus, FOLDER)).toEqual({ class: 'owner' });
  });

  it('classifies a placed user as user-member', () => {
    stubMembership({ 'u:alice@srv|default': 'io' });
    expect(resolveCallerContext('u:alice@srv', 'default', OWN, bus, FOLDER)).toEqual({
      class: 'user-member',
      bits: 'io',
    });
  });

  it('classifies a placed peer agent as agent-member', () => {
    stubMembership({ 'a:peer@srv|room': 'a' });
    expect(resolveCallerContext('a:peer@srv', 'room', OWN, bus, FOLDER)).toEqual({
      class: 'agent-member',
      bits: 'a',
    });
  });

  it('classifies an unplaced caller as non-member', () => {
    stubMembership({}); // no placement anywhere
    expect(resolveCallerContext('u:alice@srv', 'default', OWN, bus, FOLDER)).toEqual({
      class: 'non-member',
    });
    expect(resolveCallerContext('a:peer@srv', 'default', OWN, bus, FOLDER)).toEqual({
      class: 'non-member',
    });
  });
});

// ---------------------------------------------------------------------------
// canPushCrossConversation — the full verdict matrix, both branches
// ---------------------------------------------------------------------------

describe('canPushCrossConversation', () => {
  function push(
    caller: string | null,
    target: string,
    channelConfig = OPEN,
    channel = 'default',
  ) {
    return canPushCrossConversation({
      caller,
      target,
      channel,
      ownAgentId: OWN,
      bus,
      agentFolder: FOLDER,
      channelConfig,
    });
  }

  it('owner-allow: a self/system caller may push regardless of target placement', () => {
    stubMembership({}); // target not even placed — owner tier bypasses the room
    expect(push(null, 'u:bob@srv')).toEqual({ allowed: true });
    expect(push(OWN, 'u:bob@srv')).toEqual({ allowed: true });
  });

  it('user-member-allow: a placed user reaches a placed user in an open room', () => {
    stubMembership({ 'u:alice@srv|default': 'io', 'u:bob@srv|default': 'io' });
    expect(push('u:alice@srv', 'u:bob@srv')).toEqual({ allowed: true });
  });

  it('agent-member-allow: a placed peer agent reaches a placed user', () => {
    stubMembership({ 'a:peer@srv|default': 'a', 'u:bob@srv|default': 'io' });
    expect(push('a:peer@srv', 'u:bob@srv')).toEqual({ allowed: true });
  });

  it('open-via-undefined-config: absent channelConfig is treated as open', () => {
    stubMembership({ 'u:alice@srv|default': 'io', 'u:bob@srv|default': 'io' });
    const v = canPushCrossConversation({
      caller: 'u:alice@srv',
      target: 'u:bob@srv',
      channel: 'default',
      ownAgentId: OWN,
      bus,
      agentFolder: FOLDER,
      channelConfig: undefined,
    });
    expect(v).toEqual({ allowed: true });
  });

  it('non-member-reject: an unplaced caller is denied', () => {
    stubMembership({ 'u:bob@srv|default': 'io' }); // target placed, caller is not
    const v = push('u:alice@srv', 'u:bob@srv');
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/not authorized/i);
  });

  it('agent-target-reject: a member cannot push to a non-user (loop fence)', () => {
    stubMembership({ 'u:alice@srv|default': 'io', 'a:peer@srv|default': 'a' });
    const v = push('u:alice@srv', 'a:peer@srv');
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/must be users/i);
  });

  it('target-not-member-reject: a member cannot push to an unplaced user', () => {
    stubMembership({ 'u:alice@srv|default': 'io' }); // target bob not placed
    const v = push('u:alice@srv', 'u:bob@srv');
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/not a member/i);
  });

  it('isolated-posture-reject: a member reaching ANOTHER user under show_co_participants:false denies', () => {
    stubMembership({ 'u:alice@srv|default': 'io', 'u:bob@srv|default': 'io' });
    const v = push('u:alice@srv', 'u:bob@srv', ISOLATED);
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/does not permit/i);
  });

  it('isolated-posture-self-reach-allow: a user reaches their OWN cell under show_co_participants:false (posture gates others, not self)', () => {
    // The self-reach carve-out: caller identity == target identity, so the
    // posture clause is skipped even on an isolated channel. Placement on the
    // target room is still required (alice holds `i` on `focus`).
    stubMembership({ 'u:alice@srv|focus': 'io' });
    expect(push('u:alice@srv', 'u:alice@srv', ISOLATED, 'focus')).toEqual({ allowed: true });
  });
});
