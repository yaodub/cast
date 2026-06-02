/**
 * Transport framework — in-tree contract shared by all routed transports.
 *
 * Mirrors the @getcast/extension-schema shape (`defineExtension`, registry,
 * narrow factory `ctx`) but stays in the server tree because transports are
 * not expected to be third-party.
 *
 * Routed transports (telegram, email, future Slack/Discord) export a
 * `defineTransport({...})` value and are registered at server startup. The
 * registry (`./registry.ts`) walks routes.json, validates each entry against
 * the transport's `configSchema`, builds a narrow `TransportContext` per
 * transport, and constructs the instance.
 *
 * Bespoke transports (`local`, `web`, `console`) are not "routed" — they're
 * constructed from server resources rather than routes.json — and stay
 * outside this framework.
 */
import type { z } from 'zod';

import type { BusAddress } from '../auth/address.js';
import type { SystemCommandDef } from '../commands/types.js';
import type { AnyPacket, ApprovalResponsePayload, Attachment, Evt } from '../types.js';

// ---------------------------------------------------------------------------
// Transport interface (canonical source of truth)
// ---------------------------------------------------------------------------

/** Context passed to transports for outbound routing. */
export interface OutboundContext {
  agentAddress: string;
  channel?: string;
}

/**
 * A transport is a delivery mechanism (Telegram, CLI/WebSocket).
 * Not to be confused with "channels" (conversation presets like default, scratch).
 */
export interface Transport {
  name: string;
  /**
   * If true, the gateway defers marking packets delivered.
   * The transport is responsible for calling markDelivered when the client acks receipt.
   * Used by transports where the client is cache-like (web browser) — ws.send() success
   * does not imply the packet reached a durable store on the client.
   */
  deferredAck?: boolean;
  /** Send a packet to a participant. */
  send(pkt: AnyPacket, ctx: OutboundContext): Promise<void>;
  /** Does this transport own the given participant address? */
  ownsParticipant(participantAddress: string): boolean;
  /** Deliver an ephemeral event (typing, error, etc.). */
  sendEvent(evt: Evt): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

// ---------------------------------------------------------------------------
// Logger — pino-compatible, mirrors @getcast/extension-schema
// ---------------------------------------------------------------------------

/** Structured logger interface. Pino satisfies this. */
export interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// TransportContext — narrow façade injected by the registry
// ---------------------------------------------------------------------------

/**
 * Server capabilities a routed transport gets at construction time.
 *
 * Replaces today's raw `{ gateway, bus }` injection so transports declare
 * what they need rather than reaching into server objects. Each method's
 * signature is what's currently called on `gateway` / `bus` from inside
 * `transports/telegram.ts` and `transports/email.ts`.
 */
export interface TransportContext {
  /** Forward an inbound message into the gateway. Validates identity, runs system commands, dispatches to the agent. */
  ingestInbound: (
    from: string,
    to: string,
    text: string,
    senderName: string,
    routing?: { channel?: string; qualifier?: string },
    attachments?: Attachment[],
  ) => void;

  /** Forward an approval response (approve/reject) for an outstanding agent prompt. */
  ingestApprovalResponse: (
    from: string,
    to: string,
    response: ApprovalResponsePayload,
  ) => void;

  /** Canonicalise a route's `address` field at construction time (label → BusAddress). */
  resolveAddress: (address: string) => BusAddress | undefined;

  /** System commands the server registers (e.g. /name, /help). Used by Telegram to publish a BotFather command menu. */
  listSystemCommands: () => SystemCommandDef[];

