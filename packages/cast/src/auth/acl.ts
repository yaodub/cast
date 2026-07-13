/**
 * ACL — identity-based access control for agents.
 *
 * Reads `config/acl.json` on every call (hot-reload, no restart needed).
 *
 * Permission model: six bits (ioaqrp) per peer, per channel.
 *   i = inbound conversation (and channel membership),
 *   o = outbound conversation,
 *   a = answer (accept inbound queries/requests),
 *   q = query (send outbound queries, expect answer),
 *   r = request (send fire-and-forget; receiver uses `a`),
 *   p = push containment (this agent may route a carried user into the peer
 *       agent). Reactive-only in practice — written by the owner-approval path
 *       (`grantAclEdge`), never hand-authored; see the push note below.
 *
 * Two axes: access (`i`/`a` — who may reach this agent) and containment
 * (`o`/`q`/`r`/`p` — what this agent may initiate). A working edge needs both ends.
 * Cross-agent push (hand a user off to another agent) is two-sided once reactive:
 * containment is the sender's `p`-edge to the target agent (decided by
 * the SENDER's owner — "may X route users into Y"), access is the carried user's
 * `io` on the target (decided by the TARGET's owner — "may this user converse
 * here"). The former `p→io` fold held only for STATIC push, where the carried
 * user's pre-existing `io` bounded everything and `p` was redundant; reactive push
 * lets the sender bootstrap access the user lacked, so `p`'s routing meaning
 * returns as a distinct containment bit. (`h` stays gone.)
 *
 * Pairing: q/a, r/a. `r` is sender-side only — the receiver uses the existing
 * `a` bit; query vs request intent lives in the payload tag (`<cast:query>` /
 * `<cast:request>`, parsed by `format.ts`), not in a separate receiver bit.
 * The receiver renders the same tag the sender chose so the receiving agent
 * sees the wire-format intent (a `<cast:request>` is fire-and-forget — the
 * receiver does the work without composing `<cast:answer>`).
 *
 * Peer-key globs: `a:*` matches any agent identity; `console:*` matches any console
 * identity. `u:*` is disallowed (users are granted individually). Exact peer match beats
 * glob. Channel-side `*` wildcard behavior unchanged — matches user-defined channels,
 * does not match `__*` infra channels.
 *
 * Agent-identity bit restriction: peer keys starting with `a:` (both the `a:*` glob
 * and exact `a:<guid>@<issuer>` keys) may only carry the `q`, `r`, `a`, `p` bits
 * (`AGENT_PEER_ALLOWED_BITS`). The conversational bits `i`/`o` are reserved for
 * user (`u:*`) and console (`console:*`) identities. Agents communicate with each
 * other through the request/answer pair and push-routing only — regular
 * conversation (`i`/`o`) between agents has no causation chain, so admitting it
 * would open a loop substrate with no structural guard. (`p` is a containment-only
 * edge: it lets X route a carried user into Y; it does NOT make X a conversant of
 * Y.) The rule is enforced at schema parse: a violating acl.json fails to parse and
 * `checkAcl` returns deny.
 *
 * Semantics:
 *   - operator tier always has full access (`isOperatorTier`)
 *   - owner identity always has full access
 *   - acl.json present → look up peer + channel → return bits
 *   - acl.json missing → deny all (secure by default)
 *
 */
import { z } from 'zod';

import { extractIdentity, isAgent, isOperatorTier } from './address.js';
import {
  getConsoleInfraGrants,
  getManagerReceiverGrants,
  MANAGER_CONSOLE_FOLDERS,
  SYSTEM_OWNED_CHANNELS,
} from './console-grants.js';
import fs from 'fs';
import { agentPath } from '../config.js';
import type { Bus } from '../gateway/bus.js';
import { readText } from '../lib/config-reader.js';
import { logger } from '../logger.js';
import { writeAtomic } from '../lib/utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All permission bits. Returned for owner / operator / local — the full-access
 *  short-circuit. Includes `p` (push containment) so an operator- or
 *  owner-initiated cross-agent push clears the sender containment gate the same
 *  way it clears `o`/`q`/`r`: a trusted principal may route anywhere. */
const ALL_BITS = 'ioaqrp';

