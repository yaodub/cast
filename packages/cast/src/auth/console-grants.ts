/**
 * Code-declared ACL grants for the infra channels (`__design`, `__configure`)
 * that every agent ships with, plus the manager-console receivers
 * (`.design-manager`, `.config-manager`, `.security-manager`). Conceptually
 * a hardcoded extension — these grants never live on disk and `checkAcl`
 * short-circuits to the code tables for the channels and folders covered
 * here. The disjoint-union invariant (code table covers system-owned
 * channels and manager folders; disk covers everything else) keeps the
 * merge structural and free of conflicts.
 *
 * Two table sets — STRICT and NORMAL — gate cross-console push paths.
 * Server config `consoleIsolation` selects which set is live:
 *
 *   strict — historical behavior. DM reaches only `__design`, CM only
 *            `__configure`. No same-agent infra bridge. No inter-manager
 *            push. Mitigates the LLM-driven exfil carrier between
 *            Configure's PII read and Design's network egress.
 *   normal — opens the asymmetric set safe for solo-operator authoring:
 *            DM → any `__configure`, DM → CM, same-agent `__design` →
 *            `__configure`. The reverse direction (Configure → Design,
 *            CM → DM, CM → `__design`) stays blocked in BOTH modes —
 *            this is the exfil carrier; mode never opens it.
 *
 * Reading at decision time (not module load) makes the toggle hot-reload-
 * friendly: long-running console sessions see a flipped mode in the next
 * rejection message and the tool description on the next tools/list fetch.
 *
 * To revoke a console's reach into a single agent, a per-agent manifest
 * flag would be the right shape. Not implemented today. Do NOT add a
 * code-path that consults disk for the channels and folders covered
 * here — the invariant is load-bearing.
 */
import { readServerConfig } from '../config.js';
import type { ConsoleIsolation } from '../config.js';

type OutboundAclMap = Record<string, { peers: Record<string, Record<string, string>> }>;
type InfraGrantMap = Record<string, Record<string, string>>;
/** receiverFolder → senderIdentity → channel → bits. */
type ManagerReceiverGrantMap = Record<string, Record<string, Record<string, string>>>;

// ---------------------------------------------------------------------------
// STRICT — historical isolation
//
// Exported so tests can assert on mode-specific shape without going through
// the runtime accessor (avoids needing to mock `readServerConfig` for every
// shape assertion). Runtime code should NOT import these directly — use
// `getConsoleOutboundAcls()` / `getConsoleInfraGrants()` /
// `getManagerReceiverGrants()` so a flipped isolation takes effect.
// ---------------------------------------------------------------------------

export const STRICT_OUTBOUND_ACLS: OutboundAclMap = {
  // `o` = outbound conversation, the push verb post-fold (bus-level
  // conversation__push_to_channel); `q` = query (`<cast:query>` tag →
  // synchronous request/response round-trip via gateway request packets). SM is
  // deliberately absent — read-only auditor, no outbound query or push.
  'console:design-manager': { peers: { 'a:*': { '__design': 'oq' } } },
  'console:config-manager': { peers: { 'a:*': { '__configure': 'oq' } } },
};

export const STRICT_INFRA_GRANTS: InfraGrantMap = {
  // `i` is the receiver-side conversation verb — a pushed-in turn is an `i`-bit
  // delivery (post-fold: hosting the handed-over user is just inbound
  // conversation). `a` is the receiver-side answer verb — per-agent's
  // Design/Configure accepts inbound `<cast:query>` requests from the manager
  // console and emits `<cast:answer>` back. Pairs with `q` on the sender grant.
  'console:design-manager': { '__design': 'ia' },
  'console:config-manager': { '__configure': 'ia' },
};

export const STRICT_MANAGER_RECEIVER_GRANTS: ManagerReceiverGrantMap = {
  // No inter-manager push in strict mode.
};

