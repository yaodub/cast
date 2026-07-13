/**
 * ConversationRunner — process/SDK plumbing for a single agent conversation.
 *
 * Two-state machine:
 *
 *   Container state: 'running' (spawn loop active, process alive or
 *                    short-lived gap before/after) → 'closing' (destroy in flight).
 *   Lifecycle phase: new → active → expired (monotone forward).
 *
 * State writes route through `setState()` — the single chokepoint mirrors
 * the discipline `Conversation.setState` enforces. Direct `this._state =`
 * writes are not allowed.
 *
 * The Conversation owns the mailbox, the spawn-cycle driver, the respawn
 * decision, the auth-retry policy, and the "between turns" notion (its own
 * `idle-with-runner` state). The runner is pure execution: receive a prompt,
 * run the container, return the outcome. `markIdle()` fires `onIdle` to the
 * Conversation; the runner's own state stays `'running'`.
 *
 * Lifecycle phase determines output behavior:
 *   - new: first spawn includes bootstrap, DB row created on session ID
 *   - active: normal operation, output routed to user
 *   - expired: output suppressed, auto-close after response
 *
 * Data flows unidirectionally: AgentManager passes hooks down, runner calls
 * them with data. Runner never references its parent or calls parent methods.
 * All decision logic (persistence, routing, respawn) lives upstream.
 */
import type { ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import mime from 'mime';

import {
  IDLE_TIMEOUT,
  MAX_ATTACHMENT_BYTES,
  MAX_OUTPUT_BYTES_DEFAULT,
  MAX_VALIDATION_FAILURES,
  sessionCastSocketPath,
} from '../config.js';
import type { IdentityId } from '../auth/address.js';
import type { ContainerOutput } from '../container/container-runner.js';
import {
  getResolvedAuth,
  readAgentConfig,
  runContainerAgent,
  writeToAgent,
} from '../container/container-runner.js';
import { applyBuiltinToolPolicy } from '../container/sdk-surface.js';
import { resolveModel } from '../lib/resolve-model.js';
import { formatTagAttrs, validateAgentOutput, type ParsedOutput } from '../lib/format.js';
import { systemFormatError } from './agent-spawn-hooks.js';
import { logger } from '../logger.js';
import { startMcpSocketServer, type McpServerDeps } from './mcp-server.js';
import { startConsoleMcpServer, type ConsoleMcpDeps } from '../console/tools.js';
import type { ConsoleName } from '../console/index.js';
import { conversationPkt, hashConversationKey, previewTextPkt } from '../gateway/packets.js';
import type { ConversationPkt, PreviewPkt } from '../gateway/packets.js';
import type { AgentChannel } from '../conversations/types.js';
import type { AgentDb, LogEventFn } from './agent-db.js';
import type { PendingMessage, SpawnOutcome, TeardownMode } from '../conversations/runner.js';
import type { MessageLogStore } from '../lib/message-log-store.js';
import type { AgentStateStore } from './state-store.js';
import type { ExtensionInstance } from '../extensions/registry.js';
import type { Attachment, AttachmentMeta, Host, RouteResult, TypingEvt, TypingStoppedEvt } from '../types.js';
import { persistAttachmentFromFile, attachmentContainerPath } from '../lib/attachment-store.js';
import { conversationKeyToPath, generateId } from '../lib/utils.js';
import { agentPath } from '../config.js';
import fs from 'fs';
import pathMod from 'path';
import { errorMessage } from '../lib/utils.js';

/** Reason discriminator for fallback emission. Drives event logging and, for
 *  `external_kill`, a differentiated user-facing message. Other discriminators
 *  intentionally share generic copy — the user can't act on detail like
 *  "agent process crashed" vs "auth exhausted." `external_kill` is the
 *  exception because the action ("retry; likely resource pressure") IS
 *  user-actionable. */
export type FallbackReason =
  | 'container_error'
  | 'auth_exhausted'
  | 'external_kill'
  | 'not-configured'
  | 'invalid-credentials'
  | 'quota-exhausted'
  | 'claude-unavailable';

/** Build the user-facing fallback message. Each Claude-unreachable variant
 *  gets actionable copy. Structured cause for every variant is captured via
 *  `logEvent` regardless. */
export function formatFallbackMessage(reason: FallbackReason): string {
  switch (reason) {
    case 'not-configured':
      return "⚠️ Claude isn't set up yet. Open the server dashboard to configure it.";
    case 'invalid-credentials':
      return '⚠️ Claude rejected the API key.';
    case 'quota-exhausted':
      return '⚠️ Your Claude account is out of usage.';
    case 'claude-unavailable':
      return '⚠️ Claude is currently unavailable. Try again in a few minutes.';
    case 'external_kill':
      return [
        '⚠️ The agent container was unexpectedly terminated by the host runtime.',
        '',
        'This usually means resource pressure on the host (memory). Retrying often works. If it keeps happening, reduce concurrent agent activity or check the activity log.',
      ].join('\n');
    case 'auth_exhausted':
    case 'container_error':
      return [
        '⚠️ Agent stopped without producing a response.',
        '',
        'Try sending the message again. If this keeps happening, check the activity log.',
      ].join('\n');
  }
}

/** Wait for a child process to exit, up to `timeoutMs`. Resolves `true`
 *  if the process exited within the window, `false` if the timer fired
 *  first. No-op when the process has already exited. Used by `destroy()`
 *  in `drain` mode to bound the close-then-SIGTERM sequence. */
async function waitForExit(
  process: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (process.exitCode !== null || process.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      process.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    process.once('exit', onExit);
  });
}

/**
 * Runner state machine.
 *
 * - `running`: the runner's owning spawn cycle is active. Constructed runners
 *   start here. The process may not yet be alive (between construction and
 *   `spawn()` entry, or between SDK turns) — `running` means "this runner is
 *   the conversation's current execution slot," not "process is processing."
 *   Conversation observes "between turns" via its own `idle-with-runner`
 *   state, triggered by the runner's `onIdle` hook.
 * - `closing`: `destroy()` was called; teardown in flight or complete.
 *   `isDestroyed` returns `_state === 'closing'`.
 *
 * Paging is invisible to the persistence layer — paged-out conversations
 * stay `'active'` in the state-store and resume via lazy fault-in (a fresh
 * runner spawned with `--resume {ccSessionId}` from the conv record).
 * The runner itself has no "paged" notion; once destroyed, it's gone from
 * the map.
 */
type ContainerState = 'running' | 'closing';

/** Inbound stimulus class. `'participant'` is real user input (no wrap); the
 *  others are framework injections wrapped as `<cast:kind>...</cast:kind>` so
 *  the agent prompt can distinguish them. */
export type DeliverKind =
  | 'participant'
  | 'schedule'
  | 'service'
  | 'lifecycle'
  | 'watch'
  | 'push'
  // Framework correction / notice repipes (systemFormatError, systemUndelivered).
  // Keeps the streamer on its current streamId so a retry seal updates the
  // same bubble instead of opening a new one.
  | 'system';

/** Wrap inbound text according to its `kind`. Participant text passes through
 *  unmodified (the agent treats it as user input); every other kind gets
 *  the `<cast:kind>...</cast:kind>` envelope so the system prompt can
 *  recognize the framework stimulus. Single source of truth — used by both
 *  the live `pipeMessage` path and the mailbox-drain in `spawn()`. */
function wrapForKind(
  text: string,
  kind?: DeliverKind,
  attrs?: Record<string, string>,
): string {
  const k = kind ?? 'participant';
  return k === 'participant'
    ? text
    : `<cast:${k}${formatTagAttrs(attrs)}>${text}</cast:${k}>`;
}

/** Lifecycle hooks passed to spawn() — AgentManager provides implementations.
 *
 *  **Adding a new field?** Update `gateUserHooks` below to place it in either
 *  the user-facing (gated) or internal (passthrough) partition. The proxy
 *  enumerates fields exhaustively; new optional fields can be silently
 *  omitted from the gated return without the explicit listing — TypeScript
 *  will not catch this. Add a corresponding both-branches test in
 *  `conversation-runner.test.ts`. See `gateUserHooks` JSDoc for the rule. */
