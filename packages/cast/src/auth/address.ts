/**
 * Address parsing library + branded identifier types.
 *
 * Two levels of parsing:
 *   Core: parseAddress('agent:main')       → { prefix: 'agent', id: 'main' }
 *   Agent: parseAgentAddress('agent:main/scratch') → { prefix: 'agent', id: 'main', channel: 'scratch' }
 *
 * The bus uses the core parser to dispatch by prefix.
 * The agent handler uses the extended parser to extract channel.
 * Channel is an agent-handler concern, not a bus concern.
 *
 * Branded types section below is the type-system enforcement of the
 * address-space / persistence-space partition. Each brand is a string at
 * runtime (zero overhead) but a distinct type at compile time, so a function
 * declaring `identity: IdentityId` cannot accidentally accept a
 * `BusAddress` or an `AgentFolder`. Producers stamp the brand once at the
 * boundary; consumers declare what shape they accept.
 */

// ---------------------------------------------------------------------------
// Branded identifier types
// ---------------------------------------------------------------------------

/** Bus routing key — `a:<guid>@<issuer>`, `u:<guid>@<issuer>`, `tg:<id>`, etc. */
export type BusAddress = string & { readonly __brand_BusAddress: unique symbol };

/** Human/LLM-facing agent alias (e.g. manifest `name`). Resolves via `bus.resolveByLabel`. */
export type AgentLabel = string & { readonly __brand_AgentLabel: unique symbol };

/** Filesystem directory under `mnt/agents/`. Persistence-space only — never crosses the bus. */
export type AgentFolder = string & { readonly __brand_AgentFolder: unique symbol };

/** Identity row PK — `u:<guid>@<issuer>`, `local`, `a:<guid>@<issuer>`, `ext:*`. */
export type IdentityId = string & { readonly __brand_IdentityId: unique symbol };

/** Transport-bound handle — `tg:12345`, `cli:alice`, `admin:local`, `email:foo@bar`. */
export type Handle = string & { readonly __brand_Handle: unique symbol };

/** Channel name within an agent — `default`, `design`, `__configure`, etc. */
export type ChannelName = string & { readonly __brand_ChannelName: unique symbol };

// Type-only stamping helpers. Zero runtime cost — just a cast that documents
// the producer's intent. Use ONLY where the input has been structurally
// validated to be of the named shape (parser output, bus lookup result,
// builder return). NEVER use these to launder LLM-supplied strings.
export const asBusAddress           = (s: string): BusAddress => s as BusAddress;
export const asAgentLabel           = (s: string): AgentLabel => s as AgentLabel;
export const asAgentFolder          = (s: string): AgentFolder => s as AgentFolder;
export const asIdentityId           = (s: string): IdentityId => s as IdentityId;
export const asHandle               = (s: string): Handle => s as Handle;
export const asChannelName          = (s: string): ChannelName => s as ChannelName;

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

export interface Address {
  prefix: string;
  id: string;
}

export interface AgentAddress extends Address {
  channel: string | undefined;
}

/**
 * Parse a base address of the form `prefix:id`.
 * Throws on malformed input.
 */
export function parseAddress(addr: string): Address {
  const colonIdx = addr.indexOf(':');
  if (colonIdx === -1 || colonIdx === 0 || colonIdx === addr.length - 1) {
    throw new Error(`Invalid address: "${addr}" (expected "prefix:id")`);
  }

  const prefix = addr.slice(0, colonIdx);
  const rest = addr.slice(colonIdx + 1);

  // Rest must not contain '/' — that's agent-level routing
  if (rest.includes('/')) {
    throw new Error(`Invalid address: "${addr}" (use parseAgentAddress for paths)`);
  }

  return { prefix, id: rest };
}

/**
 * Parse an agent address of the form `prefix:id` or `prefix:id/channel`.
 * Accepts both `agent:main` and `agent:main/scratch`.
 */
export function parseAgentAddress(addr: string): AgentAddress {
  const colonIdx = addr.indexOf(':');
  if (colonIdx === -1 || colonIdx === 0 || colonIdx === addr.length - 1) {
    throw new Error(`Invalid agent address: "${addr}" (expected "prefix:id[/channel]")`);
  }

  const prefix = addr.slice(0, colonIdx);
  const rest = addr.slice(colonIdx + 1);
  const slashIdx = rest.indexOf('/');

  if (slashIdx === -1) {
    return { prefix, id: rest, channel: undefined };
  }

  const id = rest.slice(0, slashIdx);
  const channel = rest.slice(slashIdx + 1);

  if (!id || !channel) {
    throw new Error(`Invalid agent address: "${addr}" (empty id or channel)`);
  }

  return { prefix, id, channel };
}

