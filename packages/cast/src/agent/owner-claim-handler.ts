/**
 * Owner-claim handler — host-side terminal for the `owner-claim`
 * control packet.
 *
 * Mirrors the `approval_response` path: routed over the bus to the
 * AgentManager's bus handler, validated and resolved entirely host-side, never
 * spawns the runner. The `/claim <code>` secret is intercepted at the gateway
 * before agent resolution, so it reaches this handler but never the LLM.
 *
 * Redemption IS the verification: a single atomic redeem against the agent's
 * `owner_claims` store proves the claimer holds the operator-minted code, and
 * the claimer's transport-authenticated identity (`from`, already resolved to a
 * `u:` identity by the gateway) is bound as the agent's owner. The redeem and
 * the owner write run on the AgentManager's single thread — one writer, no race
 * with a concurrent grant.
 *
 * Scope: OWNERSHIP only. A successful claim makes the redeemer the agent's
 * gatekeeper (owner-directed approvals route to them). Access stays
 * recognition-based — a fake Alice who claims gets her own sandboxed cell;
 * gatekeeping over others is what the code protects.
 */
import { extractIdentity } from '../auth/address.js';
import { setOwner } from '../auth/acl.js';
import type { Bus } from '../gateway/bus.js';
import { conversationPkt } from '../gateway/packets.js';
import { logger } from '../logger.js';

import type { AgentDb } from './agent-db.js';

export interface OwnerClaimDeps {
  agentId: string;
  folder: string;
  bus: Bus;
  agentDb: AgentDb;
}

/**
 * Validate and resolve an owner-claim. Binds the claimer as owner on success,
 * acks the claimer either way. Synchronous: no runner spawn, no awaitable work.
 */
export function handleOwnerClaim(
  deps: OwnerClaimDeps,
  from: string,
  claim: { code: string; channel?: string },
): void {
  // Ownership is a human-held role. The claimer arrives resolved to a bare
  // identity; only a real user (`u:`) may be bound as owner. An agent, ext, or
  // operator-tier claimer is a misuse (the operator is already god-mode and
  // never needs to claim), rejected as non-redeemable without leaking why — and
  // without consuming the code, so a stray operator `/claim` can't burn it.
  const owner = extractIdentity(from);
  const channel = claim.channel ?? 'default';
  if (!owner.startsWith('u:')) {
    ackClaim(deps, from, channel, false);
    logger.info({ agentId: deps.agentId, from }, 'Owner-claim from non-user identity — rejected');
    return;
  }

  if (!deps.agentDb.ownerClaims.redeem(claim.code, owner)) {
    ackClaim(deps, from, channel, false);
    logger.info({ agentId: deps.agentId, from }, 'Owner-claim redemption failed (invalid/expired/replayed code)');
    return;
  }

  setOwner(deps.folder, owner, channel);
  ackClaim(deps, from, channel, true);
  logger.info({ agentId: deps.agentId, owner, channel }, 'Owner-claim redeemed — owner bound');
}

/** Route the success/failure ack back to the claimer's conversation. */
function ackClaim(deps: OwnerClaimDeps, to: string, channel: string, ok: boolean): void {
  const text = ok
    ? 'You are now the owner of this agent. Approvals and access decisions will be sent to you here.'
    : 'That claim code is invalid or has expired.';
  deps.bus.routeMessage(deps.agentId, to, { pkt: conversationPkt(deps.agentId, to, text), channel });
}