export interface AclResult {
  /** Permission bits for this identity+channel ("io", "a", "ioaqr", "" = no access). */
  bits: string;
  rejectMessage: string | null;
}

/** Check whether a bits string includes a specific permission. */
export function hasBit(bits: string, bit: string): boolean {
  return bits.includes(bit);
}

/**
 * `q ⊇ r` capability hierarchy: holding `q` (query — an answer returns)
 * implies `r` (request — fire-and-forget), since if you can ask-and-get-an-answer you
 * can certainly ask without one. Holding only `r` does NOT imply `q`. A check-time
 * implication, never stored — store `q`, imply `r`. Use this instead of a bare
 * `hasBit(bits, 'r')` at every outbound query/request gate.
 */
export function canEmit(bits: string, kind: 'query' | 'request'): boolean {
  return kind === 'query' ? hasBit(bits, 'q') : (hasBit(bits, 'q') || hasBit(bits, 'r'));
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Per-peer map: channel name → permission bit string. "*" = wildcard.
 *  Bit values are the six-bit set `ioaqrp` (`p` restored as the reactive
 *  push-containment edge; the former `h` stays gone — strict reject so an
 *  un-migrated file carrying it fails loudly). Run the `0.2→0.3` migration first. */
const PeerChannelSchema = z.record(
  z.string(),
  z.string().regex(/^[ioaqrp]*$/, 'invalid permission bits — allowed: i o a q r p (h was folded into i/o; run the 0.2→0.3 migration)'),
);

/**
 * Peer-key schema. Rejects `u:*` — users are granted individually; there is no
 * bulk-grant primitive for user identities. `a:*` and `console:*` globs are
 * permitted; interpreted at lookup time in `checkAclConfig`.
 */
const PeerKeySchema = z.string().refine(
  (k) => k !== 'u:*',
  'u:* wildcard peer key not permitted; users are granted individually',
);

/** Bits permitted on peer keys whose identity prefix is `a:` (agent). See the
 *  agent-identity bit restriction in the file docstring for rationale. `p` (push
 *  containment) is reactive-only in practice — only `grantAclEdge` writes
 *  it — but it is admitted here so a reactively-granted edge round-trips the schema. */
const AGENT_PEER_ALLOWED_BITS = 'qrap';

export const AclSchema = z
  .object({
    owner: z.string().default('operator'),
    // The grant map: peer → channel → bits. The single canonical key (no aliases);
    // defaults to `{}` for an agent with no grants.
    allowed: z.record(PeerKeySchema, PeerChannelSchema).default({}),
    // Three-state ACL: hard-reject tombstones — same peer→channel→bits
    // shape, opposite polarity. Validated + stored here; DORMANT until the
    // reactive-approval path reads it.
    rejected: z.record(PeerKeySchema, PeerChannelSchema).default({}),
    reject_message: z.string().nullable().default(null),
    // The owner conversation's pinned channel: where owner-directed
    // approvals land. Paired with `owner` (the identity) — together they are the
    // owner conversation. Null = unpinned (owner-directed approvals fall back to
    // the operator inbox). Set by the ownership-pairing redeem, or hand-edited.
    approval_channel: z.string().nullable().default(null),
  })
  .strict()
  .superRefine((acl, ctx) => {
    // Agent identities (a:) are restricted to q/r/a — applies to both polarities.
    const checkAgentBits = (map: Record<string, Record<string, string>>, field: string) => {
      for (const [peerKey, channels] of Object.entries(map)) {
        if (!peerKey.startsWith('a:')) continue;
        for (const [channel, bits] of Object.entries(channels)) {
          const forbidden = [...bits].filter((b) => !AGENT_PEER_ALLOWED_BITS.includes(b));
          if (forbidden.length === 0) continue;
          ctx.addIssue({
            code: 'custom',
            path: [field, peerKey, channel],
            message:
              `Agent identity "${peerKey}" cannot hold bits "${forbidden.join('')}" on channel "${channel}". ` +
              `Agent-to-agent communication is restricted to q/r/a (query/request/answer); ` +
              `i/o are reserved for user (u:*) and console (console:*) identities.`,
          });
        }
      }
    };
    checkAgentBits(acl.allowed, 'allowed');
    checkAgentBits(acl.rejected, 'rejected');
    // ext:* is an injection origin, never an approval controller. An
    // ext owner would route the agent's approvals to a principal that cannot
    // respond. Reject at parse. (ext grant edges are derived from the live
    // subscription in `resolveMergedPeers`, never hand-authored, so an `ext:`
    // owner or peer key in the file is always a mistake.)
    if (acl.owner.startsWith('ext:')) {
      ctx.addIssue({
        code: 'custom',
        path: ['owner'],
        message: 'owner cannot be an "ext:*" address — extensions are injection origins, never approval controllers.',
      });
    }
    // q ⊇ r hierarchy: rejecting `r` while granting `q` on the same edge is a
    // contradiction (q implies r) — caught at parse time.
    for (const [peerKey, channels] of Object.entries(acl.rejected)) {
      for (const [channel, rejBits] of Object.entries(channels)) {
        if (!rejBits.includes('r')) continue;
        if ((acl.allowed[peerKey]?.[channel] ?? '').includes('q')) {
          ctx.addIssue({
            code: 'custom',
            path: ['rejected', peerKey, channel],
            message:
              `Cannot reject "r" while granting "q" on "${peerKey}"/"${channel}" — ` +
              `q ⊇ r (query implies request).`,
          });
        }
      }
    }
  })
  .transform((acl) => ({
    owner: acl.owner,
    allowed: acl.allowed,
    rejected: acl.rejected,
    reject_message: acl.reject_message,
    approval_channel: acl.approval_channel,
  }));

type AclConfig = z.infer<typeof AclSchema>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize an ACL peer key to its canonical registered form via the bus.
 *
 * ACL files are operator-authored *intent* data and may carry aliases
 * (manifest.name) or canonical addresses (`a:<guid>@<issuer>`, `u:<guid>@<issuer>`).
 * This resolver funnels both through a single lookup boundary: tries exact match
 * on the bus, then `resolveByLabel`. Returns the raw key unchanged when the
 * alias is not currently registered — the downstream strict-eq lookup then
 * fails loudly at config read time, which is the intended behavior (alias is a
 * weak link; ACL for an unregistered alias denies, visibly).
 */
function normalizePeerKey(bus: Bus, raw: string): string {
  return bus.resolveAddress(raw) ?? raw;
}

/**
 * Validate the configured owner as an approval controller. The owner must be a
 * routable principal: the `operator` sentinel, an operator-tier handle
 * (`cli:`/`admin:`), or a user identity (`u:`). Anything else — a legacy bare
 * word like the pre-0.3 `"local"`, a typo, an unresolvable alias, or an agent
 * (`a:`) — falls back to `operator`, so owner-directed approvals land in the
 * operator inbox instead of routing to a destination that resolves to nothing
 * (invalid/unresolvable owner → operator sentinel, enforced at resolve
 * time so a bad value degrades gracefully rather than black-holing approvals).
 */
function normalizeOwner(owner: string): string {
  if (owner === 'operator' || isOperatorTier(owner) || owner.startsWith('u:') || isAgent(owner)) return owner;
  return 'operator';
}

function resolveAclPeers(bus: Bus, peers: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [key, chans] of Object.entries(peers)) {
    out[normalizePeerKey(bus, key)] = chans;
  }
  return out;
}