export interface SpawnHooks {
  /** Called when a new CC session ID is obtained from the container. */
  onSessionId: (sessionId: string) => void;
  /** Called to send an outbound message packet to the participant. */
  onOutput: (pkt: ConversationPkt, channel: string, conversationKey: string) => Promise<void>;
  /** Push an ephemeral preview frame. Silent on ACL `o` denial — the
   *  eventual seal fires `systemUndelivered` once instead. */
  onPreview?: (pkt: PreviewPkt, channel: string, conversationKey: string) => void;
  /** Called to emit typing/typing_stopped events. */
  onTyping: (evt: TypingEvt | TypingStoppedEvt) => void;
  /** Called on lifecycle events (bootstrap, compaction, auth refresh,
   *  fresh-conversation). `fresh_conversation` has no `active` flag —
   *  it's a one-shot edge fired right before a spawn that starts
   *  without an SDK resume id. */
  onLifecycle?: (
    phase: 'bootstrap' | 'compacting' | 'auth_refresh' | 'fresh_conversation',
    active: boolean,
    extras?: { preTokens?: number; trigger?: 'manual' | 'auto' },
  ) => void;
  /** Called when agent output contains a `<cast:query>` or `<cast:request>`
   *  tag. `kind` echoes the sender's wire-format choice — `query` (q-bit,
   *  expects an answer) or `request` (r-bit, fire-and-forget) — and is
   *  used downstream to gate the matching ACL bit and preserve the tag
   *  the receiver sees. See acl.ts on q/r/a pairing. */
  onRequest?: (kind: 'query' | 'request', target: string, channel: string, text: string, qualifier?: string) => Promise<void>;
  /** Called when agent output contains a <cast:answer> tag. */
  onResponse?: (requestId: string, text: string) => Promise<void>;
  /** Structured event logger surfaced into the Conversation so spawn-cycle
   *  telemetry (auth retries, exhaustion) lands in agent.db. Optional — hosts
   *  that don't carry an event log (raw test fixtures) leave it unset and
   *  emissions become no-ops. */
  logEvent?: LogEventFn;
}

/** Phantom brand marking a `SpawnHooks` value that has been wrapped by
 *  `gateUserHooks`. No runtime cost — the brand exists only in the type
 *  system. Code that requires gated emission (the runner's `lastHooks`,
 *  `emitFallback`, future helpers) takes `GatedSpawnHooks`; raw
 *  `SpawnHooks` is not assignable to it. */
declare const GATED_HOOKS_BRAND: unique symbol;
export type GatedSpawnHooks = SpawnHooks & { readonly [GATED_HOOKS_BRAND]: 'gated' };

/**
 * Phase-aware proxy over `SpawnHooks`. While `isExpired()` is true, every
 * user-facing hook call is dropped; internal hooks pass through.
 *
 * This is the single chokepoint enforcing "no user emission during the
 * cleanup turn." Emission sites in this file call hooks unconditionally;
 * the proxy decides whether the call reaches its implementation. Replaces
 * the ~10 inline `if (!this.isExpired)` checks that previously policed
 * each emission site individually — a pattern that scaled with sites
 * (the streaming work added `onPreview` without the matching guard and
 * leaked intermediate text during cleanup turns).
 *
 * Fields are listed exhaustively (no spread, no fallthrough). When adding
 * a new field to `SpawnHooks`, place it explicitly in the user-facing
 * (gated) or internal (passthrough) partition below — failure to do so
 * causes a compile error at the return literal.
 *
 * Per-field rationale:
 * - User-facing (gated): all hooks that produce user-visible output or
 *   user-routed side-effects. `onLifecycle` is gated wholesale — every
 *   transport-visible lifecycle event (compaction banner, auth-refresh
 *   indicator, fresh-conversation badge) is silent during cleanup.
 *   `onRequest`/`onResponse` are cross-agent traffic but still
 *   externally-visible side-effects; a closing conversation should not
 *   initiate new fan-out, so they're gated too.
 * - Internal: `logEvent` (telemetry) passes through always.
 *
 * Return type is branded `GatedSpawnHooks` — the one `as GatedSpawnHooks`
 * cast is justified at the assertion point; every downstream reference is
 * provably gated by the type system.
 *
 * Exported for direct unit testing — production code reaches it via
 * `spawn()`'s wrap, not by importing it.
 */
export function gateUserHooks(hooks: SpawnHooks, isExpired: () => boolean): GatedSpawnHooks {
  const gated: SpawnHooks = {
    // User-facing — dropped while expiring.
    onSessionId: (id) => {
      if (isExpired()) return;
      hooks.onSessionId(id);
    },
    onOutput: async (pkt, ch, key) => {
      if (isExpired()) return;
      await hooks.onOutput(pkt, ch, key);
    },
    onPreview: hooks.onPreview && ((pkt, ch, key) => {
      if (isExpired()) return;
      hooks.onPreview!(pkt, ch, key);
    }),
    onTyping: (evt) => {
      if (isExpired()) return;
      hooks.onTyping(evt);
    },
    onLifecycle: hooks.onLifecycle && ((phase, active, extras) => {
      if (isExpired()) return;
      hooks.onLifecycle!(phase, active, extras);
    }),
    onRequest: hooks.onRequest && (async (kind, target, ch, text, qualifier) => {
      if (isExpired()) return;
      await hooks.onRequest!(kind, target, ch, text, qualifier);
    }),
    onResponse: hooks.onResponse && (async (id, text) => {
      if (isExpired()) return;
      await hooks.onResponse!(id, text);
    }),
    // Internal — always passes through.
    logEvent: hooks.logEvent,
  };
  return gated as GatedSpawnHooks;
}

// SpawnResult was a flat-interface alias for what `spawn()` returns. The
// conversation-side `SpawnOutcome` is now a discriminated union; the runner
// returns that union directly. The intermediate alias is gone.

export interface ConversationRunnerOpts {
  host: Host;
  agentFolder: string;
  address: string;
  /** Pre-computed conversation key (set by AgentManager). */
  conversationKey: string;
  /** Pre-resolved channel config (set by AgentManager). */
  channel: AgentChannel;
  channelName: string;
  /** Branded — validated at the route chokepoint (or narrowed at a read boundary) before reaching runner construction. */
  participant?: IdentityId;
  /** Delegation target: when set, outbound responses route to this address instead of participant. Same brand contract. */
  replyTo?: IdentityId;
  qualifier?: string;
  /** Seed session ID (overrides DB lookup on first spawn). */
  sessionIdOverride?: string;
  /** Fully assembled system prompt (all layers). Passed through to ContainerInput. */
  systemPrompt?: string;
  /** Whether this is a new conversation (needs bootstrap on first spawn). */
  isNewConversation?: boolean;
  /** Per-agent state store, passed to MCP context. */
  store: AgentStateStore;
  /** Message log bundle — `agentDb.messages` for agent runners, `consoleDb.messages`
   *  for console runners. Receives logInbound/logOutbound writes. */
  messageLog?: MessageLogStore;
  /** Structured event logger — bound to `agentDb.logEvent` for agent runners.
   *  Console runners pass undefined (event logging is agent-scope only). */
  logEvent?: LogEventFn;
  /** Full agent database — threaded through to MCP context for request,
   *  approval, and event-log tools. Undefined for console runners. */
  agentDb?: AgentDb;
  /** Merged disabled tools (agent-wide + channel-level) for MCP tool gating. */
  disabledTools?: string[];
  /** Active extension instances for this agent. */
  activeExtensions?: readonly ExtensionInstance[];
  /** MCP server dependencies for per-conversation socket. Undefined skips socket creation (tests). */
  mcpDeps?: McpServerDeps;
  /** When true, deliver intermediate assistant messages before tool calls. */
  showSteps?: boolean;
  /** Cap on user-visible bytes per agent output. Default `MAX_OUTPUT_BYTES_DEFAULT`. */
  maxOutputBytes?: number;
  /** Resolved IANA timezone for this agent. */
  timezone?: string;
  /** pip config for MCP tool gating. */
  pipConfig?: { allowed_packages: string[] };
  /** MCP TCP port mappings from agent-level servers (external proxies). Only set in TCP mode. */
  agentMcpPorts?: Record<string, number>;
  /** Override the default container mount table. Used by console sessions. */
  overrideMounts?: import('../container/container-mounts.js').VolumeMount[];
  /** Override container CWD. Used by console sessions. */
  workdir?: string;
  /** Override container network policy. Used by console sessions (e.g. design gets "full"). */
  containerNetwork?: string;
  /** Console identifier. When set, a console-specific MCP server is started instead of the normal one. */
  consoleName?: ConsoleName;
  /** Dependencies for the console MCP server (only used when `consoleName` is set). */
  consoleDeps?: ConsoleMcpDeps;
  /** Fired when the agent-runner signals `lifecycle/idle` (between SDK turns).
   *  Conversation observes via its own state machine (`idle-with-runner`);
   *  SlotPool uses this for swap-on-idle-with-waiters. */
  onIdle?: () => void;
  /** Live predicate reading the owning Conversation's expired state. The
   *  runner has no phase field of its own — every gate consults this. Wired
   *  by the factory closure (see `conversations/conversation.ts` factory call). */
  isExpired: () => boolean;
  /** Runner→Conversation hook to begin a cleanup turn (single-shot self-expire
   *  path). Conversation owns phase flip + `<cast:lifecycle>` wrap. */
  requestCleanup: (cleanup: string) => void;
}

