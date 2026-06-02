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
 * declaring `participant: ResolvedParticipant` cannot accidentally accept a
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

/** Compound `identity/handle` form, e.g. `local/admin:local`, `u:a7f/tg:123`. Stamped by the runtime. */
export type ResolvedParticipant = string & { readonly __brand_ResolvedParticipant: unique symbol };

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
export const asResolvedParticipant  = (s: string): ResolvedParticipant => s as ResolvedParticipant;
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
// Compound (resolved) participant addresses
// ---------------------------------------------------------------------------

/**
 * Parsed form of a `ResolvedParticipant` string — split into identity + handle.
 *
 * Note: the brand `ResolvedParticipant` (defined in the brands section above)
 * is the wire-level string. This struct is what you get from parsing one.
 * Don't confuse the two: function args take the brand; this struct is a
 * convenience for code that wants the parts.
 */
export interface ParsedParticipant {
  /** Identity ID — "u:a7f3k" or "local". */
  identity: IdentityId;
  /** Transport handle — "tg:12345", "cli:alice". */
  handle: Handle;
}

/** Check if an address is resolved. Compound addresses have '/'; agent addresses are inherently resolved. */
export function isResolved(addr: string): boolean {
  return addr.includes('/') || isAgent(addr);
}

/** Parse a compound address like "u:a7f3k/tg:12345" into identity + handle. */
export function parseResolvedParticipant(addr: string): ParsedParticipant {
  const slashIdx = addr.indexOf('/');
  if (slashIdx === -1) {
    throw new Error(`Not a resolved address: "${addr}" (no "/")`);
  }
  return {
    identity: asIdentityId(addr.slice(0, slashIdx)),
    handle: asHandle(addr.slice(slashIdx + 1)),
  };
}

/** Build a compound resolved address from identity and handle. */
export function buildResolvedParticipant(identity: IdentityId | string, handle: Handle | string): ResolvedParticipant {
  return asResolvedParticipant(`${identity}/${handle}`);
}

/** Extract identity from address. Compound → identity part; unresolved → pass-through. */
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
 * Inside the operator's authoring envelope. Operator handles (cli/admin —
 * the operator's own keyboard) plus the authoring consoles that act on the
 * operator's behalf (`console:*` — Design/Config/Security Managers).
 *
 * Distinct from `isOperatorHandle`: that one is the *machine-trust boundary*
 * (localhost-only handles that bypass identity auto-registration and the
 * server firewall). This one is the *authoring boundary* — "did the
 * operator, directly or through their tooling, originate this traffic?" —
 * used by gates like draft-mode that want to allow dev chat while blocking
 * the agent's eventual audience (transports, peer agents).
 */
export function isAuthoringSender(addr: string): boolean {
  const handle = extractHandle(addr) ?? addr;
  return isOperatorHandle(handle) || addr.startsWith('console:');
}

/** Resolved user identity — u:xxx or local (with or without /handle suffix). */
export function isUser(addr: string): boolean {
  return addr.startsWith('u:') || addr === 'local' || addr.startsWith('local/');
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
