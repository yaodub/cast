/**
 * ACL — identity-based access control for agents.
 *
 * Reads `config/acl.json` on every call (hot-reload, no restart needed).
 *
 * Permission model: seven bits (ioaqrph) per peer, per channel.
 *   i = inbound conversation, o = outbound conversation,
 *   a = answer (accept inbound queries/requests),
 *   q = query (send outbound queries, expect answer),
 *   r = request (send fire-and-forget; receiver uses `a`),
 *   p = push (cross-agent: sender's user becomes a participant on target's channel),
 *   h = host push (accept incoming push; start/continue conversation with the
 *       sender's named user).
 *
 * Pairing: q/a, r/a, p/h. `r` is sender-side only — the receiver uses the existing
 * `a` bit; query vs request intent lives in the payload tag (`<cast:query>` /
 * `<cast:request>`, parsed by `format.ts`), not in a separate receiver bit.
 * The receiver renders the same tag the sender chose so the receiving agent
 * sees the wire-format intent (a `<cast:request>` is fire-and-forget — the
 * receiver does the work without composing `<cast:answer>`).
 *
 * Peer-key globs: `a:*` matches any agent identity; `console:*` matches any console
 * identity. `u:*` is disallowed (users must pair explicitly). Exact peer match beats
 * glob. Channel-side `*` wildcard behavior unchanged — matches user-defined channels,
 * does not match `__*` infra channels.
 *
 * Agent-identity bit restriction: peer keys starting with `a:` (both the `a:*` glob
 * and exact `a:<guid>@<issuer>` keys) may only carry the `q`, `r`, `a` bits. The
 * conversational bits `i`/`o`/`p`/`h` are reserved for user (`u:*`) and console
 * (`console:*`) identities. Agents communicate with each other through the
 * request/answer pair only — push (`p`/`h`) has no cycle-detection metadata and
 * regular conversation (`i`/`o`) has no causation chain, so admitting either between
 * agents would open a loop substrate with no structural guard. The rule is enforced
 * at schema parse: a violating acl.json fails to parse and `checkAcl` returns deny.
 *
 * Semantics:
 *   - `local` identity always has full access (operator)
 *   - owner identity always has full access
 *   - acl.json present → look up peer + channel → return bits
 *   - acl.json missing → deny all (secure by default)
 *
 */
import { z } from 'zod';

import { extractIdentity } from './address.js';
import {
  getConsoleInfraGrants,
  getManagerReceiverGrants,
  MANAGER_CONSOLE_FOLDERS,
  SYSTEM_OWNED_CHANNELS,
} from './console-grants.js';
import { agentPath } from '../config.js';
import type { Bus } from '../gateway/bus.js';
import { readText } from '../lib/config-reader.js';
import { logger } from '../logger.js';
import { readPairedUsers } from './pairing.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All permission bits. Returned for owner / local. */
const ALL_BITS = 'ioaqrph';

export interface AclResult {
  /** Permission bits for this identity+channel ("io", "a", "ioaqrph", "" = no access). */
  bits: string;
  rejectMessage: string | null;
}

/** Check whether a bits string includes a specific permission. */
export function hasBit(bits: string, bit: string): boolean {
  return bits.includes(bit);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Per-peer map: channel name → permission bit string. "*" = wildcard. */
const PeerChannelSchema = z.record(z.string(), z.string());

/**
 * Peer-key schema. Rejects `u:*` — users must pair explicitly; there is no
 * bulk-grant primitive for user identities. `a:*` and `console:*` globs are
 * permitted; interpreted at lookup time in `checkAclConfig`.
 */
const PeerKeySchema = z.string().refine(
  (k) => k !== 'u:*',
  'u:* wildcard peer key not permitted; users must pair explicitly',
);

/** Bits permitted on peer keys whose identity prefix is `a:` (agent). See the
 *  agent-identity bit restriction in the file docstring for rationale. */
const AGENT_PEER_ALLOWED_BITS = 'qra';

export const AclSchema = z
  .object({
    owner: z.string().default('local'),
    peers: z.record(PeerKeySchema, PeerChannelSchema).default({}),
    reject_message: z.string().nullable().default(null),
  })
  .strict()
  .superRefine((acl, ctx) => {
    for (const [peerKey, channels] of Object.entries(acl.peers)) {
      if (!peerKey.startsWith('a:')) continue;
      for (const [channel, bits] of Object.entries(channels)) {
        const forbidden = [...bits].filter((b) => !AGENT_PEER_ALLOWED_BITS.includes(b));
        if (forbidden.length === 0) continue;
        ctx.addIssue({
          code: 'custom',
          path: ['peers', peerKey, channel],
          message:
            `Agent identity "${peerKey}" cannot hold bits "${forbidden.join('')}" on channel "${channel}". ` +
            `Agent-to-agent communication is restricted to q/r/a (query/request/answer); ` +
            `i/o/p/h are reserved for user (u:*) and console (console:*) identities.`,
        });
      }
    }
  });

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

function resolveAclPeers(bus: Bus, peers: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [key, chans] of Object.entries(peers)) {
    out[normalizePeerKey(bus, key)] = chans;
  }
  return out;
}

