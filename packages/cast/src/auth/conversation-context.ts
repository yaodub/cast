/**
 * Cross-conversation push chokepoint.
 *
 * ONE resolver collapses the scattered `isUser`-based decisions that used to
 * govern cross-conversation reach (the "system-context masquerade": a peer
 * agent's `a:` address slipping through `!isUser` and inheriting the agent's
 * own org-wide surface). The caller's standing in a room is computed once, here,
 * into a discriminated `CallerContext`; the whole push gate is one verdict
 * function. Call sites ASK this module (`.allowed` / `.class`) — they never
 * re-derive standing from raw participant strings.
 *
 * Membership is concrete per-channel placement, read via `membershipBits`
 * (no `*` wildcard, no operator/owner short-circuit, no prefix-glob). Push
 * targets are always *users* placed in the room — agents are in a room as
 * request-counterparties, never as push targets, so the agent→agent loop fence
 * is structural here, not a rider.
 */
import { isOperatorOrOwner, membershipBits } from './acl.js';
import { extractIdentity, isMember, isSystemContext, isUser } from './address.js';
import type { AgentChannel } from '../conversations/types.js';
import type { Bus } from '../gateway/bus.js';

/** The caller's standing relative to ONE room. Exactly one variant holds. */
export type CallerContext =
  | { class: 'owner' }                         // owns/controls the agent's conversations — reaches any of them
  | { class: 'user-member'; bits: string }    // a user placed in THIS room (i)
  | { class: 'agent-member'; bits: string }   // a peer agent placed in THIS room (a)
  | { class: 'non-member' };                  // unplaced (stranger, peer with no grant on this channel)

/**
 * Resolve the caller's standing in ONE room (`channel`), computed once from the
 * same merged-peers substrate `checkAcl` reads — diverging only in that room
 * membership reads concrete placement (`membershipBits`).
 *
 * The `owner` tier is the unconditional one: it reaches any conversation the
 * agent owns. It is broader than `isSystemContext` (the agent operating as
 * itself) on purpose — it also covers the machine-trusted operator surface
 * (`isOperatorTier`) and the configured `owner`. Those hold full authorization
 * everywhere yet are members of no specific room (their `membershipBits` is
 * empty by design, F2), so the room-membership path below would wrongly deny
 * them as callers. They are god-mode the same way the agent-self is, so they
 * share the unconditional tier. (The discovery read surface gates on the
 * narrower `isReadTier` — system context ∥ operator tier, WITHOUT the
 * configured owner: enumeration is a silent oracle, push is noisy, so a
 * configured `u:` owner keeps god-mode reach but member-scoped visibility.)
 */
export function resolveCallerContext(
  caller: string | null | undefined,
  channel: string,
  ownAgentId: string,
  bus: Bus,
  agentFolder: string,
): CallerContext {
  // Owner tier (unconditional): the agent operating as itself (null/own-address),
  // the operator tier (cli:/admin: surfaces), or the configured owner. The
  // leading `== null` narrows `caller` to a string for the later operands and
  // the member branch.
  if (caller == null || isSystemContext(caller, ownAgentId) || isOperatorOrOwner(bus, agentFolder, caller)) {
    return { class: 'owner' };
  }

  const bits = membershipBits(bus, agentFolder, caller, channel);
  if (!isMember(bits)) return { class: 'non-member' };
  return isUser(caller)
    ? { class: 'user-member', bits }
    : { class: 'agent-member', bits };
}

/** Push verdict — tells, doesn't ask. Callers read `.allowed`; on deny, `.reason`
 *  is the LLM-facing message. No raw standing escapes. */
export type PushVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * The uniform channel denial — shared by the push verdict and the discovery
 * read surface (the list deps in `agent-mcp-deps.ts`) so the two can never
 * diverge: an unauthorized channel and a nonexistent channel return
 * byte-identical wording, keeping channel existence out of the oracle.
 */
export function channelAuthDenial(channel: string): string {
  return `You are not authorized on channel "${channel}".`;
}

/**
 * The whole cross-conversation push gate, in one place:
 *   - an owner-tier caller (the agent reaching its own rooms / a self-fire / the
 *     operator / the owner) → allow unconditionally (it owns the conversation,
 *     including with the operator, who is a member of nothing);
 *   - a placed member reaching a USER who is also placed in the room — when that
 *     user is someone ELSE, only if the room posture permits
 *     (`show_co_participants !== false`); a self-reach into your own cell in
 *     another room is always allowed (no co-participant is exposed) → allow;
 *   - everything else → deny with a typed reason.
 */
export function canPushCrossConversation(args: {
  caller: string | null | undefined;
  target: string;
  channel: string;
  ownAgentId: string;
  bus: Bus;
  agentFolder: string;
  channelConfig: AgentChannel | undefined;
}): PushVerdict {
  const { caller, target, channel, ownAgentId, bus, agentFolder, channelConfig } = args;

  const ctx = resolveCallerContext(caller, channel, ownAgentId, bus, agentFolder);

  if (ctx.class === 'owner') return { allowed: true };
  if (ctx.class === 'non-member') {
    return { allowed: false, reason: channelAuthDenial(channel) };
  }

  // Caller is a placed member (user-member | agent-member). Vet the target.
  if (!isUser(target)) {
    return { allowed: false, reason: `Cannot push to "${target}" — push targets must be users.` };
  }
  if (!membershipBits(bus, agentFolder, target, channel).includes('i')) {
    return { allowed: false, reason: `"${target}" is not a member of channel "${channel}".` };
  }
  // Posture gates reaching ANOTHER participant, never yourself. A caller may
  // always carry their own conversation into another room they are placed in:
  // a self-reach exposes no co-participant, so the isolation posture does not
  // apply (its own reason — "reaching other participants" — says as much).
  // `caller` is a non-null placed member here; the null-guard holds the
  // conservative default if that invariant ever changes.
  const reachingOther = caller == null || extractIdentity(caller) !== extractIdentity(target);
  if (reachingOther && channelConfig?.show_co_participants === false) {
    return { allowed: false, reason: `Channel "${channel}" does not permit reaching other participants.` };
  }
  return { allowed: true };
}