/**
 * Shared peer-resolution substrate. Reads `config/acl.json`, parses it, and
 * merges the operator-authored config peers over the paired-users grants — the
 * single table that BOTH `checkAcl` (authorization) and `membershipBits` (room
 * placement) read from, so the two decisions are structurally unable to drift.
 * Returns null when there is no acl.json or it fails to parse — callers treat
 * that as deny / member-of-nothing (secure by default).
 */
function resolveMergedPeers(
  bus: Bus,
  agentFolder: string,
): { peers: Record<string, Record<string, string>>; rejected: Record<string, Record<string, string>>; owner: string; approvalChannel: string | null; rejectMessage: string | null } | null {
  const raw = readText(agentPath(agentFolder, 'config', 'acl.json'));
  if (!raw) return null;
  try {
    const acl = AclSchema.parse(JSON.parse(raw));
    // Single ACL store: acl.json holds ALL live grants — operator-authored
    // and runtime owner-approved alike. The acl-edge approval writes the granted
    // edge straight into acl.json.allowed (grantAclEdge); there is no second store.
    const peers = resolveAclPeers(bus, acl.allowed);
    // Close the alias loophole: the parse-time agent-bit restriction
    // (AclSchema.superRefine) runs on RAW keys, so a config alias that resolves
    // to an agent (e.g. "billing" → a:<guid>) escapes it. Re-apply the
    // restriction post-normalization — any a: identity carrying a non-qra bit
    // fails the file closed (return null → deny-all / member-of-nothing),
    // identical to how a canonical-keyed violation rejects the file at parse.
    for (const [key, channels] of Object.entries(peers)) {
      if (!isAgent(key)) continue;
      for (const bits of Object.values(channels)) {
        if ([...bits].some((b) => !AGENT_PEER_ALLOWED_BITS.includes(b))) {
          logger.warn({ agentFolder, key }, 'Agent peer carries forbidden bits (alias loophole) — denying access');
          return null;
        }
      }
    }
    return {
      peers,
      // The reject tombstone map: acl.json's `rejected` (operator-authored plus
      // runtime reject-always tombstones from tombstoneAclEdge). Read by
      // `aclVerdict` to distinguish 'rejected' from 'askable'.
      rejected: resolveAclPeers(bus, acl.rejected),
      owner: normalizeOwner(normalizePeerKey(bus, acl.owner)),
      // The pinned channel is a channel name, not a peer key — passed through as-is.
      approvalChannel: acl.approval_channel,
      rejectMessage: acl.reject_message,
    };
  } catch (err) {
    // Parse error → deny (fail closed)
    logger.warn({ agentFolder, err }, 'Failed to parse acl.json — denying access');
    return null;
  }
}