// ---------------------------------------------------------------------------
// NORMAL — opens asymmetric DM-direction paths safe for solo-operator
// authoring. Reverse direction (Configure → Design carrier) stays blocked.
// ---------------------------------------------------------------------------

export const NORMAL_OUTBOUND_ACLS: OutboundAclMap = {
  'console:design-manager': {
    peers: {
      // DM gains push+query on `__configure` in addition to `__design`.
      'a:*': { '__design': 'oq', '__configure': 'oq' },
      // DM → CM cross-manager push (CM's `default` channel).
      'console:config-manager': { 'default': 'oq' },
    },
  },
  // CM unchanged — CM never gains reach in either mode. The exfil-carrier
  // direction (CM → __design, CM → DM) stays closed even in normal mode.
  'console:config-manager': { peers: { 'a:*': { '__configure': 'oq' } } },
};

export const NORMAL_INFRA_GRANTS: InfraGrantMap = {
  // DM gains receive-on-`__configure` so the receiver-side gate passes when
  // DM pushes into an agent's `__configure`. Pairs with the outbound `oq`
  // above on the same channel.
  'console:design-manager': { '__design': 'ia', '__configure': 'ia' },
  'console:config-manager': { '__configure': 'ia' },
};

export const NORMAL_MANAGER_RECEIVER_GRANTS: ManagerReceiverGrantMap = {
  // CM accepts inbound push from DM on its `default` channel.
  '.config-manager': {
    'console:design-manager': { 'default': 'i' },
  },
};

// ---------------------------------------------------------------------------
// Accessors — selector reads server config; tables themselves are static.
// ---------------------------------------------------------------------------

function selectIsolation(): ConsoleIsolation {
  return readServerConfig().consoleIsolation;
}

/** Sender-side outbound ACLs for the current isolation mode. */
export function getConsoleOutboundAcls(): OutboundAclMap {
  return selectIsolation() === 'strict' ? STRICT_OUTBOUND_ACLS : NORMAL_OUTBOUND_ACLS;
}

/** Receiver-side grants for system-owned infra channels (`__design`, `__configure`). */
export function getConsoleInfraGrants(): InfraGrantMap {
  return selectIsolation() === 'strict' ? STRICT_INFRA_GRANTS : NORMAL_INFRA_GRANTS;
}

/** Receiver-side grants when the receiver is itself a manager console. */
export function getManagerReceiverGrants(): ManagerReceiverGrantMap {
  return selectIsolation() === 'strict' ? STRICT_MANAGER_RECEIVER_GRANTS : NORMAL_MANAGER_RECEIVER_GRANTS;
}

/**
 * Channels that are 100% system-owned — disk `config/acl.json` is not
 * consulted for these. Membership here is the trigger for the infra
 * short-circuit in `checkAcl` (the disjoint-union invariant).
 *
 * NOT used for receiver-side verb selection. Verb is intent-driven via
 * `pickVerb`/`gateInbound` in `acl.ts` — both push and conversation require
 * `i` (post-fold: push is gated as a message), a request requires `a`,
 * regardless of where the message lands. If you find yourself reaching for
 * `SYSTEM_OWNED_CHANNELS.has(channel)` to decide which bit to check, you're
 * regressing the verb-selection cleanup; use `gateInbound(bits, op)` instead.
 */
export const SYSTEM_OWNED_CHANNELS: ReadonlySet<string> = new Set(['__design', '__configure']);

/**
 * Manager-console host folders. When `checkAcl` is called with one of these
 * as `agentFolder`, the receiver-side grant comes from
 * `getManagerReceiverGrants()` rather than disk `acl.json`. Same disjoint-
 * union invariant as `SYSTEM_OWNED_CHANNELS`, keyed by receiver folder
 * instead of channel name.
 */
export const MANAGER_CONSOLE_FOLDERS: ReadonlySet<string> = new Set([
  '.design-manager',
  '.config-manager',
  '.security-manager',
]);