/** Mutable context shared between spawn() and handleContainerOutput(). */
interface SpawnContext {
  hooks: SpawnHooks;
  singleShot: boolean;
  sessionId: string | undefined;
  participant: string;
  hadError: boolean;
  outputSentToUser: boolean;
  sessionNotified: boolean;
  firstResult: string | null;
  firstError: string | null;
  /** Cause of `firstError`, when produced by a container-side exit. Captured
   *  from `ContainerOutput.cause` on the first error settle so the post-spawn
   *  fallback path can pick differentiated copy (external_kill → resource
   *  pressure message; others → generic). Streaming error outputs from inside
   *  the container don't carry a cause and leave this undefined. */
  firstErrorCause: 'external_kill' | 'agent_error' | 'timeout' | 'spawn_failure' | undefined;
  authErrorDetected: boolean;
  /** Classified Claude-unreachable reason, set alongside `authErrorDetected`
   *  when the container's `auth_error` output carries a `reason` field. The
   *  Conversation reads this from the SpawnOutcome to decide whether to
   *  retry (invalid-credentials only) or fail fast with a typed fallback. */
  authErrorReason: 'invalid-credentials' | 'quota-exhausted' | 'claude-unavailable' | undefined;
  /** True once the SDK has emitted a successful result event (subtype === 'success'),
   *  whether or not the result text was non-empty. Distinguishes "agent finished
   *  cleanly with nothing to say" from "agent never produced a result" — gates the
   *  spawn-error fallback so the latter still fires but the former doesn't. */
  sdkResultSeen: boolean;
}

export class ConversationRunner {
  readonly host: Host;
  readonly agentFolder: string;
  readonly address: string;
  readonly channelName: string;
  readonly channel: AgentChannel;
  readonly participant: IdentityId | undefined;
  readonly replyTo: IdentityId | undefined;
  readonly qualifier: string | undefined;
  readonly systemPrompt: string | undefined;

  /** Composite key for this conversation (e.g. "scratch|cli:main"). */
  readonly conversationKey: string;

  /** Whether this conversation needs bootstrap on first spawn. */
  readonly isNewConversation: boolean;

  /**
   * Claude Code session ID for this conversation. The runner is the runtime
   * authority — DB is only for crash recovery. Set from:
   *   1. opts.sessionIdOverride (if provided)
   *   2. State store lookup (route time)
   *   3. Container output (updated after each spawn)
   */
  private _ccSessionId: string | undefined;

  /** Whether this is a single-shot channel (idle_timeout: null). */
  private get isSingleShot(): boolean {
    return this.channel.idle_timeout === null;
  }

  // --- State machine ---
  /** Two-state lifecycle — see `ContainerState` doc. Writes route through
   *  `setState()` chokepoint. */
  private _state: ContainerState = 'running';
  /** Whether `spawn()` has completed its bootstrap cycle. Flips `true` on the
   *  first spawn's finally block. Read by the next-spawn `isNew` calculation
   *  to skip bootstrap on subsequent turns. Replaces the prior `_phase === 'new'`
   *  proxy — semantic separation from lifecycle phase (which Conversation owns). */
  private _bootstrapped = false;
  /** Caller-supplied hook fired when the SDK signals `lifecycle/idle`. The
   *  Conversation responds by setting its own `idle-with-runner` state; the
   *  runner's `_state` stays `'running'`. */
  private readonly onIdle?: () => void;
  /** Live predicate for Conversation phase — see `ConversationRunnerOpts.isExpired`. */
  private readonly isExpiredFn: () => boolean;
  /** Cleanup-turn entry hook — see `ConversationRunnerOpts.requestCleanup`. */
  private readonly requestCleanupFn: (cleanup: string) => void;
  /**
   * Environment-invalidation value flag. Set by server-scope consoles when
   * the agent set changes (new folder created, folder archived) — the mount
   * table is frozen at spawn, so the runner needs replacement on next
   * message. Value-typed, not a parallel state machine: orthogonal to
   * `_state` and `_phase`. Caller decides when to replace.
   */
  private _invalidated = false;

  private store: AgentStateStore;
  private messageLog: MessageLogStore | undefined;
  private logEvent: LogEventFn | undefined;
  private agentDb: AgentDb | undefined;
  private disabledTools: string[];
  private activeExtensions: readonly ExtensionInstance[];
  private mcpDeps: McpServerDeps | undefined;
  private readonly showSteps: boolean;
  private readonly maxOutputBytes: number;
  private readonly timezone: string | undefined;
  private readonly pipConfig: { allowed_packages: string[] } | undefined;
  private readonly agentMcpPorts: Record<string, number> | undefined;
  private readonly overrideMounts: import('../container/container-mounts.js').VolumeMount[] | undefined;
  private readonly workdir: string | undefined;
  private readonly containerNetwork: string | undefined;
  private readonly consoleName: ConsoleName | undefined;
  private readonly consoleDeps: ConsoleMcpDeps | undefined;
  /** Consecutive auth error count (reset on successful output). */
  authRetryCount = 0;
  /** Consecutive final-output validation failures (reset on successful final delivery).
   *  Closes the runner after `MAX_VALIDATION_FAILURES`. Intermediate failures don't count. */
  validationFailureCount = 0;

  private mcpCloser: { close: () => void | Promise<void> } | null = null;
  private process: ChildProcess | null = null;
  /** Runtime container name for the live process. Mirrors `process`: set on
   *  spawn, nulled on teardown. The host targets it for egress reconciles. */
  private containerName: string | null = null;
  /** Set on auth_error output — fences `pipeMessage` from piping into a
   *  dead-token container. Per-spawn-cycle: reset at every `spawn()` entry. */
  private authErrorSeen = false;
  /** Cached gated hooks from the most recent `spawn()` call. Re-used by
   *  `pipeMessage` for typing-indicator emission and by `emitAuthExhausted` /
   *  `emitFallback` for fallback delivery. `null` before first spawn.
   *
   *  Typed `GatedSpawnHooks` so any future helper that reads it gets
   *  compile-time confirmation that emission is phase-gated — see
   *  `gateUserHooks` JSDoc. */
  private lastHooks: GatedSpawnHooks | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last time a typing event was emitted (for activity-driven debounce). */
  private lastTypingEmit = 0;

  constructor(opts: ConversationRunnerOpts) {
    this.host = opts.host;
    this.agentFolder = opts.agentFolder;
    this.address = opts.address;
    this.channelName = opts.channelName;
    this.channel = opts.channel;
    this.participant = opts.participant;
    this.replyTo = opts.replyTo;
    this.qualifier = opts.qualifier;
    this._ccSessionId = opts.sessionIdOverride;
    this.systemPrompt = opts.systemPrompt;
    this.conversationKey = opts.conversationKey;
    this.isNewConversation = opts.isNewConversation ?? true;
    this.store = opts.store;
    this.messageLog = opts.messageLog;
    this.logEvent = opts.logEvent;
    this.agentDb = opts.agentDb;
    this.disabledTools = opts.disabledTools ?? [];
    this.activeExtensions = opts.activeExtensions ?? [];
    this.mcpDeps = opts.mcpDeps;
    this.showSteps = opts.showSteps ?? true;
    this.maxOutputBytes = opts.maxOutputBytes ?? MAX_OUTPUT_BYTES_DEFAULT;
    this.timezone = opts.timezone;
    this.pipConfig = opts.pipConfig;
    this.agentMcpPorts = opts.agentMcpPorts;
    this.overrideMounts = opts.overrideMounts;
    this.workdir = opts.workdir;
    this.containerNetwork = opts.containerNetwork;
    this.consoleName = opts.consoleName;
    this.consoleDeps = opts.consoleDeps;
    this.onIdle = opts.onIdle;
    this.isExpiredFn = opts.isExpired;
    this.requestCleanupFn = opts.requestCleanup;
  }

  // =========================================================================
  // Public interface — state queries
  // =========================================================================

  /** Container state: idle, queued, running, closing, or swapped. */
  get state(): ContainerState {
    return this._state;
  }

  /** Whether a close signal has been sent and the container is winding down. */
  get isClosing(): boolean {
    return this._state === 'closing';
  }

  /** Whether `destroy()` has been called. This is folded into state:
   *  `closing` IS "destroyed." `finishSpawnResult` reads this to skip post-
   *  spawn teardown when the catalog's swap-evict already handled it. */
  get isDestroyed(): boolean {
    return this._state === 'closing';
  }