// ---------------------------------------------------------------------------
// acl-edge writers — the single-store grant/tombstone path
//
// The owner-approved acl-edge approval persists its outcome straight into
// config/acl.json: allow-always adds the bit to `allowed`, reject-always adds it
// to `rejected` (mutually exclusive per edge). One store, hand-editable, the same
// file `resolveMergedPeers` reads. Reads fresh from disk (not the watcher cache)
// so a read-modify-write never loses a concurrent edit's prior state.
// ---------------------------------------------------------------------------

function setAclBit(map: Record<string, Record<string, string>>, peer: string, channel: string, bit: string): void {
  const channels = map[peer] ?? (map[peer] = {});
  let bits = channels[channel] ?? '';
  for (const b of bit) if (!bits.includes(b)) bits += b; // `bit` may be one or more bits (e.g. 'io')
  channels[channel] = bits;
}

function clearAclBit(map: Record<string, Record<string, string>>, peer: string, channel: string, bit: string): void {
  const channels = map[peer];
  const bits = channels?.[channel];
  if (!channels || !bits) return;
  const next = [...bits].filter((b) => !bit.includes(b)).join('');
  if (next) {
    channels[channel] = next;
  } else {
    delete channels[channel];
    if (Object.keys(channels).length === 0) delete map[peer];
  }
}

/** Read-modify-write config/acl.json. A missing or unparseable file starts from defaults. */
function mutateAcl(agentFolder: string, fn: (acl: AclConfig) => void): void {
  const aclPath = agentPath(agentFolder, 'config', 'acl.json');
  let acl: AclConfig;
  try {
    acl = AclSchema.parse(JSON.parse(fs.readFileSync(aclPath, 'utf-8')));
  } catch {
    acl = AclSchema.parse({});
  }
  fn(acl);
  fs.mkdirSync(agentPath(agentFolder, 'config'), { recursive: true });
  writeAtomic(aclPath, JSON.stringify(acl, null, 2) + '\n');
}

/** Persist an owner-approved edge into acl.json: `peer` gains `bit` (one or more
 *  bits, e.g. 'a' or 'io') on `channel`. Clears any tombstone for those bits. */
export function grantAclEdge(agentFolder: string, peer: string, channel: string, bit: string): void {
  mutateAcl(agentFolder, (acl) => {
    setAclBit(acl.allowed, peer, channel, bit);
    clearAclBit(acl.rejected, peer, channel, bit);
  });
}