  /** Per-transport child logger. */
  log: Logger;
}

// ---------------------------------------------------------------------------
// Admin descriptor — declares enough metadata for the admin UI to render
// the per-transport form generically. Ships from server to web over tRPC.
// ---------------------------------------------------------------------------

/**
 * One field in a transport's admin form. Keys are flat — nested transports
 * (e.g. email's `imap.host`) flatten on the wire and rebuild on save through
 * the transport's own `configSchema` (`.transform()` or equivalent).
 */
export interface AdminField {
  /** Wire key — appears as a top-level property on the form payload. */
  key: string;
  /**
   * Dotted path on the stored entry, defaults to `key`. Used for transports
   * with nested config (email's `imap.host`, `smtp.pass`). The form sees flat
   * keys; the admin router lenses them onto the entry via this path before
   * persisting.
   */
  path?: string;
  type: 'text' | 'password' | 'number';
  label: string;
  placeholder?: string;
  helpText?: string;
  /**
   * Optional visual grouping for the rendered form. Fields with the same
   * group string render together under a sub-heading; ungrouped fields render
   * inline. Used by email to separate IMAP / SMTP credential blocks.
   */
  group?: string;
  /**
   * Sensitive field — server masks the value on read and resolves a
   * passed-back mask against the on-disk value when writing.
   */
  secret?: boolean;
  /** Field is not required (form submission allows blank). */
  optional?: boolean;
}

/**
 * Per-transport admin metadata. Consumed by the generic admin route page.
 *
 * `summarize` runs on the server to project the route entry into the table's
 * "Details" column (e.g. masked token for telegram, email address for email).
 *
 * `setupInstructions` is rendered as markdown by the web-ui and shown in the
 * collapsible "How to get these credentials" disclosure under the form.
 */
export interface TransportAdminDescriptor<TEntry = unknown> {
  displayLabel: string;
  fields: readonly AdminField[];
  summarize: (entry: TEntry) => string;
  setupInstructions?: string;
}

// ---------------------------------------------------------------------------
// TransportDefinition — what defineTransport() returns
// ---------------------------------------------------------------------------

/**
 * Routed-transport definition. The shape closely mirrors `ExtensionDefinition`,
 * minus the per-agent / tooling / connect-probe surface that doesn't apply to
 * transports.
 *
 * `TConfig` is the parsed shape of `routes.json[name]` — typically an array
 * of route entries. Each transport owns its own schema; the registry only
 * sees `unknown` until it dispatches to `def.configSchema.parse`.
 *
 * `addressPrefix` is the participant-address namespace this transport owns
 * (e.g. `'tg'` for `tg:12345`, `'email'` for `email:foo@bar`). Used by the
 * gateway to register inbound bus routes and by the registry to detect
 * collisions with system-reserved prefixes. Often differs from `name` —
 * Telegram is `name='telegram'`, `addressPrefix='tg'`.
 *
 * No `secretsSchema`: routed transports get every field — including
 * credentials — from a single routes.json entry. Splitting one entry into
 * config-vs-secrets at validation time adds complexity without operator
 * benefit. A separate secrets schema can be added later if/when a transport
 * needs out-of-band credential injection.
 */
export interface TransportDefinition<TConfig> {
  name: string;
  addressPrefix: string;
  configSchema: z.ZodType<TConfig>;
  create: (ctx: TransportContext, config: TConfig) => Transport | null;
  /**
   * Admin UI metadata. The admin page is registry-driven — adding a new
   * transport requires *only* declaring this descriptor and a `registerTransport`
   * call. No edits to the admin router, web-ui form, or schemas.
   *
   * `TConfig` is typically `Array<TEntry>`; the descriptor's `summarize` and
   * field keys describe a single entry, not the whole array.
   */
  admin: TransportAdminDescriptor;
}

/**
 * Define a routed transport. Identity function — exists for type inference.
 *
 * ```typescript
 * export const telegram = defineTransport({
 *   name: 'telegram',
 *   addressPrefix: 'tg',
 *   configSchema: TelegramConfigSchema,
 *   create: (ctx, bindings) => new TelegramTransport(ctx, bindings),
 * });
 * ```
 */
export function defineTransport<TConfig>(
  def: TransportDefinition<TConfig>,
): TransportDefinition<TConfig> {
  return def;
}