/** Check if an address has a given prefix without parsing. */
export function hasPrefix(addr: string, prefix: string): boolean {
  return addr.startsWith(prefix + ':');
}

/** Build an address string from parts. */
export function buildAddress(prefix: string, id: string, channel?: string): string {
  const base = `${prefix}:${id}`;
  return channel ? `${base}/${channel}` : base;
}

// ---------------------------------------------------------------------------
// Percent-encoding utilities
// ---------------------------------------------------------------------------

const RESERVED_RE = /[%/:~|@]/g;

/** Percent-encode reserved address characters: %, /, :, ~, |, @ */
export function encodeAddressValue(raw: string): string {
  return raw.replace(RESERVED_RE, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/** Decode percent-encoded address values. */
export function decodeAddressValue(encoded: string): string {
  return encoded.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

// ---------------------------------------------------------------------------
// Participant addresses
// ---------------------------------------------------------------------------

/**
 * Structural participant validity — the form contract for any participant
 * address above the gateway. TRUE for a bare user identity (`u:…`, no handle
 * suffix), an agent (`a:…`), an operator surface (`cli:`/`admin:`), or a
 * console surface (`console:…` — its own tier, self-identifying like the
 * operator; server-scope console pushes carry it as the receiving
 * conversation's participant). FALSE for a compound (`u:…/tg:…`) and for a
 * raw transport handle (`tg:`/`web:`/`email:`) — the wire invariant lives at
 * the gateway (`resolveWire`), so a participant reaching the agent layer must
 * already be transport-blind. `ext:*` is sender-only and rejected here too.
 *
 * Type guard: every accepted form IS its own identity id (post-Stage-D the
 * operator and console surfaces and the agent address resolve to themselves;
 * a bare `u:` is the IdP row PK), so passing the check narrows to
 * `IdentityId` — validate-then-brand at the chokepoint, trust the brand inside.
 */
export function isParticipantAddress(addr: string): addr is IdentityId {
  if (addr.includes('/')) return false;
  return addr.startsWith('u:') || isAgent(addr) || isOperatorHandle(addr) || addr.startsWith('console:');
}

/**
 * Extract identity from address. Compound (`u:abc/tg:1`) → identity part;
 * everything else → pass-through. Operator handles (`cli:`/`admin:`) are their
 * own identity — the IdP resolves them to themselves, so the pass-through
 * (no `/`) returns the handle. There is no `local` sentinel to translate to.
 */
export function extractIdentity(addr: string): IdentityId {
  const slashIdx = addr.indexOf('/');
  return asIdentityId(slashIdx === -1 ? addr : addr.slice(0, slashIdx));
}

/** Extract handle from address. Compound → handle part; agent → undefined (no transport handle). */
export function extractHandle(addr: string): Handle | undefined {
  if (isAgent(addr)) return undefined;
  const slashIdx = addr.indexOf('/');
  return asHandle(slashIdx === -1 ? addr : addr.slice(slashIdx + 1));
}

/** Extract handle prefix. "u:a7f3k/tg:12345" → "tg"; "tg:12345" → "tg"; agent → undefined. */
export function extractHandlePrefix(addr: string): string | undefined {
  const handle = extractHandle(addr);
  if (!handle) return undefined;
  const colonIdx = handle.indexOf(':');
  return colonIdx === -1 ? handle : handle.slice(0, colonIdx);
}

// ---------------------------------------------------------------------------
// Address classification — exhaustive, mutually exclusive
// ---------------------------------------------------------------------------

/**
 * Operator-class handles: transports bound to the physical machine (localhost
 * only, trusted by machine-access boundary). Today: CLI and admin console.
 * Used to bypass server firewall and identity auto-registration — both
 * mechanisms exist to protect against external senders, and the operator is
 * not external.
 *
 * See `auth/identity.ts` — both prefixes short-circuit `idp.resolve` to the
 * `local` identity sentinel.
 */
export function isOperatorHandle(handle: string): boolean {
  return handle.startsWith('cli:') || handle.startsWith('admin:');
}

/**
 * Operator-authorization tier — the single predicate the ACL operator
 * short-circuits consult (`checkAcl`, `getPeerChannels`, `isOperatorOrOwner`).
 * TRUE when an address denotes the human operator: a `cli:`/`admin:` handle —
 * bare, or the handle part of a compound. The operator bypasses the IdP, so its
 * handle IS its identity (`resolve('cli:alice').id === 'cli:alice'`); there is
 * no separate `local` sentinel, and ACL paths that key on `idp.resolve(...).id`
 * (e.g. `projectEventForIdentity`) therefore pass a handle-shaped id caught here.
 *
 * This is the one function a future admin→IdP migration edits: when admin-ness
 * becomes a role on a `u:` identity, the body changes here and the three ACL
 * call sites inherit it. Distinct from `isOperatorHandle` (the *machine-trust*
 * boundary — a transport property consulted at the gateway, where only a bare
 * handle exists): the two coincide today; the migration splits them.
 */
export function isOperatorTier(participant: string): boolean {
  return isOperatorHandle(extractHandle(participant) ?? participant);
}

/**
 * Inside the operator's authoring envelope. The operator tier plus the
 * authoring consoles that act on its behalf (`console:*` — Design/Config/
 * Security Managers). Used by gates like draft-mode that want to allow dev
 * chat while blocking the agent's eventual audience (transports, peer agents).
 */
export function isAuthoringSender(addr: string): boolean {
  return isOperatorTier(addr) || addr.startsWith('console:');
}

/**
 * Resolved human participant — a `u:` identity (bare or compound) or the
 * operator. Excludes agents (`a:`) and services (`ext:`). The operator is a
 * human at a machine-trusted transport; it counts as a user for roster and
 * peer-discovery gates.
 */
export function isUser(addr: string): boolean {
  return addr.startsWith('u:') || isOperatorTier(addr);
}

/** Agent address — canonical `a:<guid>@<issuer>`. Aliases route via `bus.resolveByLabel`. */
export function isAgent(addr: string): boolean {
  return addr.startsWith('a:');
}

/** Internal sender — "ext:*". Agent-internal namespace; never crosses the bus. */
export function isService(addr: string): boolean {
  return addr.startsWith('ext:');
}

/** Agent-internal sender prefix — `ext:*`. The boundary is the agent's routing layer:
 *  these addresses must never appear as a `to` on a routed packet. Treated like a
 *  private subnet — internal to one agent, invisible to the bus and other agents. */
export function isExtAddress(addr: string): boolean {
  return addr.startsWith('ext:');
}

// ---------------------------------------------------------------------------
// Compound classification helpers
// ---------------------------------------------------------------------------

/** Check if an address is a non-user sender (agent or service). */
export function isSystemSender(addr: string): boolean {
  return isAgent(addr) || isService(addr);
}

/**
 * Owner-context test for the cross-conversation push chokepoint. TRUE when the
 * caller is the agent operating AS ITSELF — either no participant (a system /
 * scheduler / service fire that names no target) or the agent's own canonical
 * address. FALSE for a PEER agent (a *different* `a:` address).
 *
 * DISTINCT FROM `isSystemSender` above, and deliberately NOT built on it:
 * `isSystemSender` returns true for ANY `a:`/`ext:` address, so it cannot tell
 * "me" from "another agent" — that conflation is the system-context masquerade
 * (a peer's `a:` address slipping through `!isUser`). This predicate compares
 * against `ownAgentId`, so a peer agent is correctly NOT system context.
 */
export function isSystemContext(participant: string | null | undefined, ownAgentId: string): boolean {
  return participant == null || participant === ownAgentId;
}

/**
 * Read tier — the gate for enumeration surfaces (channel/participant listing,
 * cross-participant summary reads). Pure string computation, no ACL read. Two
 * arms: the agent operating as itself (`isSystemContext`) and the
 * machine-trusted operator surface (`isOperatorTier`). A configured acl
 * `owner` is deliberately NOT read tier — the write tier (the push verdict's
 * `isOperatorOrOwner` arm) adds the owner, so read ⊂ write is structural. A
 * `u:` owner riding an injectable transport cell keeps god-mode *reach*
 * (push is noisy, recipient-visible) but member-scoped *visibility*
 * (enumeration is a silent oracle).
 */
export function isReadTier(participant: string | null | undefined, ownAgentId: string): boolean {
  return isSystemContext(participant, ownAgentId) || (participant != null && isOperatorTier(participant));
}

/**
 * Room-membership test over concrete placement bits (from `membershipBits` in
 * `acl.ts`). `i` = a user placed in the room, `a` = a peer agent placed (answer
 * bit). Either marks the identity as present in the room; empty bits → not a
 * member.
 */
export function isMember(bits: string): boolean {
  return bits.includes('i') || bits.includes('a');
}