  /** Whether the owning Conversation is in its cleanup phase. Reads through
   *  to the Conversation's phase via the `isExpired` callback passed at
   *  construction — the runner does not hold its own copy of this state, so
   *  the runner's view cannot drift from Conversation's.
   *
   *  Private — production emission gating is enforced by `gateUserHooks` at
   *  the hook boundary, not by callers branching on this getter. Internal
   *  reads remaining in this file encode control-flow decisions (input-pipe
   *  carve-out, container `phase: 'cleanup'` label, close branches,
   *  `markIdle` short-circuit), not emission gates. */
  private get isExpired(): boolean {
    return this.isExpiredFn();
  }

  /**
   * Whether this runner's environment (mounts, MCP tool list, extension
   * surface) has changed since spawn and requires respawn on next message.
   * Set by `invalidate()`; consumed by server-scope console callers when
   * deciding whether to replace the map entry on incoming message.
   */
  get isInvalidated(): boolean {
    return this._invalidated;
  }

  /** Live child process when one exists, else null. Used by host-side
   *  shutdown drain (SIGKILL fallback) and secrets refresh — both need access
   *  while the runner is closing as well as while running. The `process`
   *  field is nulled in `destroy()` after teardown completes, so just
   *  returning it directly is the correct semantic. */
  get activeProcess(): ChildProcess | null {
    return this.process;
  }

  /** Runtime name of the live container, or null when not running. Mirrors
   *  `activeProcess`; the host uses it to target egress reconciles. */
  get activeContainerName(): string | null {
    return this.containerName;
  }

  /**
   * Claude SDK session id tracked by this runner. Exposed so out-of-band
   * replacement paths (e.g. ConfigManagerConsole's invalidation respawn) can thread
   * it as `sessionIdOverride` into the new runner — preserves conversation
   * history across respawn without relying on state-store persistence.
   */
  get ccSessionId(): string | undefined {
    return this._ccSessionId;
  }



  // =========================================================================
  // Public interface — lifecycle methods
  // =========================================================================

  /**
   * Flag this runner's environment as changed (mounts, tools, etc.). The
   * current spawn continues untouched; the flag is consumed by the caller
   * on next-message entry to force a replacement runner.
   */
  invalidate(): void {
    this._invalidated = true;
  }

  /**
   * Pipe a message into the live container via IPC. Returns `true` if the
   * pipe accepted it, `false` if the container can't take it (state is
   * `closing`, auth-error fence is up, or the underlying write failed).
   *
   * This is the only message-delivery surface on the runner. The
   * Conversation owns queueing — on `false`, it falls back to mailbox + a
   * fresh spawn cycle via `handleRunnerDiedInline`.
   *
   * `kind` selects the framework tag the body is wrapped in before delivery —
   * `'participant'` (default) is no-wrap; others wrap as
   * `<cast:kind>...</cast:kind>` so the agent's prompt can recognize machine
   * stimulus.
   */
  /**
   * Record one inbound message in the agent message log. The single write site
   * shared by both delivery paths — the warm `pipeMessage` (on successful pipe)
   * and the cold `spawn` (which drains the spawn prompt straight to the
   * container, bypassing `pipeMessage`). Without the spawn-side call the first
   * message of every conversation would never reach `message_log`.
   *
   * Participant input is already sanitized upstream (`formatParticipantMessage`
   * strips the framework family at the ingest boundary), so the log records
   * exactly what the agent received; `rawText` (when supplied) is that sanitized
   * pre-envelope body. Framework-emitted kinds keep the `<cast:${kind}>` wrapper
   * (the provenance signal telling scheduled/watch/service/etc. apart from
   * spontaneous self-talk) and log under sender `system` — so denial corrections
   * and other framework stimuli stay attributable (`WHERE sender = 'system'`)
   * instead of masquerading as the user's own words.
   */
  private logInboundMessage(
    text: string,
    kind: DeliverKind,
    opts?: { rawText?: string; attrs?: Record<string, string>; attachments?: Attachment[] },
  ): void {
    if (!this.messageLog) return;
    const logText = kind === 'participant'
      ? (opts?.rawText ?? text)
      : wrapForKind(text, kind, opts?.attrs);
    const attachmentsMeta: AttachmentMeta[] | undefined = opts?.attachments?.map((a) => ({
      label: a.filename, hash: a.hash!, mimeType: a.mimeType, size: a.filesize ?? 0,
    }));
    this.messageLog.logInbound(
      this.participantAddress,
      kind === 'participant' ? this.participantAddress : 'system',
      logText, this.channelName, this.conversationKey,
      attachmentsMeta,
    );
  }

  pipeMessage(
    text: string,
    attachments?: Attachment[],
    opts?: {
      kind?: DeliverKind;
      attrs?: Record<string, string>;
      rawText?: string;
    },
  ): boolean {
    const kind = opts?.kind ?? 'participant';
    // Expired conversations drop all inbound except the cleanup stimulus
    // itself — Conversation.expire pipes the `<cast:lifecycle>` body through
    // this same surface after flipping its phase to 'expiring', and that pipe
    // must succeed. Everything else (participant, schedule, service, watch,
    // push) drops, preserving the invariant that no fresh work begins
    // mid-cleanup.
    if (this.isExpired && kind !== 'lifecycle') {
      logger.debug({ conversationKey: this.conversationKey }, 'Dropping message to expired conversation');
      return false;
    }

    const wrapped = wrapForKind(text, kind, opts?.attrs);

    if (this._state !== 'running' || this.authErrorSeen) return false;
    // Cleanup turn: keep the warm session, but switch the live query to the
    // cleanup-phase model (resolved the same way the cold spawn path resolves
    // it) and tag the turn so the runner attributes its usage to `cleanup`.
    // resolveModel falls back to the main model when no cleanup override
    // exists, in which case the runner's setModel is a no-op.
    const wireKind = kind === 'lifecycle' ? kind : undefined;
    const cleanupModel = kind === 'lifecycle'
      ? resolveModel(readAgentConfig(this.host.folder), { channelName: this.channelName, phase: 'cleanup' })
      : undefined;
    if (!this.sendViaIpc(wrapped, attachments, { kind: wireKind, model: cleanupModel })) return false;

    // Record inbound AFTER a successful pipe (not before the fail returns above),
    // so a message that fails to pipe and gets re-queued isn't double-logged when
    // the respawn's cold path (`spawn`) records it instead. See logInboundMessage.
    this.logInboundMessage(text, kind, { rawText: opts?.rawText, attrs: opts?.attrs, attachments });

    logger.info(
      { conversationKey: this.conversationKey, address: this.address },
      'Piped message to active container',
    );
    this.resetIdleTimer();
    if (this.lastHooks) this.emitTyping(this.lastHooks, true);
    return true;
  }