/** Persist an owner reject-always into acl.json: `peer` is tombstoned for `bit` on `channel`. Clears any grant. */
export function tombstoneAclEdge(agentFolder: string, peer: string, channel: string, bit: string): void {
  mutateAcl(agentFolder, (acl) => {
    setAclBit(acl.rejected, peer, channel, bit);
    clearAclBit(acl.allowed, peer, channel, bit);
  });
}

/**
 * Set the agent's owner identity and the channel its owner-directed approvals
 * land in (the owner conversation), in one atomic write. The owner-claim
 * redemption path's single mutation: binds the verified redeemer as owner and
 * pins where approvals route. Pass `owner: 'operator'` + `channel: null` to
 * revert to the default sentinel (and unpin the conversation). The only writer
 * of `owner`/`approval_channel` outside hand-editing acl.json.
 */
export function setOwner(agentFolder: string, owner: string, approvalChannel: string | null): void {
  mutateAcl(agentFolder, (acl) => {
    acl.owner = owner;
    acl.approval_channel = approvalChannel;
  });
}

/**
 * Plain-remove an `allowed` edge: delete `(peer, channel)` from the grant map
 * entirely, pruning the peer if it has no other channels. Leaves `rejected`
 * untouched — the peer returns to *askable* (it may request again), not banned.
 * The operator's revoke affordance in the Access tab. Idempotent: a missing edge
 * is a no-op.
 */
export function revokeAclEdge(agentFolder: string, peer: string, channel: string): void {
  mutateAcl(agentFolder, (acl) => {
    const channels = acl.allowed[peer];
    if (!channels || !(channel in channels)) return;
    delete channels[channel];
    if (Object.keys(channels).length === 0) delete acl.allowed[peer];
  });
}

/**
 * The agent's resolved owner identity from its `acl.json` `owner` field, or null
 * if the acl can't be read. Returns the literal `'operator'` sentinel for the
 * default owner. Used by owner-approves routing to pick the approval
 * controller.
 */
export function getOwner(bus: Bus, agentFolder: string): string | null {
  return resolveMergedPeers(bus, agentFolder)?.owner ?? null;
}

/**
 * The agent's **owner conversation**: the owner identity paired with the
 * channel its approvals land in. Returns null when there is no pinned
 * conversation to route to — the `'operator'` sentinel owner (no conversation;
 * the inbox handles it) or a real owner with no `approval_channel` set. Used by
 * owner-directed approval routing to land the request in the owner's own
 * conversation rather than a default-resolved one.
 */
export function getOwnerConversation(
  bus: Bus,
  agentFolder: string,
): { id: string; channel: string } | null {
  const merged = resolveMergedPeers(bus, agentFolder);
  if (!merged || merged.owner === 'operator' || !merged.approvalChannel) return null;
  return { id: merged.owner, channel: merged.approvalChannel };
}

/** Look up permission bits for a resolved address on a given channel. */
export function checkAcl(bus: Bus, agentFolder: string, resolvedAddress: string, channel?: string): AclResult {
  const identity = extractIdentity(resolvedAddress);

  // Operator tier always has full access
  if (isOperatorTier(resolvedAddress)) {
    return { bits: ALL_BITS, rejectMessage: null };
  }

  // System-owned infrastructure channels (__design, __configure) are 100%
  // code-declared. Disk `config/acl.json` is neither consulted nor
  // authoritative here — the code table is the sole source of truth.
  // Disjoint-union invariant: acl.json never mentions these channels;
  // CONSOLE_INFRA_GRANTS never mentions non-console peers or non-infra
  // channels. Any future change that reads disk for these channels breaks
  // the invariant. Accessor reads `consoleIsolation` at call time so a
  // mode flip takes effect on the next check.
  if (channel !== undefined && SYSTEM_OWNED_CHANNELS.has(channel)) {
    const bits = getConsoleInfraGrants()[identity]?.[channel] ?? '';
    return { bits, rejectMessage: null };
  }

  // Manager-console folders (`.design-manager`, `.config-manager`,
  // `.security-manager`) are code-declared receivers too. Same disjoint-
  // union invariant — disk `acl.json` is not consulted; the receiver grant
  // comes from `getManagerReceiverGrants()`. Distinct from the channel
  // short-circuit above because the manager consoles route their own
  // `default` channel and `default` is generic (every agent has one), so
  // the trigger has to be the receiver folder, not the channel name.
  if (MANAGER_CONSOLE_FOLDERS.has(agentFolder)) {
    const bits = getManagerReceiverGrants()[agentFolder]?.[identity]?.[channel ?? 'default'] ?? '';
    return { bits, rejectMessage: null };
  }

  const merged = resolveMergedPeers(bus, agentFolder);
  if (!merged) {
    // No ACL file or parse error → deny all external access (secure by default)
    return { bits: '', rejectMessage: null };
  }
  return checkAclConfig(
    { owner: merged.owner, peers: merged.peers, reject_message: merged.rejectMessage },
    identity,
    channel ?? 'default',
  );
}

