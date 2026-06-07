/**
 * Runner contract — the pure process-management surface that the
 * Conversation class drives. Knows nothing about slots, paging, conversations,
 * persistence.
 *
 * This interface lets Conversation be tested in isolation
 * with mock runners. The concrete implementation (today's `ConversationRunner`
 * suitably adapted) is wired by the host.
 *
 * Key differences from today's `ConversationRunner` the spec calls out:
 *
 * - No persistent `pendingMessages`. Mailbox is owned by Conversation (spec D1).
 *   Each `spawn(prompt, hooks)` call gets a per-spawn-cycle prompt; the runner
 *   does not loop respawns internally — Conversation does that.
 * - No `_phase` field. Phase is a Conversation concern.
 * - `onIdle: () => void` (no runner self-arg). The Conversation knows it owns
 *   this runner.
 */
import type { ChildProcess } from 'child_process';
import type { Attachment } from '../types.js';
import type { SpawnHooks } from '../agent/conversation-runner.js';

/** Outcome from a `Runner.spawn(...)` call. Returned after the SDK turn
 *  settles. J.3b — discriminated union:
 *  the previous shape (`{needsRespawn, result, error, outputSent, authError?}`)
 *  had three independent flags driving three real variants — exactly the
 *  pattern the style guide warns about. The spawn-loop in Conversation now
 *  switches exhaustively on `outcome.type` instead of chaining `if` branches.
 *
 *  - `settled`: SDK turn completed cleanly (with or without text output).
 *    Conversation reads `result` to fire the deliver resolver and may
 *    re-spawn iff the mailbox is non-empty.
 *  - `auth-error`: Claude unreachable. `reason` (when present) drives the
 *    retry decision: `invalid-credentials` retries up to `MAX_AUTH_RETRIES`
 *    (the legacy 401 path — token may have been refreshed mid-flight);
 *    `quota-exhausted` and `claude-unavailable` fail fast with a typed
 *    fallback (no point retrying). Missing reason = legacy behavior =
 *    retry as invalid-credentials.
 *  - `terminal-error`: container died with a real error (not auth). The
 *    spawn cycle routes through `handleTerminalError` → teardown.
 *
 *  `outputSent` is on every variant — every spawn outcome carries whether
 *  the user saw assistant text, because that drives the "should we emit a
 *  fallback?" decision (the container_error fallback only fires when no
 *  output was sent). */
export type SpawnOutcome =
  | { type: 'settled'; result: string | null; outputSent: boolean }
  | { type: 'auth-error'; outputSent: boolean; reason?: 'invalid-credentials' | 'quota-exhausted' | 'claude-unavailable' | 'not-configured' }
  | { type: 'terminal-error'; error: string; outputSent: boolean };

/**
 * Per-spawn construction opts passed by the Conversation to the factory.
 * Host-scope opts (channel config, mounts, MCP deps) come from the factory's
 * closure.
 */
export interface RunnerConstructionOpts {
  scope: string;
  conversationKey: string;
  ccSessionId: string | undefined;
  isNewConversation: boolean;
  onIdle: () => void;
  /** Live predicate that reads the owning Conversation's expired state. The
   *  runner consults this instead of holding its own phase field — single
   *  source of truth. Must re-read on each call (Conversation phase mutates
   *  during cleanup). */
  isExpired: () => boolean;
  /** Runner→Conversation hook to begin a cleanup turn. Called from the
   *  single-shot self-expire branch where the runner has decided the
   *  channel's terminal turn just produced its final output. Conversation
   *  owns the phase flip and the `<cast:lifecycle>` wrap; the runner only
   *  signals intent. Fire-and-forget — Conversation.expire's synchronous
   *  prefix runs before control returns. */
  requestCleanup: (cleanup: string) => void;
}

/**
 * Host-supplied factory bound at `Conversations.registerScope(...)` time. The
 * closure captures static host configuration (system prompt, MCP deps, etc.);
 * the per-conversation `ctx` argument carries dynamic data the host needs at
 * spawn time (channel, participant, declaredName, etc.).
 *
 * Generic over `TCtx` so each consumer (AgentManager, ConsoleManager,
 * ServerScopeConsole) gets its own typed spawn-context. The catalog stores
 * factories internally as `RunnerFactory<unknown>` and the façade casts once
 * at the `registerScope<TCtx>` boundary.
 */
export type RunnerFactory<TCtx = unknown> = (
  opts: RunnerConstructionOpts,
  ctx: TCtx,
) => Runner;