/** Look up permission bits for a resolved address on a given channel. */
export function checkAcl(bus: Bus, agentFolder: string, resolvedAddress: string, channel?: string): AclResult {
  const identity = extractIdentity(resolvedAddress);

  // Local operator always has full access
  if (identity === 'local') {
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

  const aclPath = agentPath(agentFolder, 'config', 'acl.json');
  const raw = readText(aclPath);
  if (!raw) {
    // No ACL file → deny all external access (secure by default)
    return { bits: '', rejectMessage: null };
  }
  try {
    const acl = AclSchema.parse(JSON.parse(raw));
    const pairedUsers = readPairedUsers(agentFolder);
    const resolvedConfigPeers = resolveAclPeers(bus, acl.peers);
    const mergedPeers = { ...pairedUsers, ...resolvedConfigPeers };
    const resolvedOwner = normalizePeerKey(bus, acl.owner);
    return checkAclConfig({ ...acl, owner: resolvedOwner, peers: mergedPeers }, identity, channel ?? 'default');
  } catch (err) {
    // Parse error → deny (fail closed)
    logger.warn({ agentFolder, err }, 'Failed to parse acl.json — denying access');
    return { bits: '', rejectMessage: null };
  }
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

/** Get all channel permissions for a peer from an agent's ACL. Returns undefined if peer not found. */
export function getPeerChannels(bus: Bus, agentFolder: string, peerId: string): { name: string; bits: string }[] | undefined {
  const raw = readText(agentPath(agentFolder, 'config', 'acl.json'));
  if (!raw) return undefined;
  try {
    const acl = AclSchema.parse(JSON.parse(raw));
    const identity = extractIdentity(peerId);
    const resolvedOwner = normalizePeerKey(bus, acl.owner);
    if (identity === 'local' || resolvedOwner === identity) {
      return [{ name: '*', bits: ALL_BITS }];
    }
    const pairedUsers = readPairedUsers(agentFolder);
    const peers = { ...pairedUsers, ...resolveAclPeers(bus, acl.peers) };

    const peerChannels = peers[identity];
    if (!peerChannels) return undefined;
    return Object.entries(peerChannels).map(([name, bits]) => ({ name, bits }));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Receiver-side verb selection. Maps the inbound operation to the ACL bit
 * the receiver must have for delivery to be authorized. Pairs with sender-
 * side verbs as documented in the bit reference at the top of this file:
 *   message    → `i`  (inbound conversation; pairs with sender `o`)
 *   push       → `h`  (host push; pairs with sender `p`)
 *   request    → `a`  (answer; pairs with sender `q`/`r`)
 *
 * Use this everywhere a receiver needs to gate inbound traffic — keeps the
 * verb table in one place so adding an operation type means updating one
 * site, not grepping for `hasBit(_, 'i')` etc.
 */
export type ReceiverOperation = 'message' | 'push' | 'request';

export function pickVerb(op: ReceiverOperation): 'i' | 'h' | 'a' {
  switch (op) {
    case 'push':    return 'h';
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
export function gateInbound(bits: string, op: ReceiverOperation): { allowed: boolean; verb: 'i' | 'h' | 'a' } {
  const verb = pickVerb(op);
  return { allowed: hasBit(bits, verb), verb };
}

function checkAclConfig(acl: AclConfig, identity: string, channel: string): AclResult {
  // Owner gets full access (owner, peer keys, and identity all normalized by caller)
  if (acl.owner === identity) {
    return { bits: ALL_BITS, rejectMessage: null };
  }

  // Exact peer match first; then prefix glob (e.g. 'a:*', 'console:*').
  // 'u:*' is rejected at schema parse — users must pair explicitly.
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