/**
 * Sender-side ACL lookup against a code-declared descriptor ACL (e.g.
 * `DESIGN_MANAGER_DESCRIPTOR.acl`). Used by server-scope consoles to check
 * their own outbound grant before routing — mirrors `checkAclConfig`'s
 * exact-match-then-prefix-glob peer lookup.
 *
 * Returns the raw bit string (or "" if no grant). Callers use `hasBit` to
 * check for specific verbs.
 */
export function lookupDescriptorAcl(
  acl: { peers: Record<string, Record<string, string>> },
  targetAddress: string,
  channel: string,
): string {
  const target = extractIdentity(targetAddress);
  let peerChannels = acl.peers[target];
  if (!peerChannels) {
    const colonIdx = target.indexOf(':');
    if (colonIdx > 0) {
      peerChannels = acl.peers[`${target.slice(0, colonIdx)}:*`];
    }
  }
  if (!peerChannels) return '';
  const isInfra = channel.startsWith('__');
  return (isInfra ? peerChannels[channel] : (peerChannels[channel] ?? peerChannels['*'])) ?? '';
}

/**
 * Three-state ACL verdict for a single (address, channel, bit), used by the
 * reactive-approval path. Distinct from `checkAcl` (binary, unchanged — so
 * its ~14 callers are untouched):
 *   - 'granted'  — `checkAcl` already grants the bit (operator / system / allowed).
 *   - 'rejected' — an explicit tombstone in the `rejected` map covers it (hard no),
 *                  or there is no acl.json / a parse error (secure default).
 *   - 'askable'  — neither: an ungranted *intra-pod* edge a controller may grant
 *                  live. Cross-agent is intra-pod, so this gate never yields the
 *                  perimeter 'deny' (egress is a separate surface).
 */
export function aclVerdict(
  bus: Bus,
  agentFolder: string,
  resolvedAddress: string,
  channel: string | undefined,
  bit: string,
): 'granted' | 'askable' | 'rejected' {
  if (checkAcl(bus, agentFolder, resolvedAddress, channel).bits.includes(bit)) return 'granted';
  const merged = resolveMergedPeers(bus, agentFolder);
  if (!merged) return 'rejected';
  const rejectedBits = lookupDescriptorAcl({ peers: merged.rejected }, resolvedAddress, channel ?? 'default');
  return rejectedBits.includes(bit) ? 'rejected' : 'askable';
}

/**
 * Three-state verdict on an identity's CONCRETE placement on a channel — the
 * membership-aware sibling of `aclVerdict`. `granted` requires a concrete grant
 * (`membershipBits`: no operator/owner god-mode, no `a:*`/`console:*` glob, no `*`
 * channel-wildcard widening), so a god-mode principal with no real placement
 * resolves to `askable`, not `granted`. Rejected tombstones still win, read from
 * the same merged table.
 *
 * Used by the push receiver ACCESS gate: a conduit agent must not ferry
 * an unplaced god-mode principal (operator, configured `u:` owner) past the
 * destination owner. The concrete read is the same floor the binary gate-3
 * (`membershipBits`) enforced; this adds the reactive `askable` tier above it.
 */
export function membershipVerdict(
  bus: Bus,
  agentFolder: string,
  resolvedAddress: string,
  channel: string,
  bit: string,
): 'granted' | 'askable' | 'rejected' {
  if (membershipBits(bus, agentFolder, resolvedAddress, channel).includes(bit)) return 'granted';
  const merged = resolveMergedPeers(bus, agentFolder);
  if (!merged) return 'rejected';
  const rejectedBits = lookupDescriptorAcl({ peers: merged.rejected }, resolvedAddress, channel);
  return rejectedBits.includes(bit) ? 'rejected' : 'askable';
}