/** How `Runner.destroy` should terminate the container process.
 *
 *  - `immediate`: SIGTERM without warning. Use when the process is already
 *    dead, the cleanup turn just completed, or there's no in-flight SDK
 *    work worth preserving (`handleTerminalError`, `handleRunnerDiedInline`,
 *    `finishExpire`).
 *  - `drain`: write a stdin close hint, await exit up to `timeoutMs`, then
 *    SIGTERM if the process hasn't ended. Use when the runner may have an
 *    SDK turn in flight whose post-turn work (session JSONL flush, MCP
 *    socket close) would be truncated by an immediate SIGTERM — slot
 *    eviction (`yieldSlot`), env-stale invalidation
 *    (`replaceInvalidatedRunner`), shutdown, and hard TTL expiry.
 *
 *  Replaces the prior `graceful: boolean` field on `TeardownOpts`, which
 *  sent the close hint but did not wait for exit — the name promised drain
 *  semantics it never delivered. A non-graceful destroy on
 *  `replaceInvalidatedRunner` could kill an in-flight turn mid-write. */
export type TeardownMode =
  | { kind: 'immediate' }
  | { kind: 'drain'; timeoutMs: number };

/**
 * The Runner contract that Conversation drives. The concrete implementation
 * may be `ConversationRunner` from the agent package; tests inject
 * mocks.
 */
export interface Runner {
  /** Spawn the container, run the prompt + bootstrap, await the SDK turn.
   *  Returns when the SDK reports completion. The Conversation drives any
   *  respawn cycle. */
  spawn(prompt: PendingMessage[], hooks: SpawnHooks): Promise<SpawnOutcome>;

  /** Send a message to the live container via IPC. Returns true if the pipe
   *  accepted it, false if the container is dead or pipe failed. The runner
   *  is responsible for wrapping the text in the `<cast:kind ...attrs>`
   *  envelope based on `opts.kind` + `opts.attrs`. */
  pipeMessage(
    text: string,
    attachments?: Attachment[],
    opts?: { kind?: DeliverKind; attrs?: Record<string, string>; rawText?: string },
  ): boolean;

  /** Graceful close — sends 'close' over stdin. Container exits after current turn.
   *  Internal-use only (single-shot/expired finalization in the runner).
   *  Conversation-side teardown goes through `destroy(mode)` instead, which
   *  owns the close-hint write + bounded wait when `mode.kind === 'drain'`. */
  close(): void;

  /** Forced teardown. Sets `isDestroyed = true` synchronously, then awaits
   *  process termination (per `mode`) + MCP cleanup. See `TeardownMode`. */
  destroy(mode: TeardownMode): Promise<boolean>;

  /** Emit the user-facing "auth retries exhausted" fallback through the
   *  current spawn's hooks. Conversation calls this once when authRetries
   *  hits the policy cap inside `runSpawnCycle`; the runner has the
   *  addressing context (participant, channel, session hash) and the
   *  copy. Idempotent on expired/destroyed runners (the implementation
   *  no-ops when there's no live audience).
   *
   *  No hooks parameter — the runner uses the gated hooks captured at
   *  spawn entry. This is called from inside the same spawn cycle
   *  (Conversation's auth-retry-exhausted branch), so `lastHooks` is
   *  always live and already wrapped by the runner's phase-aware proxy. */
  emitAuthExhausted(): Promise<void>;

  readonly ccSessionId: string | undefined;
  readonly isDestroyed: boolean;
  /** Live child-process handle for the container, when alive. Used by the
   *  host for diagnostics (`getActiveProcesses`) and shutdown SIGKILL
   *  fallback (`drainRunners`). Null when the runner has no live container.
   *  A future change will replace this with a cleaner host-side process registry. */
  readonly activeProcess: ChildProcess | null;
  /** Runtime container name for the live process, or null when no live
   *  container. Lets the host target egress reconciles via `container exec`. */
  readonly activeContainerName: string | null;
}

/** A message pending delivery to a runner — either fresh in the mailbox, or
 *  drained into a spawn-cycle prompt. */
export interface PendingMessage {
  text: string;
  attachments?: Attachment[];
  kind?: DeliverKind;
  /** Tag attributes rendered into the `<cast:kind ...>` envelope opener
   *  for non-participant kinds (routing metadata: targetParticipant, etc.). */
  attrs?: Record<string, string>;
  /** Pre-format-pass content for logging (omits XML envelope). */
  rawText?: string;
}

/** Inbound stimulus class. Mirrors `agent/conversation-runner.ts:DeliverKind`. */
export type DeliverKind =
  | 'participant'
  | 'schedule'
  | 'service'
  | 'lifecycle'
  | 'watch'
  | 'push'
  // `system` — see `agent/conversation-runner.ts:DeliverKind` for the
  // streamer-state rationale.
  | 'system';

export type { SpawnHooks };
