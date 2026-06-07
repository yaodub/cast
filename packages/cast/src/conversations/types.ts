import { z } from 'zod';

// --- Channel config (static, defined per agent) ---

/** Node's setTimeout silently clamps delays above this to 1ms, firing immediately. */
export const MAX_IDLE_TIMEOUT_MS = 2_147_483_647;

/** Cast's operational default for channels with no explicit `idle_timeout` setting at the
 *  whole-config level (i.e. when no `channel.json` file exists, and for the admin UI's
 *  "create new agent" scaffold). 30 minutes, in milliseconds. Not part of the agent-format
 *  spec — a different Cast distribution could pick a different value and still produce
 *  spec-conformant agents. Field-level "missing" inside an authored `channel.json` is a
 *  parse error, not a silent fill from this constant. */
export const DEFAULT_IDLE_TIMEOUT_MS = 1_800_000;

/** Schema for channel.json on disk — no bootstrap/cleanup content (those are separate .md files).
 *  `idle_timeout` is required: explicit `null` means single-shot; a positive integer means
 *  persistent. `.strict()` rejects unknown keys so typos (e.g. legacy `ttl:`) surface at
 *  parse time instead of being silently dropped. */
export const ChannelJsonSchema = z.object({
  idle_timeout: z.number().int().positive().max(MAX_IDLE_TIMEOUT_MS).nullable(),
  lifecycle: z.enum(['none', 'bootstrap-only', 'cleanup-only', 'full']).default('none'),
  log_messages: z.boolean().default(true),
  use_sharding: z.boolean().default(false),
  disabled_tools: z.array(z.string()).default([]),
  show_co_participants: z.boolean().default(true),
}).strict();

export type ChannelJsonConfig = z.infer<typeof ChannelJsonSchema>;

/** The on-disk shape of a default channel.json — used as a fallback when reading from disk
 *  fails (file missing/unparseable). Distinct from `DEFAULT_CHANNEL` below, which carries
 *  derived runtime fields (`bootstrapEnabled`/`cleanupEnabled`). */
export const DEFAULT_CHANNEL_JSON: ChannelJsonConfig = {
  idle_timeout: DEFAULT_IDLE_TIMEOUT_MS,
  lifecycle: 'none',
  log_messages: true,
  use_sharding: false,
  disabled_tools: [],
  show_co_participants: true,
};

/** Runtime channel type — includes resolved bootstrap/cleanup content from .md files. */
export interface AgentChannel {
  /** Resolved bootstrap content from .md file (present only when lifecycle includes bootstrap). */
  bootstrap?: string;
  /** Resolved cleanup content from .md file (present only when lifecycle includes cleanup). */
  cleanup?: string;
  /** Whether bootstrap phase is enabled (derived from lifecycle). */
  bootstrapEnabled: boolean;
  /** Whether cleanup phase is enabled (derived from lifecycle). */
  cleanupEnabled: boolean;
  /** Whether the server records messages for this channel. User channels write to
   *  agent.db's `message_log` bundle; console channels write to console.db's
   *  `message_log` bundle. `false` disables logging at the runner level — the
   *  store is not injected, so logInbound/logOutbound/logEvent become no-ops
   *  and the request/approval MCP tools (which need agentDb) are also
   *  unavailable on user channels for this run. */
  log_messages: boolean;
  /** Whether qualifier-based sub-conversations are supported. */
  use_sharding: boolean;
  /** Tool patterns disabled for this channel (exact names or domain globs like "task__*"). */
  disabled_tools: string[];
  /** Whether the agent is aware of other participants on this channel. When false, the
   *  `<other-participants>` prompt element is replaced with an explicit disabled marker and
   *  `conversation__list_summaries` returns only the caller's own conversations plus a static
   *  policy note. Default true (the schema fills it; only hand-built console channel
   *  literals omit it, where co-participant awareness is moot). Treat absence as true —
   *  only an explicit false disables. Visibility control, not conversation isolation:
   *  conversations are always keyed per participant regardless. */
  show_co_participants?: boolean;
  /** Conversation idle timeout in ms. Resets on each user message. null = single-shot. */
  idle_timeout: number | null;
}

export type ChannelsConfig = Record<string, AgentChannel>;