/** Get all channel permissions for a peer from an agent's ACL. Returns undefined if peer not found. */
export function getPeerChannels(bus: Bus, agentFolder: string, peerId: string): { name: string; bits: string }[] | undefined {
  const merged = resolveMergedPeers(bus, agentFolder);
  if (!merged) return undefined;
  const identity = extractIdentity(peerId);
  if (isOperatorTier(peerId) || merged.owner === identity) {
    return [{ name: '*', bits: ALL_BITS }];
  }
  const peerChannels = merged.peers[identity];
  if (!peerChannels) return undefined;
  return Object.entries(peerChannels).map(([name, bits]) => ({ name, bits }));
}

/**
 * Concrete room placement for an identity on ONE named channel. Reads the SAME
 * merged-peers table `checkAcl` authorizes from (via `resolveMergedPeers`), so
 * the two cannot drift — but deliberately omits every widening rule
 * `checkAcl` / `checkAclConfig` apply:
 *   - NO `local` / owner `ALL_BITS` short-circuit (`checkAcl` local branch,
 *     `checkAclConfig` owner branch, `getPeerChannels` owner branch) — the
 *     operator and the owner are placed room-by-room like anyone else, so
 *     standing alone they are members of nothing;
 *   - NO prefix-glob (`a:*`, `console:*`) expansion — a glob is a capability
 *     grant, not a concrete placement;
 *   - NO `*` channel-wildcard fallback (`checkAclConfig`'s non-infra branch) —
 *     placement must be on THIS room, not "any room".
 * Net: the operator and any unplaced identity resolve to '' → member of nothing.
 * Used only by the cross-conversation push chokepoint, never for authorization.
 */
export function membershipBits(bus: Bus, agentFolder: string, resolvedAddress: string, channel: string): string {
  const merged = resolveMergedPeers(bus, agentFolder);
  if (!merged) return '';
  return merged.peers[extractIdentity(resolvedAddress)]?.[channel] ?? '';
}

/**
 * Concrete room placements for ONE identity — `membershipBits` inverted from
 * "is X placed in room Y?" to "which rooms is X placed in?". Reads the SAME
 * merged-peers table (`resolveMergedPeers`) and applies the SAME exclusions:
 * no `*` channel-wildcard rows (a capability fallback, not a placement), no
 * `__*` infra channels (code-declared, never disk membership), no operator /
 * owner god-mode (standing alone they are placed nowhere), and the
 * exact-identity lookup never falls back to a prefix glob. Invariant: every
 * row returned here is confirmed by `membershipBits(..., row.channel)`.
 */
export function listPlacedChannels(
  bus: Bus,
  agentFolder: string,
  resolvedAddress: string,
): { channel: string; bits: string }[] {
  const merged = resolveMergedPeers(bus, agentFolder);
  if (!merged) return [];
  const placements = merged.peers[extractIdentity(resolvedAddress)];
  if (!placements) return [];
  return Object.entries(placements)
    .filter(([channel, bits]) => bits !== '' && channel !== '*' && !channel.startsWith('__'))
    .map(([channel, bits]) => ({ channel, bits }));
}

/**
 * Concrete members of ONE channel — the other inversion of `membershipBits`
 * ("who is placed in room Y?"). Same table, same exclusions: prefix-glob peer
 * keys (`a:*`, `console:*`) are capability grants, not placements, and are
 * skipped; only rows naming EXACTLY this channel count (no `*` fallback);
 * `__*` infra channels enumerate as empty. The operator tier and the
 * configured owner appear only when concretely placed, like anyone else.
 * Rows include peer agents (`a:` identities holding `a`) — callers split
 * user/peer downstream. Used by the discovery read surface, never for
 * authorization.
 */
export function listChannelMembers(
  bus: Bus,
  agentFolder: string,
  channel: string,
): { identity: string; bits: string }[] {
  if (channel === '*' || channel.startsWith('__')) return [];
  const merged = resolveMergedPeers(bus, agentFolder);
  if (!merged) return [];
  const members: { identity: string; bits: string }[] = [];
  for (const [identity, channels] of Object.entries(merged.peers)) {
    if (identity.endsWith(':*')) continue;
    const bits = channels[channel];
    if (bits) members.push({ identity, bits });
  }
  return members;
}