  /**
   * Spawn a container for this conversation.
   *
   * The Conversation passes the spawn prompt explicitly — the runner does not
   * own a persistent message queue. Reentrance is gated upstream by the
   * Conversation's `runSpawnCycle`; we just refuse if `closing`.
   *
   * Pure execution — all side effects (persistence, routing, registry cleanup)
   * are delegated to the caller via hooks and the return value.
   */
  async spawn(prompt: PendingMessage[], rawHooks: SpawnHooks): Promise<SpawnOutcome> {
    if (this._state === 'closing') {
      logger.warn({ conversationKey: this.conversationKey }, 'spawn() called on closing runner');
      this.logEvent?.('warn', 'conversation', 'spawn_race', 'spawn() called on closing runner', {
        conversationKey: this.conversationKey,
        context: { state: this._state },
      });
      return { type: 'settled', result: null, outputSent: false };
    }

    // Pre-spawn short-circuit: if Claude isn't configured, don't try to spawn
    // a container that would fail at `refreshSecrets`. Emit the typed fallback
    // directly and return an auth-error outcome with `not-configured` reason
    // (Conversation skips retry and surfaces the fallback to the user).
    if (getResolvedAuth() === null) {
      logger.warn({ conversationKey: this.conversationKey }, 'spawn() short-circuited: Claude not configured');
      this.logEvent?.('warn', 'auth', 'not_configured', 'Spawn refused — Claude not configured', {
        conversationKey: this.conversationKey,
      });
      const gatedHooks = gateUserHooks(rawHooks, () => this.isExpired);
      this.lastHooks = gatedHooks;
      await this.emitFallback('not-configured', this._ccSessionId);
      return { type: 'auth-error', outputSent: true, reason: 'not-configured' };
    }

    // Wrap hooks at the boundary — `gateUserHooks` is the single chokepoint
    // enforcing "no user emission during the cleanup turn." All later
    // references to `hooks` in this method (including `this.lastHooks`)
    // hold the gated version; the raw reference is unreachable past this
    // line. See `gateUserHooks` JSDoc.
    const hooks = gateUserHooks(rawHooks, () => this.isExpired);

    this.setState('running');
    this.lastHooks = hooks;
    this.authErrorSeen = false;

    // Drain prompt parameter — Conversation owns the canonical mailbox.
    // Per-message kind wrapping mirrors the live-pipe path: a cleanup message
    // that landed in the mailbox (idle-no-runner or awaiting-slot TTL fire)
    // carries `kind: 'lifecycle'` and must reach the container wrapped in
    // `<cast:lifecycle>` so the system prompt can recognize it.
    const promptText = prompt.map((m) => wrapForKind(m.text, m.kind, m.attrs)).join('\n\n');
    const allAttachments = prompt.flatMap((m) => m.attachments ?? []);

    // Record each drained message inbound. The cold path delivers the spawn
    // prompt straight to the container without ever calling pipeMessage, so
    // without this the conversation's opening message (and any that queued while
    // idle-no-runner) would never reach message_log. Warm messages log via
    // pipeMessage instead; a crash-replay re-delivers piped messages through
    // here and logs them again — faithful to the delivery, and duplicate-on-
    // replay is a tolerated soft failure (see Conversation.requeuePipedOnAbnormalEnd).
    for (const m of prompt) {
      this.logInboundMessage(m.text, m.kind ?? 'participant', {
        rawText: m.rawText, attrs: m.attrs, attachments: m.attachments,
      });
    }

    const host = this.host;
    const singleShot = this.isSingleShot;

    const isNew = this.isNewConversation && !this._bootstrapped;

    const ctx: SpawnContext = {
      hooks,
      singleShot,
      sessionId: this._ccSessionId,
      participant: this.participantAddress,
      hadError: false,
      outputSentToUser: false,
      sessionNotified: false,
      firstResult: null,
      firstError: null,
      firstErrorCause: undefined,
      authErrorDetected: false,
      authErrorReason: undefined,
      sdkResultSeen: false,
    };

    try {
      const sessionId = ctx.sessionId;

      // Build container input — bootstrap goes as a separate field (not prepended to prompt).
      // Single-shot honors bootstrapEnabled the same as persistent channels; the existing
      // bootstrap prompt branches on `<previous-session first-time="true" />` (always true
      // for single-shot since completedSessions is empty for keys that never persisted) and
      // gracefully degrades to topology-only.
      const bootstrap = isNew && this.channel.bootstrapEnabled
        ? this.channel.bootstrap
        : undefined;

      const participant = ctx.participant;

      // Per-conversation MCP socket — created before container so agent-runner finds it at startup.
      // Skip the await when no MCP path applies — `setupConversationMcp` yields a microtask
      // even on the no-op path, and tests rely on `runContainerAgent` being called
      // synchronously off `route()` when neither console nor mcpDeps is wired.
      const convMcp = (this.consoleName || this.mcpDeps)
        ? await this.setupConversationMcp()
        : undefined;

      // Build MCP TCP port map (TCP mode only; ports are undefined in socket mode)
      const mcpPorts = convMcp?.port !== undefined
        ? { cast: convMcp.port, ...this.agentMcpPorts }
        : this.agentMcpPorts;

      // Typing + lifecycle emissions — cleanup-phase suppression is
      // enforced by the `gateUserHooks` proxy wrapping `hooks`, so call
      // sites are unconditional. See `gateUserHooks` JSDoc.
      this.emitTyping(hooks, true);

      // `sessionId === undefined` means the SDK starts without `--resume`,
      // so the LLM has no prior context. Fire a one-shot lifecycle event
      // before spawn so currently-connected transports can record the
      // boundary in their UI. Not queued — disconnected clients miss it
      // by design (reconnecting would have to re-derive state anyway).
      if (sessionId === undefined) {
        hooks.onLifecycle?.('fresh_conversation', false);
      }

      logger.info(
        { conversationKey: this.conversationKey, address: this.address, isNew, singleShot },
        'Spawning container for conversation',
      );
      this.logEvent?.('info', 'conversation', 'started', 'Conversation spawn begins', {
        conversationKey: this.conversationKey,
        context: { address: this.address, isNew, singleShot },
      });
      const containerAttachments = toContainerAttachments(allAttachments);

      // Merge the unconditional built-in disallow list, plus WebFetch except on
      // full-network spawns (see applyBuiltinToolPolicy).
      const disabledTools = applyBuiltinToolPolicy(this.disabledTools, this.containerNetwork);

      const output = await runContainerAgent(
        host,
        {
          prompt: promptText,
          sessionId,
          bootstrap,
          systemPrompt: this.systemPrompt,
          disabledTools,
          conversationKey: this.conversationKey,
          agentFolder: host.folder,
          address: this.address,
          attachments: containerAttachments,
          mcpPorts,
          mcpSocketPath: convMcp?.socketPath,
          overrideMounts: this.overrideMounts,
          workdir: this.workdir,
          containerNetwork: this.containerNetwork,
          channelName: this.channelName,
          participant: this.participant,
          phase: this.isExpired ? 'cleanup' : undefined,
        },
        (proc, containerName) => {
          this.process = proc;
          this.containerName = containerName;
        },
        (output: ContainerOutput) => this.handleContainerOutput(ctx, output),
        // Activity callback: re-emit typing on SDK activity (debounced).
        // Cleanup-phase suppression is enforced inside `emitTyping` via the
        // gated `hooks.onTyping`; no inline guard needed.
        () => this.emitTypingDebounced(hooks),
        this.logEvent,
        // Host-initiated-stop probe: lets the container-runner's close
        // handler distinguish our own SIGTERMs (via destroy()/close()) from
        // external runtime kills, so it can tag the settle with the right
        // cause. Both transitions go through `setState('closing')`.
        () => this._state === 'closing',
      );

      // Update runner's session ID from final output
      const finalSessionId = (output.type === 'message' || output.type === 'error') ? output.newSessionId : undefined;
      if (finalSessionId) {
        this._ccSessionId = finalSessionId;
      }

      // Notify caller — only if streaming callback didn't already handle it.
      // Cleanup-phase suppression is enforced by the gated `hooks.onSessionId`.
      if (!ctx.sessionNotified && !singleShot && finalSessionId) {
        hooks.onSessionId(finalSessionId);
      }

      if (output.type === 'error' || ctx.hadError) {
        if (ctx.firstError === null) ctx.firstError = (output.type === 'error' ? output.error : null) || 'Unknown error';
        if (ctx.firstErrorCause === undefined && output.type === 'error' && output.cause) ctx.firstErrorCause = output.cause;
        if (!ctx.outputSentToUser) {
          logger.warn({ conversationKey: this.conversationKey }, 'Agent error with no output sent');
          this.logEvent?.('warn', 'conversation', 'error_no_output', 'Container exited error but no output sent to user', {
            conversationKey: this.conversationKey,
            context: { firstError: ctx.firstError },
          });
        }
      }

      // Auth-error replay is now Conversation-side. Conversation
      // tracks piped messages in `pipedThisSpawn` and re-queues them to its
      // mailbox on abnormal end; the runner no longer carries a parallel
      // replay buffer.
    } catch (err) {
      const msg = errorMessage(err);
      logger.error({ conversationKey: this.conversationKey, err }, 'Agent error');
      this.logEvent?.('error', 'conversation', 'spawn_error', `Unhandled exception in spawn(): ${msg}`, {
        conversationKey: this.conversationKey,
        context: { error: msg },
      });
      ctx.firstError = msg;
    } finally {
      // Transition: new → active after first spawn completes
      this._bootstrapped = true;

      // Stop typing
      this.emitTyping(hooks, false);
      this.clearIdleTimer();

      // Surface spawn errors as a fallback agent message so the operator
      // sees a breadcrumb instead of dead air when the container exits
      // before producing output. Guard mirrors the validation-halt path:
      // skip if output already went out (don't double-message after a
      // partial response) or during an auth-error retry (the re-queue path
      // will produce real output on the next spawn). `sdkResultSeen`
      // suppresses the false positive where the SDK finished cleanly with
      // empty text and the container exited non-zero on the way out
      // (e.g. SIGKILL from idle-shutdown race).
      //
      // Cleanup-phase suppression is enforced by `gateUserHooks` —
      // emitFallback's `hooks.onOutput` is gated, so a fallback fired
      // during cleanup is silently dropped at the proxy.
      if (
        ctx.firstError !== null
        && !ctx.outputSentToUser
        && !ctx.authErrorDetected
        && !ctx.sdkResultSeen
      ) {
        const fallbackReason: FallbackReason = ctx.firstErrorCause === 'external_kill'
          ? 'external_kill'
          : 'container_error';
        await this.emitFallback(fallbackReason, ctx.sessionId);
        ctx.outputSentToUser = true;
      }

      // Close per-conversation MCP socket. Console closer is async (awaits
      // real teardown before returning); normal closer is sync. Always await.
      if (this.mcpCloser) {
        await this.mcpCloser.close();
        this.mcpCloser = null;
      }

      // Container has exited. Two cases:
      // - closing (destroy/close): state is 'closing'. Conversation already
      //   knows to drop us. No-op.
      // - running: runner is dropped by its owning Conversation when it sees
      //   the spawn return. We don't drive respawn from here — Conversation
      //   re-drains from mailbox if there's work.
      this.process = null;
      this.containerName = null;
    }

    if (ctx.authErrorDetected) {
      return { type: 'auth-error', outputSent: ctx.outputSentToUser, reason: ctx.authErrorReason };
    }
    if (ctx.firstError !== null) {
      return {
        type: 'terminal-error',
        error: ctx.firstError,
        outputSent: ctx.outputSentToUser,
      };
    }
    return {
      type: 'settled',
      result: ctx.firstResult,
      outputSent: ctx.outputSentToUser,
    };
  }