/** The implicit default channel — used when no `channel.json` file exists at all (whole-config
 *  fallback). Field-level "missing" in an authored `channel.json` is a parse error, not a
 *  silent fill; this constant only applies when the file is absent. */
export const DEFAULT_CHANNEL: AgentChannel = {
  idle_timeout: DEFAULT_IDLE_TIMEOUT_MS,
  bootstrapEnabled: false,
  cleanupEnabled: false,
  log_messages: true,
  use_sharding: false,
  disabled_tools: [],
  show_co_participants: true,
};

export const DEFAULT_CHANNEL_NAME = 'default';

// --- Conversation key (composite, deterministic from channel config + message metadata) ---

export interface ConversationKey {
  channel: string;
  participant: string | null;
  qualifier: string | null;
}

// Conversation state moved to AgentStateStore (state-store.ts).

// --- Conversation runtime state machine (model spec §2) ---

/**
 * The runtime state of a Conversation. Exactly one at any time. Orthogonal to
 * `phase` (`'new' | 'active' | 'expiring' | 'terminating'`) which is monotone-
 * forward and carries the cleanup-turn semantics (output suppression,
 * auto-close) plus the server-shutdown marker.
 *
 * - `idle-no-runner`   — no runner attached; mailbox may briefly hold work before
 *                        a requestSlot moves the conversation to `awaiting-slot`.
 * - `awaiting-slot`    — queued on SlotPool; runner null; mailbox accumulating.
 * - `running`          — slot held, runner constructed, spawn-loop in flight.
 *                        Factory construction is synchronous from slot-acquire
 *                        to first await, so there's no externally-observable
 *                        "spawning" window — IPC pipe is usable as soon as
 *                        state === 'running'. The cleanup turn
 *                        (phase === 'expiring') is a `running` state too —
 *                        phase carries the distinction.
 * - `idle-with-runner` — runner alive between SDK turns; slot still held;
 *                        eligible for swap-eviction.
 * - `destroyed`        — terminal. Removed from catalog; resolvers fired; slot released.
 */
export type ConversationState =
  | 'idle-no-runner'
  | 'awaiting-slot'
  | 'running'
  | 'idle-with-runner'
  | 'destroyed';

/**
 * Lifecycle phase, orthogonal to state. Monotone forward.
 *
 * - `new` — initial; before any successful spawn.
 * - `active` — first successful spawn settled; normal operation.
 * - `expiring` — cleanup turn in flight (user/TTL-initiated). Conversation
 *   will be destroyed after the cleanup turn completes.
 * - `terminating` — server-initiated shutdown. K.2 folded the prior
 *   `_shuttingDown` boolean into the phase union so the "ignore work, we're
 *   terminal" semantics live on the discriminated union and emit a bus
 *   `phase` event. Distinct from `expiring`: no cleanup turn runs, teardown
 *   is unconditional.
 *
 * Transitions (monotone-forward):
 * - `new` → any of `active`, `expiring`, `terminating`
 * - `active` → `expiring` | `terminating`
 * - `expiring` → `terminating`  (server shutdown during a cleanup turn)
 * - `terminating` → ∅  (terminal)
 */
export type ConversationPhase = 'new' | 'active' | 'expiring' | 'terminating';

// --- TTL meta (idle-timeout / manual-end timer payload) ---

/**
 * Captured at TTL schedule time and replayed when the timer fires. Carries the
 * cleanup-message hint, channel reference, and participant for the cleanup
 * notification path.
 *
 * Mirrors `agent/session-host.ts:IdleTimeoutMeta` during the migration. The
 * session-host copy will be removed when the migration completes.
 */
export interface IdleTimeoutMeta {
  conversationKey: string;
  channelName: string;
  cleanup: string | undefined;
  cleanupEnabled: boolean;
  participant: string | undefined;
  idle_timeout: number;
  /** Set when `conversation__end` shortens the idle timeout — used to notify on user-message reset. */
  manualEnd?: boolean;
}

// --- Conversation reference contract (minimal surface consumed by TTL) ---

/**
 * The minimal Conversation surface that `ConversationTtl` depends on. The full
 * `Conversation` class implements this plus a wider API.
 *
 * Defined here so TTL is testable in isolation without dragging in the full
 * Conversation/Catalog graph.
 */
export interface ExpirableConversation {
  readonly scope: string;
  readonly key: string;
  expire(cleanup: string | null): Promise<void>;
}