/**
 * Whether an identity holds operator/owner full access — the two `ALL_BITS`
 * short-circuits in `checkAcl` (the operator tier via `isOperatorTier`, the
 * configured `owner`). This is the authorization-tier counterpart to
 * `membershipBits`: these identities are authorized everywhere yet are members
 * of no specific room (`membershipBits` returns '' for them). The
 * cross-conversation push chokepoint uses it so the operator/owner can push
 * (god-mode) even though they are members of nothing — without it, the
 * room-membership path would wrongly deny them.
 */
export function isOperatorOrOwner(bus: Bus, agentFolder: string, resolvedAddress: string): boolean {
  const identity = extractIdentity(resolvedAddress);
  if (isOperatorTier(resolvedAddress)) return true;
  const merged = resolveMergedPeers(bus, agentFolder);
  return merged != null && merged.owner === identity;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Receiver-side verb selection. Maps the inbound operation to the ACL bit
 * the receiver must have for delivery to be authorized. Pairs with sender-
 * side verbs as documented in the bit reference at the top of this file:
 *   message    → `i`  (inbound conversation; pairs with sender `o`)
 *   request    → `a`  (answer; pairs with sender `q`/`r`)
 *
 * A push is gated as a `message` (the fold): inserting a turn into a user's
 * conversation is an `i`-bit delivery, same as any inbound message — the
 * `p`/`h` pair is gone. The `type: 'push'` packet survives as the delivery
 * vehicle; only its gate bit moved (`h` → `i`).
 *
 * Use this everywhere a receiver needs to gate inbound traffic — keeps the
 * verb table in one place so adding an operation type means updating one
 * site, not grepping for `hasBit(_, 'i')` etc.
 */
export type ReceiverOperation = 'message' | 'request';

export function pickVerb(op: ReceiverOperation): 'i' | 'a' {
  switch (op) {
    case 'request': return 'a';
    case 'message': return 'i';
  }
}

/**
 * Receiver-side gate decision. Composes `pickVerb` + `hasBit` so every
 * receiver site (bus handler message + request paths, local-hop console
 * branch, deliverToChannel sender pre-check) shares the same shape:
 * supply the bits and the operation type, get back `{ allowed, verb }`.
 *
 * `verb` is returned for logging/observability — receivers usually log
 * which bit they checked when denying.
 */
export function gateInbound(bits: string, op: ReceiverOperation): { allowed: boolean; verb: 'i' | 'a' } {
  const verb = pickVerb(op);
  return { allowed: hasBit(bits, verb), verb };
}

function checkAclConfig(
  acl: { owner: string; peers: Record<string, Record<string, string>>; reject_message: string | null },
  identity: string,
  channel: string,
): AclResult {
  // Owner gets full access (owner, peer keys, and identity all normalized by caller)
  if (acl.owner === identity) {
    return { bits: ALL_BITS, rejectMessage: null };
  }

  // Exact peer match first; then prefix glob (e.g. 'a:*', 'console:*').
  // 'u:*' is rejected at schema parse — users are granted individually.
  let peerChannels = acl.peers[identity];
  if (!peerChannels) {
    const colonIdx = identity.indexOf(':');
    if (colonIdx > 0) {
      peerChannels = acl.peers[`${identity.slice(0, colonIdx)}:*`];
    }
  }
  if (!peerChannels) {
    logger.debug({ identity }, 'Identity not in ACL');
    return { bits: '', rejectMessage: acl.reject_message };
  }

  // Infrastructure channels (__design, __configure) require an explicit
  // grant — the '*' wildcard only matches user-defined channels. This prevents
  // accidental over-grant of authoring surfaces.
  const isInfra = channel.startsWith('__');
  const bits = isInfra ? peerChannels[channel] : (peerChannels[channel] ?? peerChannels['*']);
  if (!bits) {
    logger.debug({ identity, channel }, 'Identity not allowed on channel');
    return { bits: '', rejectMessage: acl.reject_message };
  }

  return { bits, rejectMessage: null };
}