  /**
   * Send a `{type:'close'}` hint over stdin asking the container to exit
   * after its current turn. **This is a request, not a guarantee** — the
   * container is free to ignore it or stall; nothing here waits for the
   * process to actually exit. Conversation-side teardown calls
   * `destroy(mode)` (which optionally drains with a bounded await + SIGTERM
   * fallback) instead — `close()` exists only for internal callers that
   * need to signal close without owning teardown (single-shot finalization
   * inside the runner). The prior `_teardown(graceful: true)`
   * path called `close()` then immediately `destroy()` with no await,
   * making the "graceful" label inaccurate; now folded into
   * `destroy({kind:'drain'})`.
   */
  close(): void {
    if (this._state === 'closing') return;
    this.setState('closing');

    if (this.process) {
      writeToAgent(this.process, { type: 'close' });
      logger.info({ conversationKey: this.conversationKey }, 'Close message sent via stdin');
    }
  }

  /**
   * Notify the Conversation that the agent-runner emitted `lifecycle/idle`.
   * The runner's own state stays `'running'` — the "between turns"
   * notion is Conversation-side (`idle-with-runner`). We just fire the hook.
   *
   * Single-shot and expired paths skip — their containers exit instead of
   * entering inter-turn rest.
   */
  markIdle(): void {
    if (this.isExpired || this.isSingleShot) return;
    if (this._state === 'running') {
      this.onIdle?.();
    }
  }

  /**
   * The single write site for `_state`. Mirrors `Conversation.setState`.
   * Self-transitions short-circuit; the union is
   * monotone-forward (`running → closing` is the only legal edge).
   */
  private setState(target: ContainerState): void {
    if (this._state === target) return;
    if (this._state === 'closing') {
      logger.error(
        { conversationKey: this.conversationKey, target },
        'ConversationRunner.setState: refused — runner is closing',
      );
      return;
    }
    this._state = target;
  }

  /**
   * Tear down the live process and MCP socket.
   *
   * The quiesce rule lives at the Conversation layer — destroy is
   * only called when Conversation state is `'idle-with-runner'`
   * (see `Conversation.yieldSlot`). The runner just enforces idempotence
   * here: if already `'closing'`, no-op.
   *
   * Preserved on the runner object: `ccSessionId`, routing context.
   * Torn down: child process, MCP socket, runner-local `idleTimer`.
   * The caller (`Conversation`) releases the slot and drops the runner
   * reference; this method only owns the process + socket teardown plus
   * the atomic state claim.
   *
   * Atomic claim: `setState('closing')` runs synchronously before any
   * `await` so a concurrent destroy() re-passing the idempotence check
   * is impossible.
   *
   * Returns `true` if the destroy actually happened, `false` if a prior
   * `close()` or `destroy()` already moved us to `'closing'`.
   */
  async destroy(mode: TeardownMode): Promise<boolean> {
    if (this._state === 'closing') {
      logger.warn(
        { conversationKey: this.conversationKey },
        'destroy() refused: runner already closing',
      );
      return false;
    }
    this.setState('closing');

    this.clearIdleTimer();

    if (this.process) {
      try {
        if (mode.kind === 'drain') {
          // Write the close hint, then wait — bounded — for the SDK to
          // exit. Drains in-flight turns whose post-turn work (session
          // JSONL flush, MCP socket close) would otherwise be truncated
          // by an immediate SIGTERM. Falls back to SIGTERM if the close
          // isn't honored in time so a hung/stuck runner can't block
          // teardown indefinitely.
          writeToAgent(this.process, { type: 'close' });
          const exited = await waitForExit(this.process, mode.timeoutMs);
          if (!exited) {
            logger.warn(
              { conversationKey: this.conversationKey, timeoutMs: mode.timeoutMs },
              'destroy(): drain timeout exceeded, falling back to SIGTERM',
            );
            this.process.kill('SIGTERM');
          }
        } else {
          this.process.kill('SIGTERM');
        }
      } catch (err) {
        logger.warn(
          { conversationKey: this.conversationKey, err },
          'destroy(): process termination failed',
        );
      }
      this.process = null;
      this.containerName = null;
    }

    if (this.mcpCloser) {
      try {
        await this.mcpCloser.close();
      } catch (err) {
        logger.warn({ conversationKey: this.conversationKey, err }, 'mcpCloser.close() failed during destroy');
      }
      this.mcpCloser = null;
    }

    logger.info({ conversationKey: this.conversationKey }, 'Conversation runner destroyed');
    this.logEvent?.(
      'info',
      'conversation',
      'paged_out',
      `Paged out idle runner ${this.conversationKey}`,
      { conversationKey: this.conversationKey },
    );
    return true;
  }

  /**
   * Send a single generic user-facing fallback message into the conversation.
   *
   * Used by:
   *   - the spawn `finally` block when the container errored before delivering
   *     any user-visible text (`reason: 'container_error'`)
   *   - `emitAuthExhausted`, in turn called by `Conversation.runSpawnCycle`
   *     when auth retries exhaust (`reason: 'auth_exhausted'`)
   *
   * The reason discriminator drives event-log telemetry only; the chat copy is
   * the same so users don't see technical detail they can't act on.
   *
   * Uses `this.lastHooks` (the gated reference captured at spawn entry) — see
   * `gateUserHooks`. No-op before the first spawn or after a clean teardown.
   * All runner fields touched here (`address`, `channelName`, `conversationKey`,
   * `participantAddress`) are set in the constructor and never torn down, so
   * this is safe to call after `spawn()` returns.
   */
  async emitFallback(
    reason: FallbackReason,
    sessionId?: string,
  ): Promise<void> {
    if (this.lastHooks === null) return;
    // No inline cleanup gate — `lastHooks.onOutput` is gated by `gateUserHooks`
    // (see proxy JSDoc). During cleanup the packet creation here is wasted
    // work but the user emission is structurally suppressed.
    const text = formatFallbackMessage(reason);
    const sh = sessionId ? hashConversationKey(sessionId) : undefined;
    const pkt = conversationPkt(this.address, this.participantAddress, text, sh, undefined, undefined);
    await this.lastHooks.onOutput(pkt, this.channelName, this.conversationKey);
  }

  /** Runner-interface implementation: Conversation calls this on auth-retry
   *  exhaustion. Delegates to `emitFallback('auth_exhausted', ...)` with the
   *  runner's tracked session id — keeps Conversation runner-implementation-
   *  agnostic (no need to thread session ids back out).
   *
   *  Both this and `emitFallback` use `this.lastHooks` (the gated hooks
   *  captured at spawn entry) — see `gateUserHooks`. The user-facing
   *  fallback message is therefore automatically suppressed if exhaustion
   *  fires during the cleanup turn. */
  async emitAuthExhausted(): Promise<void> {
    await this.emitFallback('auth_exhausted', this._ccSessionId);
  }

  /**
   * Start the per-conversation MCP socket. Console channels get a console-
   * specific tool set; normal conversations get the full set. Returns the
   * port number, or undefined when neither path applies (no console + no
   * mcpDeps wired).
   */
  private async setupConversationMcp(): Promise<{ port?: number; socketPath: string } | undefined> {
    // One nonce per spawn → a socket path this server instance solely owns, so a
    // superseded runner's close() unlinks only its own path, never this live
    // socket. The host path is threaded into the container mount; the container
    // always sees the fixed `/mcp/cast.sock`.
    const socketPath = sessionCastSocketPath(this.agentFolder, this.conversationKey, randomBytes(3).toString('hex'));
    if (this.consoleName) {
      const mcp = startConsoleMcpServer(socketPath, {
        hostFolder: this.agentFolder,
        agentId: this.address,
        participant: this.replyTo ?? this.participant ?? null,
        channelName: this.channelName,
        consoleName: this.consoleName,
        messageLog: this.messageLog,
        timezone: this.timezone,
        disabledTools: this.disabledTools,
        getConversationKey: () => this.conversationKey,
      }, this.consoleDeps ?? {});
      this.mcpCloser = mcp;
      await mcp.ready;
      return { port: mcp.port, socketPath };
    }
    if (this.mcpDeps) {
      const mcp = startMcpSocketServer(socketPath, {
        agentFolder: this.agentFolder,
        agentId: this.address,
        host: this.host,
        participant: this.replyTo ?? this.participant ?? null,
        channelName: this.channelName,
        callerQualifier: this.qualifier,
        channel: this.channel,
        store: this.store,
        agentDb: this.agentDb,
        messageLog: this.messageLog,
        disabledTools: this.disabledTools,
        activeExtensions: this.activeExtensions,
        getConversationKey: () => this.conversationKey,
        timezone: this.timezone,
        pipConfig: this.pipConfig,
      }, this.mcpDeps);
      this.mcpCloser = mcp;
      await mcp.ready;
      return { port: mcp.port, socketPath };
    }
    return undefined;
  }


  // =========================================================================
  // Container output handling
  // =========================================================================

  private async handleContainerOutput(ctx: SpawnContext, output: ContainerOutput): Promise<void> {
    switch (output.type) {
      case 'auth_error':
        ctx.authErrorDetected = true;
        ctx.authErrorReason = output.reason;
        this.authErrorSeen = true;
        logger.warn({ conversationKey: this.conversationKey, reason: output.reason }, 'Claude-unreachable error detected');
        ctx.hooks.onLifecycle?.('auth_refresh', true, {});
        return;

      case 'error':
        ctx.hadError = true;
        if (ctx.firstError === null) ctx.firstError = output.error;
        if (output.newSessionId) this._ccSessionId = output.newSessionId;
        return;

      case 'lifecycle':
        // `idle` is an internal swap-trigger signal — runner is between turns,
        // container alive, slot held. Not surfaced to transports.
        if (output.phase === 'idle') {
          this.markIdle();
          return;
        }
        ctx.hooks.onLifecycle?.(output.phase, output.active, {
          preTokens: output.preTokens, trigger: output.trigger,
        });
        return;

      case 'preview': {
        if (output.kind !== 'text') return;
        if (!this.showSteps) return;
        if (this.participantAddress === this.address) return;
        const pkt = previewTextPkt(
          this.address,
          this.participantAddress,
          output.text,
          output.streamId,
          this.channelName,
        );
        ctx.hooks.onPreview?.(pkt, this.channelName, this.conversationKey);
        return;
      }

      case 'usage': {
        this.agentDb?.tokens.record({
          conversationId: this.conversationKey,
          channel: this.channelName,
          phase: output.phase,
          model: output.model,
          usage: {
            input: output.input_tokens,
            output: output.output_tokens,
            cacheCreation: output.cache_creation_input_tokens,
            cacheRead: output.cache_read_input_tokens,
          },
          costUsd: output.cost_usd,
          ts: new Date(),
        });
        return;
      }

      case 'message': {
        const isIntermediate = !!output.intermediate;

        logger.debug(
          { conversationKey: this.conversationKey, hasResult: !!output.result, hasSession: !!output.newSessionId, isIntermediate, subtype: output.subtype },
          'Container output received',
        );

        // Mark that the SDK reached a successful result event. Empty success
        // (no text to deliver) and successful-with-text both flip this — the
        // distinction the fallback guard needs is "did the SDK finish cleanly"
        // versus "did the container die before/instead of finishing."
        if (output.subtype === 'success') ctx.sdkResultSeen = true;

        // `showSteps` is a pure UX flag (display only) and is
        // applied later in `deliverValidatedOutput`. Validation and
        // cast:query/cast:answer dispatch must run on intermediate output too
        // — otherwise tags emitted in pre-tool-call text are silently dropped.
        if (output.newSessionId) this._ccSessionId = output.newSessionId;

        if (!ctx.singleShot && output.newSessionId && !ctx.sessionNotified) {
          ctx.hooks.onSessionId(output.newSessionId);
          ctx.sessionNotified = true;
        }

        this.resetIdleTimer();

        if (output.result) {
          const validation = validateAgentOutput(output.result, this.maxOutputBytes);
          logger.info({ conversationKey: this.conversationKey, text: output.result.slice(0, 80) }, 'Agent output');

          if (!validation.ok) {
            if (output.streamId) this.emitPreviewTerminator(ctx, output.streamId);
            await this.handleValidationFailure(
              validation.reasons,
              output.result,
              isIntermediate,
              output.newSessionId,
              ctx,
            );
            break;
          }

          this.validationFailureCount = 0;
          await this.deliverValidatedOutput(
            validation.parsed,
            isIntermediate,
            output.newSessionId,
            ctx,
            output.streamId,
          );
        } else if (!isIntermediate && this.isExpired) {
          // Cleanup turn produced no output — deliverValidatedOutput is the only
          // path that calls close() after a final, so drain the container directly
          // to prevent a stuck-runner (container would otherwise loop back to await
          // stdin per agent-runner/src/index.ts:798-800 and never exit).
          this.close();
        }
        break;
      }
    }
  }

  /**
   * Handle a failed `validateAgentOutput` result. Intermediate failures are
   * silently blackholed (the same model emits the final, where feedback lands).
   * Final failures increment a per-runner counter, deliver `systemFormatError`
   * for self-correction, and close the runner with a user-facing message after
   * `MAX_VALIDATION_FAILURES` consecutive misses.
   */
  private async handleValidationFailure(
    reasons: string[],
    rawOutput: string,
    isIntermediate: boolean,
    newSessionId: string | undefined,
    ctx: SpawnContext,
  ): Promise<void> {
    if (isIntermediate) {
      logger.warn(
        { conversationKey: this.conversationKey, reasons, size: rawOutput.length },
        'Intermediate output blackholed (validation failed)',
      );
      this.logEvent?.(
        'warn',
        'agent',
        'invalid_intermediate',
        'Intermediate output failed validation',
        { conversationKey: this.conversationKey, context: { reasons, size: rawOutput.length } },
      );
      return;
    }

    this.validationFailureCount++;
    logger.error(
      { conversationKey: this.conversationKey, reasons, size: rawOutput.length, retry: this.validationFailureCount },
      'Final output blackholed (validation failed)',
    );
    this.logEvent?.(
      'error',
      'agent',
      'invalid_final',
      'Final output failed validation',
      { conversationKey: this.conversationKey, context: { reasons, size: rawOutput.length, retry: this.validationFailureCount } },
    );

    if (this.validationFailureCount >= MAX_VALIDATION_FAILURES) {
      const stuckText = `The agent had trouble producing a valid response after ${MAX_VALIDATION_FAILURES} attempts and stopped. Please send your message again — this usually resolves on retry.`;
      // No inline cleanup gate — `ctx.hooks.onOutput` is gated by
      // `gateUserHooks`. Packet building during cleanup is wasted work
      // but emission is structurally suppressed.
      const rawSessionId = newSessionId || ctx.sessionId;
      const sh = rawSessionId ? hashConversationKey(rawSessionId) : undefined;
      const stuckPkt = conversationPkt(this.address, ctx.participant, stuckText, sh, undefined, undefined);
      await ctx.hooks.onOutput(stuckPkt, this.channelName, this.conversationKey);
      this.logEvent?.(
        'error',
        'agent',
        'validation_halt',
        'Closed runner after repeated validation failures',
        { conversationKey: this.conversationKey, context: { reasons, retryCount: this.validationFailureCount } },
      );
      this.close();
      return;
    }

    this.pipeMessage(
      systemFormatError(reasons, rawOutput, this.timezone),
      undefined,
      { kind: 'system' },
    );
  }

  /**
   * Route a validated `ParsedOutput`: dispatch query/answer tags, emit the
   * user-visible text packet, log the outbound, and close the runner if this
   * is a single-shot or expired conversation.
   */
  private async deliverValidatedOutput(
    parsed: ParsedOutput,
    isIntermediate: boolean,
    newSessionId: string | undefined,
    ctx: SpawnContext,
    /** When set, this seal terminates preview stream `streamId`. */
    streamId?: string,
  ): Promise<void> {
    const { text, internal, queries, answers } = parsed;

    // Cast tag side-effects fire regardless of intermediate/final, so a query
    // or answer emitted in pre-tool-call text still routes. The
    // `showSteps` flag is display-only and gates the user-visible
    // emit below — never the dispatch.
    for (const q of queries) {
      await ctx.hooks.onRequest?.(q.kind, q.target, q.channel, q.text, q.qualifier);
    }
    for (const a of answers) {
      await ctx.hooks.onResponse?.(a.requestId, a.text);
    }
    const outAttachments = (!isIntermediate && text) ? this.harvestOutbox() : undefined;
    const showToUser = !isIntermediate || this.showSteps;

    if (text && showToUser) {
      // No inline cleanup gate — `emitTyping` and `ctx.hooks.onOutput`
      // are both gated by `gateUserHooks`. Packet building during cleanup
      // is wasted work but emission is structurally suppressed.
      this.emitTyping(ctx.hooks, false);
      const rawSessionId = newSessionId || ctx.sessionId;
      const sh = rawSessionId ? hashConversationKey(rawSessionId) : undefined;
      const outPkt = conversationPkt(this.address, ctx.participant, text, sh, undefined, outAttachments, undefined, streamId);
      await ctx.hooks.onOutput(outPkt, this.channelName, this.conversationKey);
      if (!isIntermediate) {
        ctx.outputSentToUser = true;
        this.authRetryCount = 0;
      }
      if (ctx.firstResult === null && !isIntermediate) ctx.firstResult = text;
    } else if (streamId) {
      // No durable seal will follow — empty body, or intermediate output the
      // user shouldn't see. Tell the consumer to drop the in-flight bubble.
      this.emitPreviewTerminator(ctx, streamId);
    }

    if (!isIntermediate) {
      const outMeta: AttachmentMeta[] | undefined = outAttachments?.map((a) => ({
        label: a.filename, hash: a.hash!, mimeType: a.mimeType, size: a.filesize ?? 0,
      }));
      this.messageLog?.logOutbound(
        ctx.participant, ctx.participant, text, this.channelName, this.conversationKey, internal, outMeta,
      );
    }

    if (!isIntermediate) {
      // Three-way close branch over (isExpired, singleShot, cleanupEnabled):
      //   - already expired (e.g. cleanup turn just finished, or a console/manual expire
      //     fired mid-spawn): close.
      //   - single-shot first pass with cleanup enabled: signal Conversation to begin
      //     cleanup. Conversation flips phase to 'expiring' synchronously and pipes
      //     the cleanup body wrapped as `<cast:lifecycle>` through the same
      //     `pipeMessage` surface used by TTL fire — single entry point for both
      //     paths. The next pass through this branch sees isExpired=true and closes.
      //   - single-shot first pass without cleanup: close immediately (today's behavior).
      if (this.isExpired) {
        this.close();
      } else if (ctx.singleShot) {
        if (this.channel.cleanupEnabled && this.channel.cleanup) {
          this.requestCleanupFn(this.channel.cleanup);
        } else {
          this.close();
        }
      }
    }
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * The participant address for outbound routing and message-log writes.
   * Uses replyTo (delegation target) if set.
   *
   * Structurally-valid-by-construction: `buildRunnerOpts` feeds this exact
   * expression (`replyTo || participant`, agent-manager.ts) through the
   * `isParticipantAddress` guard in prompt assembly BEFORE any Runner is
   * constructed — a runner only exists if the guard passed. So this value is
   * always a bare participant (user identity / agent / operator surface),
   * never a compound or raw wire; downstream writers trust it without
   * re-validating (validate at the edge, trust inside). Keep the expression
   * in lockstep with the guard input — divergence reopens the gap.
   */
  private get participantAddress(): string {
    const addr = this.replyTo || this.participant;
    if (!addr) {
      throw new Error(`No participant for conversation ${this.conversationKey}`);
    }
    return addr;
  }

  private sendViaIpc(
    text: string,
    attachments?: Attachment[],
    opts?: { kind?: string; model?: string },
  ): boolean {
    if (!this.process) return false;
    const containerAtts = attachments?.length ? toContainerAttachments(attachments) : undefined;
    return writeToAgent(this.process, {
      type: 'message',
      text,
      ...(containerAtts ? { attachments: containerAtts } : {}),
      ...(opts?.kind ? { kind: opts.kind } : {}),
      ...(opts?.model ? { model: opts.model } : {}),
    });
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      logger.debug({ conversationKey: this.conversationKey }, 'Idle timeout, closing container');
      this.close();
    }, IDLE_TIMEOUT);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private emitTyping(hooks: SpawnHooks, typing: boolean): void {
    if (typing) this.lastTypingEmit = Date.now();
    hooks.onTyping({
      from: this.address,
      to: this.participantAddress,
      type: typing ? 'typing' : 'typing_stopped',
      data: { channel: this.channelName },
    });
  }

  /** Emit a `final: true` preview frame so the consumer drops the in-flight
   *  bubble for `streamId`. Used on paths where previews were emitted but no
   *  durable seal will follow — validation failure on streamed output, or a
   *  final result with empty/hidden text. Without this, the client preview
   *  cache keeps the entry forever and the cursor blinks indefinitely. */
  private emitPreviewTerminator(ctx: SpawnContext, streamId: string): void {
    if (this.participantAddress === this.address) return;
    if (!this.showSteps) return;
    const pkt = previewTextPkt(
      this.address,
      this.participantAddress,
      '',
      streamId,
      this.channelName,
      true,
    );
    ctx.hooks.onPreview?.(pkt, this.channelName, this.conversationKey);
  }

  /** Activity-driven typing: re-emit if last emit was >4s ago.
   *
   *  Cleanup-phase suppression is enforced by `gateUserHooks` — `emitTyping`
   *  calls `hooks.onTyping`, which the proxy drops while expiring. The
   *  debounce timer may still fire during cleanup (slight CPU waste) but
   *  no user emission occurs. */
  private emitTypingDebounced(hooks: SpawnHooks): void {
    const now = Date.now();
    if (now - this.lastTypingEmit >= 4000) {
      this.emitTyping(hooks, true);
    }
  }

  /**
   * Harvest outbound attachments from /staging/out/.
   * Persists each file to the content-addressed store, then clears out/.
   */
  private harvestOutbox(): Attachment[] | undefined {
    const outDir = pathMod.join(
      agentPath(this.agentFolder, 'staging'),
      conversationKeyToPath(this.conversationKey),
      'out',
    );
    try {
      const files = fs.readdirSync(outDir);
      logger.debug({ conversationKey: this.conversationKey, outDir, fileCount: files.length }, 'Harvesting outbox');
      if (files.length === 0) return undefined;

      const resolvedOut = pathMod.resolve(outDir);
      const attachments: Attachment[] = [];
      for (const file of files) {
        try {
          const filePath = pathMod.resolve(pathMod.join(outDir, file));
          if (!filePath.startsWith(resolvedOut + pathMod.sep)) continue; // path escape attempt
          const lstat = fs.lstatSync(filePath);
          if (!lstat.isFile()) continue; // rejects symlinks, directories, etc.
          if (lstat.size > MAX_ATTACHMENT_BYTES) {
            logger.warn({ conversationKey: this.conversationKey, file, size: lstat.size }, 'Outbox file too large — skipping');
            this.logEvent?.('warn', 'conversation', 'attachment_too_large', `Outbox attachment exceeds limit: ${file}`, {
              conversationKey: this.conversationKey,
              context: { file, size: lstat.size, limit: MAX_ATTACHMENT_BYTES },
            });
            continue;
          }
          const mimeType = mimeFromExt(pathMod.extname(file));
          const persisted = persistAttachmentFromFile(this.agentFolder, filePath, mimeType);
          attachments.push({
            filename: file,
            mimeType,
            hostPath: persisted.hostPath,
            filesize: lstat.size,
            hash: persisted.hash,
          });
        } catch (err) {
          logger.warn({ conversationKey: this.conversationKey, file, err }, 'Failed to persist outbox attachment, skipping');
          this.logEvent?.('warn', 'conversation', 'attachment_persist_failed', `Outbox attachment persist failed: ${file}`, {
            conversationKey: this.conversationKey,
            context: { file, error: String(err) },
          });
        }
      }

      logger.info(
        { conversationKey: this.conversationKey, count: attachments.length, files: attachments.map((a) => a.filename) },
        'Outbound attachments persisted',
      );

      return attachments.length > 0 ? attachments : undefined;
    } catch (err) {
      logger.debug({ conversationKey: this.conversationKey, outDir, err }, 'Outbox harvest failed');
      return undefined; // out/ may not exist
    }
  }
}

function mimeFromExt(ext: string): string {
  return mime.getType(ext) || 'application/octet-stream';
}

function toContainerAttachments(attachments: Attachment[]): { path: string; filename: string; mimeType: string; filesize: number }[] | undefined {
  if (attachments.length === 0) return undefined;
  return attachments.map((a) => ({
    path: attachmentContainerPath(a.hash!, pathMod.extname(a.hostPath!).slice(1)),
    filename: a.filename,
    mimeType: a.mimeType,
    filesize: a.filesize ?? 0,
  }));
}
