/**
 * Conversation — the runtime identity per (scope, conversationKey).
 *
 * This class is the durable atom that callers hold. The runner inside it is
 * mutable across spawn cycles, swap-eviction, and replacement-after-invalidate,
 * but the Conversation reference is stable for the lifetime of the conversation.
 *
 * Owns:
 * - State machine (spec §2): 7 states + phase flag.
 * - Mailbox (spec D1, source of truth for pending work).
 * - Slot (held when runner alive, released on idle-no-runner / yield / destroy).
 * - Result resolver (spec D2, one-slot promise contract).
 * - Atomic-claim discipline: every transition that precedes an await claims
 *   the new state synchronously.
 * - Re-entrance guards (`_destroying`) so concurrent eviction + shutdown don't
 *   double-destroy.
 *
 * The bug classes B1 (captured-entry-stale across await), B2 (FIFO dedup-by-
 * key), O7 (resolver cross-talk), scenario-3 (deliver-to-paged-out) all become
 * structurally unrepresentable: the (scope, key) tuple is replaced by a stable
 * Conversation reference, and the resolver is owned by that reference.
 */
import type { ChildProcess } from 'child_process';
import type { AgentStateStore } from '../agent/state-store.js';
import type { RouteResult, Attachment } from '../types.js';
import { logger } from '../logger.js';
import { panicRegistry } from '../lib/panic-registry.js';
import type { SlotResult } from './catalog.js';
import type { Slot } from './slot-pool.js';
import type { ConversationTtl } from './ttl.js';
import type { ConversationEventBus, ConversationEvent } from './event-bus.js';
import type {
  ConversationState,
  ConversationPhase,
  ExpirableConversation,
} from './types.js';
import type {
  Runner,
  RunnerFactory,
  SpawnHooks,
  SpawnOutcome,
  PendingMessage,
  DeliverKind,
  TeardownMode,
} from './runner.js';

/** Max in-process auth retries before declaring terminal failure (spec §3).
 *  Counts the *number of retries attempted*, not the number of strikes — at
 *  this value the next auth_error is the exhaustion strike (no further
 *  retries; user-facing fallback fires). With `2` the user sees at most one
 *  fallback after 3 consecutive auth failures (initial + 2 retries). */
const MAX_AUTH_RETRIES = 2;

/** Cap on the framework-rejection feedback loop. When `emitFallback` (or any
 *  other framework-injected outbound) is ACL-denied, the rejection notice is
 *  re-injected into the same conversation's mailbox via `deliverSystem` —
 *  which then drives another spawn, another fallback, another rejection. The
 *  cap bounds that chain. Counts *consecutive* non-settled spawn outcomes
 *  (terminal-error, auth-exhaustion, catch-throw); a clean `settled` outcome
 *  resets to zero. On exhaustion the mailbox + pipedThisSpawn buffer are
 *  cleared so the outer while in `runSpawnCycle` doesn't re-enter slot
 *  acquisition. Mirrors `MAX_AUTH_RETRIES` and `MAX_VALIDATION_FAILURES`
 *  in shape; differs in scope — this counter spans many runner
 *  constructions within one conversation lifecycle (auth resets per-runner;
 *  validation resets per-turn). */
const MAX_ABNORMAL_EXITS = 3;

/** Minimal Catalog surface that Conversation needs. Breaks the cycle so the
 *  Catalog can hold a `Conversation` and the Conversation can call back. */
export interface ConversationCatalogRef {
  /** Acquire a slot. Returns a discriminated union — `'sync'` carries an
   *  immediately-available slot, `'async'` carries a promise of one acquired
   *  through the pressure path (LRU eviction → FIFO queue). */
  acquireSlot(conv: Conversation): SlotResult;
  maybeEvictForWaiters(conv: Conversation): void;
  unregister(conv: Conversation): void;
}

/**
 * Caller-facing handle to a Conversation. Mostly read-only — the one write
 * surface is `deliver`, used by spawn-hook shims that need to push follow-up
 * messages (retry-push, lifecycle, query-push) without holding a runner ref.
 * Such re-delivers reuse the conversation's stored ctx (set by the originating
 * façade.deliver / scheduleTtl call), so they don't restate it.
 *
 * `TCtx` is the host's spawn-context type (e.g. `AgentSpawnContext` for
 * AgentManager).
 *
 * ## Diagnostic vs action surfaces (K.1c)
 *
 * The view exposes two kinds of fields. Use them differently:
 *
 * **Diagnostic surfaces** — raw state for display/logging/test assertions.
 * Read them when you need to *show* something to a human (status pages,
 * activity logs, admin UI) or *assert* something in a test. Never branch
 * production behavior off them:
 *
 *   - `state`, `phase` — underlying state-machine values
 *   - `isExpired`, `isDestroyed`, `isInvalidated` — boolean projections of
 *     `phase`/`state` (legacy diagnostic surfaces retained from H/I/J;
 *     equivalent to `phase === 'expiring'` etc.)
 *   - `hasRunner`, `mailboxSize`, `lastActive`, `ccSessionId`, `activeProcess`
 *
 * **Action surfaces** — predicates and methods that *decide* whether the
 * caller should do something. Branch off these in production code:
 *
 *   - `canAcceptUserMessage()`, `canEndManually()`, `canDeliverQueryReply()`
 *   - `deliver(text, opts?)`
 *
 * The rule: if you're tempted to write `if (view.state === X)` or
 * `if (view.isExpired)` to decide an *action*, that's the J.4a/K.1
 * recurrence pattern. Add a `can*()` predicate to this interface and
 * implement it next to its peers — don't reinterpret state at the call
 * site. The audit history (Phases H/I/J) is the proof: every state-leak
 * recurrence cost a full audit cycle to clean up.
 *
 * Predicates are added *lazily* (one per real consumer); we don't pre-add
 * speculative ones. As of K.1: the three predicates above cover every
 * production branching site (`agent-route`, `console/tools`,
 * `agent-manager`, `query-round-trip`). `view.state` / `view.phase` have
 * zero production reads — diagnostic-only by current usage. If you're
 * about to add the first one, add a predicate instead.
 */
export interface ConversationView<TCtx = unknown> {
  readonly scope: string;
  readonly key: string;
  readonly ctx: TCtx | undefined;
  /** Diagnostic — current state-machine value. Do NOT branch production
   *  behavior off this; add a `can*()` predicate instead. See the
   *  interface JSDoc "Diagnostic vs action surfaces". */
  readonly state: ConversationState;
  /** Diagnostic — current phase value. Same diagnostic-only contract as
   *  `state`. */
  readonly phase: ConversationPhase;
  readonly ccSessionId: string | undefined;
  readonly lastActive: string;
  readonly hasRunner: boolean;
  /** Diagnostic — equivalent to `phase === 'expiring'`. Production code
   *  branches off `canAcceptUserMessage()` / `canEndManually()` instead. */
  readonly isExpired: boolean;
  /** Diagnostic — equivalent to `state === 'destroyed'`. Production code
   *  branches off `canDeliverQueryReply()` / `canAcceptUserMessage()`
   *  instead. */
  readonly isDestroyed: boolean;
  /** Diagnostic — equivalent to `_envStale` env-staleness tag.
   *  Production code branches off `canAcceptUserMessage()` instead. */
  readonly isInvalidated: boolean;
  readonly mailboxSize: number;
  /** Live container process when this conversation has an active runner.
   *  Null otherwise. Typed surface that replaces `view.ref.activeProcess` —
   *  callers no longer reach through `ref` for the underlying handle.
   *  Snapshot-only: see `Conversation.activeProcess` for liveness semantics. */
  readonly activeProcess: ChildProcess | null;
  /** Runtime container name when this conversation has a live runner, else null.
   *  Lets the host target egress reconciles (see egress-controller.ts). */
  readonly activeContainerName: string | null;

  /**
   * Push a follow-up message into the conversation. The stored ctx is
   * supplied automatically; callers shouldn't restate it. Throws if no
   * ctx has been set yet — by design, callers that need ctx-less entry
   * should use the façade's `deliver<TCtx>(scope, key, text, ctx, opts?)`
   * which provides ctx as a required parameter.
   */
  deliver(text: string, opts?: DeliverOpts): Promise<RouteResult>;

  /**
   * Semantic predicate: this conversation can accept a user-initiated
   * message right now. False when the conversation is expiring/destroyed/
   * invalidated — the inbound stimulus shouldn't be delivered, but the
   * caller decides what to do (typically a no-op or fallback).
   *
   * J.4a — closes the audit pattern where consumers read raw
   * `view.isExpired` and infer "can deliver?" branches. The predicate
   * encapsulates the decision: future tightenings (e.g. "destroyed also
   * blocks") only need to update one site.
   */
  canAcceptUserMessage(): boolean;

  /**
   * Semantic predicate: this conversation can be ended manually (via the
   * `end_conversation` tool or equivalent). Returns a result object with
   * `accepted` plus a `reason` for rejection — callers (console tools,
   * agent-manager) feed `reason` straight back to the LLM, so the strings
   * matter for prompt quality.
   *
   * Rejection cases live in this predicate (was scattered across
   * `console/tools.ts` and `agent-manager.ts`):
   * - already expiring → "Cleanup turn in progress."
   * - destroyed → "Conversation already ended."
   *
   * Channel-config rejections (no `idle_timeout`, single-shot) stay at the
   * caller — they need channel-level data this predicate doesn't carry.
   */
  canEndManually(): { ok: true } | { ok: false; reason: string };

  /**
   * Semantic predicate: a query-response reply (`<cast:answer>`) for an
   * outbound request should be delivered into this conversation. False
   * when destroyed — the conversation context is gone, the reply must
   * be dropped (NOT routed to a fresh successor under the same key).
   */
  canDeliverQueryReply(): boolean;

  // J.4b — `ref` is no longer part of the production interface. Test code
  // that needs the underlying Conversation reaches through
  // `Conversations[CONVERSATION_TEST_ACCESS](scope, key)` on the façade. See
  // facade.ts for the test-access protocol.
}

/** Builds the `SpawnHooks` for a single spawn cycle of a Conversation.
 *
 *  Phase H Step 7 collapsed the per-Conversation observation surface onto
 *  `ConversationEventBus`; Phase I.8 then collapsed the residual
 *  single-field `ConversationCallbacks` interface to a direct function
 *  type. Hosts pass a closure that captures their per-host wiring (bus,
 *  agentDb, store, etc.) and returns the hooks the Conversation hands to
 *  `Runner.spawn`. The TCtx generic flows through so the typed
 *  `ConversationView<TCtx>` is available to the host for per-conversation
 *  context (channel/participant/qualifier) without a side-channel map.
 *
 *  Transition-driven observation (queue UX, runner removal, expiry
 *  side-effects) lives on the event bus — subscribe via
 *  `Conversations.subscribeScope` at scope-register time.
 */
export type BuildSpawnHooks<TCtx = unknown> = (conv: ConversationView<TCtx>) => SpawnHooks;

export interface ConversationOpts {
  scope: string;
  conversationKey: string;
  factory: RunnerFactory;
  catalog: ConversationCatalogRef;
  store: AgentStateStore;
  ttl: ConversationTtl;
  buildSpawnHooks: BuildSpawnHooks;
  /** In-process event bus — the sole observation surface for Conversation
   *  transitions (Phase H Step 7). Required: the legacy `ConversationCallbacks`
   *  observation entries (`onQueued`, `onRunnerRemoved`, `onExpiryComplete`)
   *  were removed and every emit now lands on this bus. */
  eventBus: ConversationEventBus;
}

export interface DeliverOpts {
  kind?: DeliverKind;
  attachments?: Attachment[];
  /** Tag attributes rendered into the `<cast:kind ...>` envelope opener for
   *  non-participant kinds (e.g. routing metadata on push/lifecycle). */
  attrs?: Record<string, string>;
  /** Pre-format-pass content for inbound logging. Falls back to `text`. */
  rawText?: string;
}

/** Default drain timeout for slot eviction, env-stale invalidation, and
 *  shutdown teardown. Short enough not to stall pool pressure beyond user-
 *  perceptible bounds, long enough for an SDK turn to finalize JSONL
 *  writes and MCP socket teardown. `TeardownMode` itself lives in
 *  `./runner.ts` next to the `Runner` interface that consumes it. */
const DEFAULT_DRAIN_TIMEOUT_MS = 5000;

/**
 * Options for the `_teardown` chokepoint. Every cleanup path in `Conversation`
 * routes through `_teardown` with intent expressed as opts — collapses the
 * seven independent cleanup sites that hosted Bugs A and B (spec §21).
 *
 * J.3a — discriminated by `target`. The pre-J.3a
 * shape carried `expireSideEffects?` and `skipDrain?` as plain optionals on a
 * flat interface — meaningless combinations like
 * `{ target: 'idle-no-runner', expireSideEffects: true }` were
 * representable. Splitting by `target` makes the only valid combinations
 * structural, and the body can `switch (opts.target)` rather than defensively
 * reading each flag.
 *
 * Common fields (`graceful`, `resolveWith`, `skipKick`) stay across both
 * variants — they're semantically meaningful regardless of target.
 */
type TeardownOpts =
  | {
      /** Soft teardown — runner gone, slot released, conversation remains
       *  in the catalog and can re-spawn from mailbox content. */
      target: 'idle-no-runner';
      /** How to terminate the runner process. See `TeardownMode`. */
      mode: TeardownMode;
      /** Skip pool drain — used by yieldSlot pressure path where the caller
       *  will immediately re-acquire and doesn't want a queued waiter to
       *  grab the slot. */
      skipDrain?: boolean;
      /** Fire pending resolver with this result before transitioning. */
      resolveWith?: RouteResult;
      /** Skip the spawn-cycle kick at the end. Used when the caller is
       *  already inside `runSpawnCycle` (handleTerminalError) or will kick
       *  itself (deliver after handleRunnerDiedInline /
       *  replaceInvalidatedRunner). */
      skipKick?: boolean;
    }
  | {
      /** Hard teardown — conversation unregistered from the catalog. */
      target: 'destroyed';
      /** How to terminate the runner process. See `TeardownMode`. */
      mode: TeardownMode;
      /** Run expire side-effects (store.expireConversation +
       *  emitBus('expiry-complete')). Only meaningful for destroyed-target;
       *  unrepresentable on the idle-no-runner branch. */
      expireSideEffects?: boolean;
      /** Fire pending resolver with this result before transitioning. */
      resolveWith?: RouteResult;
      /** Skip the spawn-cycle kick — moot for destroyed (we never re-spawn
       *  after unregister) but kept for caller symmetry. */
      skipKick?: boolean;
    };

type Resolver = (result: RouteResult) => void;

export class Conversation implements ExpirableConversation {
  // --- Identity (immutable) ---
  readonly scope: string;
  readonly key: string;

  // --- Wiring ---
  private readonly factory: RunnerFactory;
  private readonly catalog: ConversationCatalogRef;
  private readonly store: AgentStateStore;
  private readonly ttl: ConversationTtl;
  private readonly buildSpawnHooks: BuildSpawnHooks;
  private readonly eventBus: ConversationEventBus;

  // --- State ---
  private _state: ConversationState = 'idle-no-runner';
  private _phase: ConversationPhase = 'new';
  /** Env-staleness tag (renamed from `_invalidated` in K.2): "the next
   *  spawn must replace the runner." Orthogonal to the state union — not a
   *  state, not gated by `setState`. It's a *transition request* held in a
   *  field rather than a queue: when the agent's manifest changes
   *  externally, `invalidate()` sets the tag, and the next `deliver()`
   *  observes it and triggers a teardown-and-replace cycle. Reset to
   *  `false` inside `runSpawnCycle` after a new runner is constructed.
   *
   *  K.2 audit conclusion: keep as a flag. The fold-into-state-union
   *  alternative (e.g. an `'invalidated-running'` variant) would double the
   *  state count without changing the behavioral surface. Env staleness is
   *  genuinely an orthogonal *queryable tag*, not a state. */
  private _envStale = false;
  /** R4 re-entrance lock for `_teardown` (Phase I.9): the in-flight Promise
   *  of the active teardown, or null when no teardown is running. Concurrent
   *  callers receive this Promise and await it rather than re-entering the
   *  teardown body. Replaces the previous `_destroying = boolean` pattern —
   *  the structural property is the same (one teardown executes; siblings
   *  observe), but callers can now await the active teardown instead of
   *  receiving a silent no-op. */
  private _teardownInFlight: Promise<void> | null = null;
  // K.2 — `_shuttingDown` boolean folded into `_phase === 'terminating'`.
  // Server-shutdown is now a typed phase transition: `shutdown()` calls
  // `setPhase('terminating')` (always permitted from any non-terminating
  // phase). Reads previously written as `this.isTerminating` are now
  // `this.isTerminating` (a getter that wraps the phase comparison).

  // --- Runtime refs ---
  private runner: Runner | null = null;
  private slot: Slot | null = null;
  /** Ownership generation. Each `runSpawnCycle` captures this at acquisition;
   *  `_teardownBody` bumps it when it relinquishes the runner+slot. A spawn
   *  cycle whose captured epoch no longer matches has been superseded by a
   *  teardown (and the successor cycle the teardown kicked) — see
   *  `supersededSince`. The single tag that lets a suspended cycle detect that
   *  its ownership was revoked across an `await`. */
  private spawnEpoch = 0;
  private mailbox: PendingMessage[] = [];
  /** Messages successfully IPC-piped to the runner during the current spawn
   *  cycle. Populated by `deliver()` when `runner.pipeMessage` succeeds.
   *  Cleared on clean spawn settle (`running → idle-with-runner`); re-queued
   *  back into the mailbox head on abnormal spawn end (G.4) so the next spawn
   *  cycle re-delivers them. Distinct from `mailbox` because piped messages
   *  skip the mailbox queue — without this buffer, an auth-error / crash mid-
   *  spawn would silently drop them. */
  private pipedThisSpawn: PendingMessage[] = [];
  private resolver: Resolver | null = null;
  private _lastActive: string = new Date().toISOString();
  private authRetries = 0;
  /** Counter for `MAX_ABNORMAL_EXITS`. Single home for the cap state:
   *  written by `recordSpawnOutcome`, consumed by it. The outer while in
   *  `runSpawnCycle` doesn't read this directly — the cap-hit effect is
   *  the mailbox/pipedThisSpawn clear inside `recordSpawnOutcome`, which
   *  the outer while observes via `mailbox.length`. */
  private consecutiveAbnormalExits = 0;
  /** Wall-clock timestamp of the first abnormal exit in the current
   *  streak. Used by `recordSpawnOutcome` to ask `panicRegistry` whether
   *  the streak is fast enough to escalate to an agent-scope halt
   *  (button #5). Reset to `null` on a clean settled outcome alongside
   *  `consecutiveAbnormalExits`. */
  private firstAbnormalExitAt: number | null = null;
  /** Per-conversation spawn context. Set by `deliver(text, opts, ctx)` and
   *  `scheduleTtl(..., ctx)`. The factory closure receives this when
   *  constructing a runner — replaces the side-channel `routeContexts` map
   *  AgentManager held during Phase C. Stored as `unknown` internally; the
   *  per-scope binding type-checks ctx at the façade boundary. */
  private _ctx: unknown = undefined;

  constructor(opts: ConversationOpts) {
    this.scope = opts.scope;
    this.key = opts.conversationKey;
    this.factory = opts.factory;
    this.catalog = opts.catalog;
    this.store = opts.store;
    this.ttl = opts.ttl;
    this.buildSpawnHooks = opts.buildSpawnHooks;
    this.eventBus = opts.eventBus;
  }

  // =========================================================================
  // Public getters
  // =========================================================================

  get state(): ConversationState {
    return this._state;
  }
  get phase(): ConversationPhase {
    return this._phase;
  }
  get isInvalidated(): boolean {
    return this._envStale;
  }
  get isExpired(): boolean {
    return this._phase === 'expiring';
  }
  get isDestroyed(): boolean {
    return this._state === 'destroyed';
  }
  /** K.2 — `_phase === 'terminating'` projection. Used by `runSpawnCycle`
   *  and `handleRunnerIdle` to bail when the server is shutting down. The
   *  `'terminating'` phase is set synchronously by `shutdown()` before the
   *  teardown loop, so concurrent paths that observe it can short-circuit
   *  cleanly. */
  get isTerminating(): boolean {
    return this._phase === 'terminating';
  }
  get hasRunner(): boolean {
    return this.runner !== null;
  }
  get lastActive(): string {
    return this._lastActive;
  }
  get mailboxSize(): number {
    return this.mailbox.length;
  }
  get ccSessionId(): string | undefined {
    return this.store.getActiveConversation(this.key)?.ccSessionId;
  }

  /** Live container process when this conversation has an active runner.
   *  Null otherwise. Used by host for diagnostics + SIGKILL during shutdown. */
  get activeProcess(): ChildProcess | null {
    return this.runner?.activeProcess ?? null;
  }

  /** Runtime container name when a runner is live, else null. */
  get activeContainerName(): string | null {
    return this.runner?.activeContainerName ?? null;
  }

  /** Latest spawn context provided via `deliver` / `scheduleTtl` (or
   *  undefined if neither has been called). Surfaced as `ConversationView.ctx`
   *  for the host's callbacks. Returned as `unknown` here — typed access
   *  comes through the façade's generic methods. */
  get ctx(): unknown {
    return this._ctx;
  }

  /** Update the stored spawn context. Called by the façade on every
   *  `deliver` / `scheduleTtl` so the latest call's ctx wins (a fresh
   *  delivery may bring updated `replyTo` / `declaredName` etc.). */
  setCtx(ctx: unknown): void {
    if (ctx !== undefined) this._ctx = ctx;
  }

  /** Build a `ConversationView` handle. Cast is internal — the façade
   *  re-narrows TCtx at the public boundary. The view's `deliver` method
   *  routes back through `Conversation.deliver` with the stored ctx, so
   *  callers don't have to re-supply it. */
  view<TCtx>(): ConversationView<TCtx> {
    return {
      scope: this.scope,
      key: this.key,
      ctx: this._ctx as TCtx | undefined,
      state: this._state,
      phase: this._phase,
      ccSessionId: this.ccSessionId,
      lastActive: this._lastActive,
      hasRunner: this.runner !== null,
      isExpired: this.isExpired,
      isDestroyed: this.isDestroyed,
      isInvalidated: this._envStale,
      mailboxSize: this.mailbox.length,
      activeProcess: this.activeProcess,
      activeContainerName: this.activeContainerName,
      deliver: (text, opts) => {
        if (this._ctx === undefined) {
          // The View's deliver is intended for callers that already have a
          // ctx set on the conv (spawn-hook shims fired mid-cycle). Cold
          // entry without ctx must go through the façade's typed deliver.
          throw new Error(
            `ConversationView.deliver: no ctx set for ${this.scope}/${this.key} — ` +
            `use Conversations.deliver(scope, key, text, ctx, opts) for cold entry`,
          );
        }
        return this.deliver(text, this._ctx, opts);
      },
      canAcceptUserMessage: () => !this.isExpired && !this.isDestroyed && !this._envStale,
      canEndManually: () => {
        if (this.isExpired) return { ok: false, reason: 'Cleanup turn in progress.' };
        if (this.isDestroyed) return { ok: false, reason: 'Conversation already ended.' };
        return { ok: true };
      },
      canDeliverQueryReply: () => !this.isDestroyed,
    };
  }

  // =========================================================================
  // deliver — primary entry from Conversations.deliver
  // =========================================================================

  /**
   * Deliver a message. Returns:
   * - The spawn-cycle's first non-respawn outcome if THIS deliver initiated
   *   the cycle (state was `idle-no-runner` and no prior resolver).
   * - Synthetic `{ ok: true, result: null }` otherwise — the runner is alive
   *   or another deliver already owns the resolver.
   *
   * `ctx` carries per-conversation spawn data the factory closure needs
   * (channel, participant, etc.) and is required on every call — symmetric
   * with the façade's public `Conversations.deliver`. Spawn-hook shims that
   * push follow-up messages without restating ctx use `ConversationView.deliver`,
   * which reads the stored ctx and routes through here.
   *
   * State transitions follow the spec §2 transition table. Atomic-claim
   * discipline: every transition that precedes an await claims the new
   * state synchronously.
   */
  async deliver(text: string, ctx: unknown, opts?: DeliverOpts): Promise<RouteResult> {
    this.setCtx(ctx);
    if (this._state === 'destroyed') {
      logger.warn(
        { scope: this.scope, key: this.key },
        'Conversation.deliver: rejected; conversation destroyed',
      );
      return { ok: false, error: 'Conversation destroyed' };
    }

    this.touchLastActive();
    const msg: PendingMessage = {
      text,
      attachments: opts?.attachments,
      kind: opts?.kind,
      attrs: opts?.attrs,
      rawText: opts?.rawText,
    };

    // Invalidated runner: tear it down synchronously so the next branch sees
    // idle-no-runner and begins a fresh spawn cycle. Destroy is fire-and-
    // forget — production Conversation containers are async-destroyed in the
    // background; we don't block the deliver path on it.
    if (
      this._envStale &&
      this.runner !== null &&
      (this._state === 'running' || this._state === 'idle-with-runner')
    ) {
      this.replaceInvalidatedRunner();
    }

    // IPC fast path: runner alive AND not invalidated.
    if (
      (this._state === 'running' || this._state === 'idle-with-runner') &&
      this.runner !== null &&
      !this._envStale
    ) {
      const piped = this.runner.pipeMessage(text, opts?.attachments, {
        kind: opts?.kind,
        attrs: opts?.attrs,
        rawText: opts?.rawText,
      });
      if (piped) {
        // Track for crash/auth-error replay — see `pipedThisSpawn` declaration.
        this.pipedThisSpawn.push(msg);
        if (this._state === 'idle-with-runner') {
          this.setState('running');
        }
        return { ok: true, result: null };
      }
      // Pipe failure — treat as runner died. Releases slot, transitions to
      // idle-no-runner. Fall through to the queue/spawn path below.
      this.handleRunnerDiedInline();
    }

    this.mailbox.push(msg);

    // Initiate a spawn cycle if we're now in idle-no-runner with work.
    if (this._state === 'idle-no-runner') {
      const promise = this.installResolver();
      this.beginSpawnCycle();
      return promise;
    }

    // awaiting-slot, expiring, or runner died+respawning: the first deliver
    // owns the resolver. Subsequent ones synthesize OK.
    return { ok: true, result: null };
  }

  /** Drop the invalidated runner. State transitions to `idle-no-runner`
   *  synchronously (atomic claim inside `_teardown`); the destroy await runs
   *  in the background. Caller (deliver) continues immediately and handles
   *  the spawn-cycle kick via `beginSpawnCycle`. */
  private replaceInvalidatedRunner(): void {
    if (this.runner === null) return;
    // Drain — env-stale invalidation can fire while the runner has an
    // active turn (the deliver that triggered it carries new input).
    // Immediate SIGTERM here was the trigger of the 696K-iteration
    // feedback loop incident.
    void this._teardown({
      mode: { kind: 'drain', timeoutMs: DEFAULT_DRAIN_TIMEOUT_MS },
      target: 'idle-no-runner',
      skipKick: true,
    });
  }

  // =========================================================================
  // expire — TTL fire or operator-initiated
  // =========================================================================

  /**
   * Begin expiry. Cleanup text (if provided) is queued into the mailbox or
   * piped IPC depending on current state. The state machine handles the
   * rest; this method returns after the synchronous transition completes.
   *
   * The cleanup turn always runs to completion (spec §11). If a new user
   * message arrives mid-expire, it's serialized — see D3 resurrection.
   */
  async expire(cleanup: string | null): Promise<void> {
    // Phase guard: once phase is 'expiring', subsequent expire calls are
    // rejected — there's at most one cleanup turn per conversation.
    if (this._state === 'destroyed' || this._phase === 'expiring') {
      logger.warn(
        { scope: this.scope, key: this.key, state: this._state, phase: this._phase },
        'Conversation.expire: rejected; already terminal/expiring',
      );
      return;
    }

    this.touchLastActive();

    // Hard expire (no cleanup): terminate without running a cleanup turn.
    if (cleanup === null) {
      await this.hardExpire();
      return;
    }

    this.setPhase('expiring');
    const cleanupMsg: PendingMessage = { text: cleanup, kind: 'lifecycle' };

    switch (this._state) {
      case 'idle-no-runner':
        this.mailbox.push(cleanupMsg);
        // beginSpawnCycle sets state to 'awaiting-slot' itself.
        this.beginSpawnCycle();
        return;
      case 'awaiting-slot':
        this.mailbox.push(cleanupMsg);
        return;
      case 'running':
        if (this.runner !== null) {
          const piped = this.runner.pipeMessage(cleanup, undefined, { kind: 'lifecycle' });
          if (piped) return;
          this.handleRunnerDiedInline();
          this.mailbox.push(cleanupMsg);
          this.beginSpawnCycle();
        }
        return;
      case 'idle-with-runner':
        if (this.runner !== null) {
          const piped = this.runner.pipeMessage(cleanup, undefined, { kind: 'lifecycle' });
          if (piped) {
            this.setState('running');
            return;
          }
          this.handleRunnerDiedInline();
          this.mailbox.push(cleanupMsg);
          this.beginSpawnCycle();
        }
        return;
    }
  }

  // =========================================================================
  // invalidate — env-stale flag (replace runner on next deliver)
  // =========================================================================

  invalidate(): void {
    if (this._state === 'destroyed' || this._phase === 'expiring') return;
    this._envStale = true;
  }

  // =========================================================================
  // yieldSlot — catalog requests the slot back for eviction
  // =========================================================================

  /**
   * Catalog asks the conversation to relinquish its slot for an eviction.
   * Precondition: state === 'idle-with-runner'. Re-entrance-safe via
   * `_destroying` flag (R4).
   *
   * `skipDrain: true` (default) is for the requestSlot pressure path —
   * the catalog will immediately re-acquire and doesn't want the queued
   * waiters to grab the freed slot. `skipDrain: false` is for
   * maybeEvictForWaiters, where the whole point IS giving the slot to a
   * queued waiter.
   */
  async yieldSlot(opts?: { skipDrain?: boolean }): Promise<void> {
    // Idempotent: if state already transitioned past idle-with-runner (e.g.
    // a concurrent teardown ran), silently no-op.
    if (this._state === 'destroyed' || this._state === 'idle-no-runner') return;
    if (this._state !== 'idle-with-runner') {
      logger.warn(
        { scope: this.scope, key: this.key, state: this._state },
        'Conversation.yieldSlot: precondition violated; ignoring',
      );
      return;
    }
    if (this.runner === null || this.slot === null) {
      logger.error(
        { scope: this.scope, key: this.key },
        'Conversation.yieldSlot: invariant I2 violated (idle-with-runner without runner/slot)',
      );
      return;
    }
    // Drain — yieldSlot fires on idle-with-runner, but a parallel deliver
    // can race in a new pipeMessage between the precondition check and the
    // destroy. Drain covers the race without measurably stalling the
    // pressure path (DEFAULT_DRAIN_TIMEOUT_MS is short).
    await this._teardown({
      mode: { kind: 'drain', timeoutMs: DEFAULT_DRAIN_TIMEOUT_MS },
      target: 'idle-no-runner',
      skipDrain: opts?.skipDrain ?? true,
    });
  }

  /**
   * Catalog notifies the conversation that an in-flight swap-eviction lost
   * the slot race to a parallel caller and is now falling through to the
   * FIFO queue. Belatedly transition to `awaiting-slot` so the bus emits
   * `queued{active:true}` and reflects the runtime truth (we are now
   * genuinely FIFO-queued, not in a transient swap window). Phase L.
   *
   * Guarded so concurrent shutdown / teardown wins: only fires the
   * transition if we are still in `idle-no-runner` and not terminating.
   * Goes through the `setState` chokepoint, so the queued-event emission
   * has exactly one site as everywhere else in the class.
   */
  markSwapFellThrough(): void {
    if (this._state !== 'idle-no-runner') return;
    if (this.isTerminating) return;
    this.setState('awaiting-slot');
  }

  // =========================================================================
  // shutdown — graceful conversation termination
  // =========================================================================

  /**
   * Tear down on process shutdown or scope unmount. Cancels TTL, releases
   * the slot, fires the pending resolver with a shutdown error, and
   * transitions to `destroyed`. Idempotent.
   *
   * J.2 — teardown-target precedence: `_teardown` is re-entrant-safe (a
   * concurrent caller receives the in-flight Promise and awaits the same
   * settle), but the first caller's `target` is what the body uses. If a
   * `yieldSlot` teardown was already in flight when `shutdown` is invoked,
   * the in-flight Promise settles at `idle-no-runner` and our await returns
   * with `_state !== 'destroyed'`. Loop and re-tear-down: by the second
   * iteration no other teardown can be in flight (we set `_shuttingDown`
   * before the loop, suppressing `runSpawnCycle`/`handleRunnerIdle` from
   * initiating new teardowns), and `_teardown(target: 'destroyed')` runs
   * fresh and lands the conversation at `destroyed`. Caller-side priority
   * keeps `_teardown` itself simple — no precedence logic inside the
   * chokepoint, just "shutdown specifically knows it wants to win."
   */
  async shutdown(): Promise<void> {
    // K.2 — `setPhase('terminating')` replaces the `_shuttingDown = true`
    // boolean. Phase transition emits a typed bus event AND projects to
    // `isTerminating` for the same-purpose reads inside the spawn cycle.
    // setPhase short-circuits if already 'terminating', so concurrent
    // shutdown calls don't re-fire the phase event.
    this.setPhase('terminating');
    this.ttl.cancelTtl(this);
    // The catalog pre-cancels any pool waiter token before calling shutdown
    // (see ConversationCatalog.shutdownScope/shutdownAll), so awaiting-slot
    // entries don't dangle in the pool queue.
    while (true) {
      // Re-broaden via a local: TS narrows `this._state` to the non-destroyed
      // members across awaits if we check `!== 'destroyed'` directly, masking
      // the J.2 race scenario where a concurrent teardown lands first.
      const current: ConversationState = this._state;
      if (current === 'destroyed') return;
      // Drain — server shutdown should still let in-flight turns finalize
      // their disk writes within a bounded window. Falls through to SIGTERM
      // if the SDK doesn't honor the close in time.
      await this._teardown({
        mode: { kind: 'drain', timeoutMs: DEFAULT_DRAIN_TIMEOUT_MS },
        target: 'destroyed',
        resolveWith: { ok: false, error: 'Server shutting down' },
      });
    }
  }

  // =========================================================================
  // Internal: spawn cycle (drives mailbox + runner.spawn loop)
  // =========================================================================

  /** Kick off the spawn cycle without awaiting. Called from idle-no-runner
   *  with mailbox non-empty.
   *
   *  Stays in `idle-no-runner` until `runSpawnCycle` knows whether the pool
   *  has fast capacity (sync grant → `running` directly) or the conversation
   *  must wait on the FIFO (transition to `awaiting-slot` then `running`).
   *  Entering `awaiting-slot` speculatively before knowing would violate spec
   *  §2.94 / §13.I3 and produce spurious `onQueued` events for the sync
   *  fast path. See spec §14.H Step 1. */
  private beginSpawnCycle(): void {
    if (this._state !== 'idle-no-runner') {
      throw new Error(
        `beginSpawnCycle: precondition violated (state=${this._state})`,
      );
    }
    void this.runSpawnCycle();
  }

  /**
   * A spawn cycle is superseded once a teardown bumps `spawnEpoch` past the
   * value it captured at acquisition (or the conversation is tearing down). A
   * superseded cycle must not mutate shared state across an `await` — its
   * runner/slot were reclaimed and its work now belongs to the successor cycle
   * the teardown kicked. This is the single ownership predicate behind the
   * three bail points in `runSpawnCycle` / `handleRunnerIdle`; it subsumes the
   * former scattered `isDestroyed`/`isTerminating` re-affirm guards.
   */
  private supersededSince(epoch: number): boolean {
    return epoch !== this.spawnEpoch || this.isDestroyed || this.isTerminating;
  }

  /**
   * The async cycle: acquire slot → spawn (looping on mailbox content
   * between settled outcomes) → handle outcome. Owns the state transitions
   * through
   * `awaiting-slot → running → idle-with-runner`. Settles on
   * idle-with-runner (success), idle-no-runner (terminal error, empty
   * mailbox), or destroyed (expire-cleanup completion).
   *
   * The outer `while` re-enters the cycle when a terminal error leaves the
   * mailbox non-empty (concurrent deliveries arrived during the failed turn).
   */
  private async runSpawnCycle(): Promise<void> {
    while (true) {
      if (this.state === 'destroyed' || this.isTerminating) return;
      if (this.state !== 'idle-no-runner') {
        logger.error(
          { scope: this.scope, key: this.key, state: this.state },
          'runSpawnCycle: unexpected state at loop head',
        );
        return;
      }

      // Panic button #1 — spawn-rate per agent. Records this spawn in
      // the per-scope ring buffer and trips a halt if the count crosses
      // SPAWN_RATE_MAX within the SPAWN_RATE_WINDOW_MS window. When the
      // halt fires we drop pending work and exit the cycle; the route
      // gate (`agent-route.ts`) blocks new inbound until the halt
      // expires. This catches sustained-rate runaways that the
      // correctness cap (MAX_ABNORMAL_EXITS) would only notice once a
      // streak of consecutive failures accumulated.
      const spawnHalt = panicRegistry.recordSpawn(this.scope);
      if (spawnHalt) {
        this.mailbox = [];
        this.pipedThisSpawn = [];
        logger.warn(
          {
            scope: this.scope,
            key: this.key,
            button: spawnHalt.button,
            reason: spawnHalt.reason,
            until: spawnHalt.until,
          },
          'runSpawnCycle: aborted by panic registry',
        );
        // Route through the existing terminal-error teardown — leaves
        // state at idle-no-runner; the outer while won't re-enter
        // because the mailbox is empty.
        await this.handleTerminalError(`panic: ${spawnHalt.button}`);
        return;
      }

      // Acquire a slot. The catalog returns one of three discriminants:
      // - sync: pool had capacity; skip `awaiting-slot` entirely and go
      //   straight to `running`. No queue UX fires.
      // - swap: an idle-with-runner victim exists; the catalog evicts it
      //   in a transient ~ms window. The bus stays silent during the swap
      //   (no `queued` event) because no FIFO wait is occurring from the
      //   operator's POV. If the swap-eviction loses the slot race to a
      //   parallel caller, the catalog calls `markSwapFellThrough()` to
      //   belatedly transition to `awaiting-slot` so the bus event still
      //   fires for the (now-genuine) FIFO wait. Phase L.
      // - queued: pool is saturated AND no swap victim is available. This
      //   is a genuine FIFO wait — transition to `awaiting-slot` up front
      //   (firing `queued{active:true}`), await, then to `running` (firing
      //   `queued{active:false}`).
      //
      // Per spec §2.94 / §13.I3, `awaiting-slot` means "FIFO-queued on the
      // pool"; entering it on the swap path would diverge from the runtime
      // fact (the swap is transparent). See spec §14.H Step 1 + §14.L.
      const acquired = this.catalog.acquireSlot(this);
      let slot: Slot;
      if (acquired.kind === 'sync') {
        slot = acquired.slot;
      } else {
        if (acquired.kind === 'queued') {
          this.setState('awaiting-slot');
        }
        // For `swap`: stay in `idle-no-runner` during the transient window.
        // The catalog may call `markSwapFellThrough()` if the swap loses
        // its slot race, which routes us into `awaiting-slot` belatedly.
        try {
          slot = await acquired.promise;
        } catch (err) {
          // Stash the state into a fresh local to re-broaden the type — TS
          // keeps the narrowing from the pre-await check otherwise.
          const after: ConversationState = this._state;
          if (after !== 'destroyed') {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.fireResolver({ ok: false, error: errMsg });
            this.setState('idle-no-runner');
          }
          return;
        }
      }

      // Atomic claim before consuming the slot. Transition directly to
      // 'running' — factory construction is synchronous, so there's no
      // observable window where a 'spawning' state could be witnessed
      // externally. IPC pipe becomes usable as soon as `this.runner` is set.
      // Allowed pre-acquire states: 'idle-no-runner' (sync path) or
      // 'awaiting-slot' (async path that resolved). Anything else means the
      // state was clobbered mid-flight.
      const postAcquire: ConversationState = this._state;
      if (postAcquire === 'destroyed' || this.isTerminating) {
        slot.release();
        return;
      }
      if (postAcquire !== 'idle-no-runner' && postAcquire !== 'awaiting-slot') {
        slot.release();
        return;
      }
      this.setState('running');
      this.slot = slot;

      // Construct the runner via host-provided factory.
      const ccSessionId = this.store.getActiveConversation(this.key)?.ccSessionId;
      const isNewConversation = ccSessionId === undefined;
      this._envStale = false;
      this.authRetries = 0;
      // Snapshot the ownership generation for this cycle. Captured before the
      // factory call so the `onIdle` closure carries it — a late idle report
      // from this runner after a teardown supersedes us is then ignored. No
      // teardown can intervene between here and the synchronous assignment
      // below, so this is the epoch at which this cycle owns the conversation.
      const epoch = this.spawnEpoch;
      const runner = this.factory(
        {
          scope: this.scope,
          conversationKey: this.key,
          ccSessionId,
          isNewConversation,
          onIdle: () => this.handleRunnerIdle(epoch),
          isExpired: () => this.isExpired,
          requestCleanup: (cleanup) => {
            // SIDE EFFECT: Fire-and-forget kick into Conversation.expire.
            // The runner calls this from its single-shot self-expire branch;
            // we must not await the full cleanup turn here (it runs inside the
            // same spawn() loop the runner is currently in). Conversation.expire
            // does its synchronous phase flip + pipe before the first await,
            // so by the time control returns to the caller, `this.isExpired`
            // reflects the new state.
            void this.expire(cleanup);
          },
        },
        this._ctx,
      );
      this.runner = runner;
      const hooks = this.buildSpawnHooks(this.view());

      // Spawn loop. Drains the mailbox into each prompt; the Conversation
      // drives respawn — the runner does not loop internally (spec D1). Per
      // spec D2, the resolver fires on the FIRST settled outcome, even if
      // the loop continues with additional mailbox content.
      //
      // J.3b — `outcome` is now a discriminated union (settled / auth-error /
      // terminal-error). The switch is exhaustive; only `settled` continues
      // the inner loop based on mailbox content.
      let settledOutcome: { result: string | null } | null = null;
      let prompt = this.drainMailbox();
      let terminalError: string | null = null;
      let firstSettledFired = false;
      spawnLoop: while (true) {
        // Re-affirm 'running' after each inner-loop respawn. A teardown during
        // a prior iteration's await would have superseded us — bail before
        // touching state or re-spawning, deferring to the successor cycle.
        if (this.supersededSince(epoch)) return;
        this.setState('running');
        let outcome: SpawnOutcome;
        try {
          // Drive THIS cycle's own runner (captured local), never a re-read of
          // `this.runner` — which a successor cycle may have replaced.
          outcome = await runner.spawn(prompt, hooks);
        } catch (err) {
          // Catch-throw — re-queue piped so the next cycle re-delivers,
          // synthesize a terminal-error outcome for `recordSpawnOutcome` so
          // the abnormal-exit cap accounts for the throw the same way it
          // accounts for a returned terminal-error.
          this.requeuePipedOnAbnormalEnd();
          terminalError = err instanceof Error ? err.message : String(err);
          this.recordSpawnOutcome(
            { type: 'terminal-error', error: terminalError, outputSent: false },
            hooks.logEvent,
          );
          break spawnLoop;
        }

        switch (outcome.type) {
          case 'auth-error': {
            // Re-queue piped messages regardless of retry decision — they
            // hit a dead-token container and must either drive the retry or
            // land in the mailbox for the next cycle.
            this.requeuePipedOnAbnormalEnd();

            // Retry only on `invalid-credentials` (or undefined for backward
            // compat — legacy 401 path). `quota-exhausted`, `claude-unavailable`,
            // and `not-configured` fail fast: retrying won't fix them and the
            // runner has already emitted the typed user-facing fallback.
            const canRetry = outcome.reason === undefined || outcome.reason === 'invalid-credentials';
            if (canRetry && this.authRetries < MAX_AUTH_RETRIES) {
              this.authRetries++;
              hooks.logEvent?.(
                'warn',
                'auth',
                'retry',
                `Auth retry ${this.authRetries}/${MAX_AUTH_RETRIES}`,
                { conversationKey: this.key, context: { retryCount: this.authRetries, reason: outcome.reason } },
              );
              prompt = this.drainMailbox();
              continue spawnLoop;
            }

            // Fail-fast path (non-retryable reason): the runner already emitted
            // the typed fallback; just record the outcome and exit the loop.
            if (!canRetry) {
              hooks.logEvent?.(
                'warn',
                'auth',
                'fail_fast',
                `Claude unreachable (${outcome.reason}) — no retry`,
                { conversationKey: this.key, context: { reason: outcome.reason } },
              );
              terminalError = `claude_unreachable_${outcome.reason}`;
              this.recordSpawnOutcome(outcome, hooks.logEvent);
              break spawnLoop;
            }
            // Retries exhausted. Emit the user-facing fallback once, log the
            // structured exhaustion event, and route through the terminal-
            // error path (teardown + state → idle-no-runner). Emit-once is
            // by construction: the next spawn cycle starts with
            // `authRetries = 0` (re-initialized at runner construction), so
            // a subsequent auth failure would log/emit again from scratch —
            // which is correct, because that's a new user attempt.
            hooks.logEvent?.(
              'error',
              'auth',
              'retry_exhausted',
              `Auth retries exhausted after ${MAX_AUTH_RETRIES} attempts`,
              { conversationKey: this.key, context: { retryCount: this.authRetries } },
            );
            try {
              await runner.emitAuthExhausted();
            } catch (err) {
              logger.error(
                { scope: this.scope, key: this.key, err },
                'Conversation: emitAuthExhausted threw',
              );
            }
            terminalError = 'auth_retries_exhausted';
            this.recordSpawnOutcome(outcome, hooks.logEvent);
            break spawnLoop;
          }

          case 'terminal-error': {
            // Re-queue piped so the next spawn cycle (if any work arrives)
            // re-delivers. Mailbox is canonical.
            this.requeuePipedOnAbnormalEnd();
            this.recordSpawnOutcome(outcome, hooks.logEvent);
            terminalError = outcome.error;
            break spawnLoop;
          }

          case 'settled': {
            // First settled outcome fires the deliver-caller's resolver.
            // Skipped in expiring phase — the expire flow's finishExpire owns
            // resolver firing for any pending deliver. Also promotes phase
            // `new → active` on first successful spawn.
            this.recordSpawnOutcome(outcome, hooks.logEvent);
            if (!firstSettledFired && this._phase !== 'expiring') {
              this.fireResolver({ ok: true, result: outcome.result });
              firstSettledFired = true;
              if (this._phase === 'new') this.setPhase('active');
            }
            settledOutcome = { result: outcome.result };
            if (this.mailbox.length > 0) {
              prompt = this.drainMailbox();
              continue spawnLoop;
            }
            break spawnLoop;
          }
        }
      }

      // Ownership join. A teardown during `spawn()` revokes this cycle's
      // ownership (nulls runner/slot, bumps the epoch) and kicks a successor.
      // Every post-loop effect below — the terminal-error teardown, the
      // expiring resolver, clearing `pipedThisSpawn`, the clean settle's
      // `idle-with-runner`, and the evict — now belongs to that successor.
      // One check here keeps a stale cycle from tearing the successor down or
      // re-asserting liveness over reclaimed refs (the I2 phantom).
      if (this.supersededSince(epoch)) return;

      if (terminalError !== null) {
        // fireResolver inside _teardown is a no-op if the resolver was
        // already fired earlier in the inner loop (firstSettledFired).
        await this.handleTerminalError(terminalError);
        // Per spec §14.H Step 1: _teardown leaves state in 'idle-no-runner';
        // the outer while re-enters slot acquisition iff mailbox has work to
        // do. (Pre-Step-1, _teardown would speculatively setState awaiting-slot
        // and we'd continue on that signal instead.)
        if (this.state === 'idle-no-runner' && this.mailbox.length > 0) continue;
        return;
      }

      if (settledOutcome === null) return; // defensive — auth/terminal paths

      if (this._phase === 'expiring') {
        this.fireResolver({ ok: true, result: settledOutcome.result });
        await this.finishExpire();
        return;
      }

      // Clean spawn settle — the ownership join above already guaranteed this
      // cycle is current and not terminating, and there is no `await` between
      // it and here, so the liveness write is safe. Piped messages were
      // processed by the container; drop the replay buffer.
      this.pipedThisSpawn = [];
      this.setState('idle-with-runner');
      this.catalog.maybeEvictForWaiters(this);
      return;
    }
  }

  // =========================================================================
  // Internal: _teardown — chokepoint for runner+slot+state cleanup
  // =========================================================================

  /**
   * The chokepoint for tearing down runner + slot + state together. Every
   * cleanup path (yieldSlot, handleTerminalError, handleRunnerDiedInline,
   * finishExpire, hardExpire, shutdown, replaceInvalidatedRunner) routes
   * through this single method. The joint update happens atomically — the
   * synchronous prefix claims state + nulls refs before any await yields.
   *
   * Re-entrance is structural (Phase I.9): the first caller claims
   * `_teardownInFlight` with the in-flight Promise; concurrent callers
   * receive that same Promise back and await it instead of re-entering the
   * body. No double-teardown is possible by construction. Each await of the
   * returned Promise observes the same terminal state — the second caller
   * still sees the post-teardown state on resolution.
   *
   * (K.2 note: the prior `_shuttingDown` boolean used to coordinate the
   * shutdown loop is now `_phase === 'terminating'`; the inner loop checks
   * `isTerminating` instead.)
   */
  private _teardown(opts: TeardownOpts): Promise<void> {
    if (this._state === 'destroyed') return Promise.resolve();
    if (this._teardownInFlight !== null) return this._teardownInFlight;
    const p = this._teardownBody(opts);
    this._teardownInFlight = p;
    // Clear the in-flight slot on settle (success or throw). Async-detached
    // so the assignment doesn't observably reorder vs the caller's await.
    p.finally(() => {
      if (this._teardownInFlight === p) this._teardownInFlight = null;
    });
    return p;
  }

  private async _teardownBody(opts: TeardownOpts): Promise<void> {
    const runner = this.runner;
    const slot = this.slot;

    // Synchronous claim — state + refs nulled before any await yields.
    // setState fires onQueued(false) if we were in 'awaiting-slot' and the
    // target is a non-destroyed state; awaiting-slot → destroyed is silent
    // (the participant context is gone, no need to "unqueue" the UX).
    this.setState(opts.target);
    // Relinquish ownership: supersede any in-flight spawn cycle so its
    // post-`await` state writes become no-ops (see `supersededSince`). This is
    // the sole writer of runner/slot null, so the bump is co-located with
    // every ownership revocation by construction.
    this.spawnEpoch++;
    this.runner = null;
    this.slot = null;

    if (runner !== null) {
      try {
        // destroy() owns both the close-hint write and the SIGTERM —
        // `mode.kind === 'drain'` performs both with a bounded wait,
        // `'immediate'` skips straight to SIGTERM. The prior split
        // (`close()` here + immediate SIGTERM in destroy) was the
        // "graceful is a lie" bug: close fired but destroy didn't wait.
        await runner.destroy(opts.mode);
      } catch (err) {
        logger.error(
          { scope: this.scope, key: this.key, err },
          'Conversation._teardown: runner teardown threw',
        );
      }
    }

    if (slot !== null) {
      // Only the idle-no-runner branch has `skipDrain`; destroyed doesn't
      // need it (no successor takes our slot — releasing always drains).
      const skipDrain = opts.target === 'idle-no-runner' ? opts.skipDrain : false;
      slot.release({ skipDrain });
    }

    if (opts.target === 'destroyed' && opts.expireSideEffects === true) {
      this.store.expireConversation(this.key);
      this.emitBus({ kind: 'expiry-complete', view: this.view() });
    }

    if (opts.resolveWith !== undefined) {
      this.fireResolver(opts.resolveWith);
    }

    if (runner !== null) {
      this.emitBus({ kind: 'runner-removed', view: this.view() });
    }

    if (opts.target === 'destroyed') {
      // Re-affirm in case anything pre-empted the atomic claim. setState is
      // a no-op when from === to so this won't re-fire any hooks.
      this.setState('destroyed');
      this.catalog.unregister(this);
      return;
    }

    // idle-no-runner branch.
    // Bug A guard: if concurrent delivers pushed work into the mailbox
    // during the destroy await, drive a fresh spawn cycle now. `skipKick`
    // is set by callers that re-enter via their own loop (runSpawnCycle's
    // outer while) or that will kick themselves (deliver after pipe failure).
    //
    // State stays in 'idle-no-runner'; runSpawnCycle decides whether to
    // transition to 'awaiting-slot' based on the pool's response. See spec
    // §14.H Step 1.
    if (
      this._state === 'idle-no-runner' &&
      this.mailbox.length > 0 &&
      !this.isTerminating &&
      opts.skipKick !== true
    ) {
      void this.runSpawnCycle();
    }
  }

  // =========================================================================
  // Internal: outcome handlers
  // =========================================================================

  /** Single home for the abnormal-exit cap. One writer (this method), one
   *  effective reader (the outer while in `runSpawnCycle`, indirectly, via
   *  `mailbox.length` — which this method clears on cap hit). Caller in
   *  `runSpawnCycle` invokes once per spawn outcome; no inline counter
   *  arithmetic at call sites. New outcome variants force a compile error
   *  here (exhaustive switch on `SpawnOutcome.type`), so contributors can't
   *  silently bypass the cap.
   *
   *  SIDE EFFECT: mutates `consecutiveAbnormalExits`. On cap hit also
   *  clears `mailbox` and `pipedThisSpawn` — the structural break that
   *  stops the outer while loop from re-entering slot acquisition. Logged
   *  via `logEvent` so the cap hit is auditable in agent.db. */
  private recordSpawnOutcome(
    outcome: SpawnOutcome,
    logEvent: SpawnHooks['logEvent'],
  ): void {
    switch (outcome.type) {
      case 'settled':
        this.consecutiveAbnormalExits = 0;
        this.firstAbnormalExitAt = null;
        return;
      case 'terminal-error':
      case 'auth-error': {
        // auth-error here is only the *exhausted* branch — the retry path
        // in runSpawnCycle continues `spawnLoop` before reaching us.
        if (this.consecutiveAbnormalExits === 0) {
          this.firstAbnormalExitAt = Date.now();
        }
        this.consecutiveAbnormalExits++;
        if (this.consecutiveAbnormalExits >= MAX_ABNORMAL_EXITS) {
          this.mailbox = [];
          this.pipedThisSpawn = [];
          logEvent?.(
            'error',
            'conversation',
            'abnormal_exit_cap_hit',
            `Conversation closed after ${MAX_ABNORMAL_EXITS} consecutive abnormal spawn outcomes`,
            {
              conversationKey: this.key,
              context: { count: this.consecutiveAbnormalExits },
            },
          );
          // Panic button #5: escalate to agent-scope halt iff the burst
          // was fast enough. `firstAbnormalExitAt` is set on the first
          // increment above, so it's non-null whenever the cap fires.
          // Slow successive failures still close the conversation via
          // the cap above, but don't halt the whole agent.
          const firstAt = this.firstAbnormalExitAt ?? Date.now();
          const halted = panicRegistry.recordAbnormalExitBurst(
            this.scope,
            firstAt,
            this.consecutiveAbnormalExits,
          );
          if (halted) {
            logEvent?.(
              'error',
              'conversation',
              'panic_halt',
              `Agent halted by panic registry (${halted.button})`,
              {
                conversationKey: this.key,
                context: {
                  button: halted.button,
                  reason: halted.reason,
                  durationMs: halted.until - halted.haltedAt,
                  scope: this.scope,
                },
              },
            );
          }
        }
        return;
      }
    }
  }

  private async handleTerminalError(errMsg: string): Promise<void> {
    // Immediate — the spawn loop already returned a terminal-error
    // outcome, meaning the container has exited or is exiting. There's
    // no in-flight work for drain to preserve.
    if (this._phase === 'expiring') {
      await this._teardown({
        target: 'destroyed',
        mode: { kind: 'immediate' },
        expireSideEffects: true,
        resolveWith: { ok: false, error: errMsg },
        skipKick: true,
      });
      return;
    }
    await this._teardown({
      target: 'idle-no-runner',
      mode: { kind: 'immediate' },
      resolveWith: { ok: false, error: errMsg },
      // Caller is runSpawnCycle; its outer while will pick up the
      // 'idle-no-runner' state and re-enter slot acquisition.
      skipKick: true,
    });
  }

  /**
   * Pipe failure: tear down asynchronously without blocking the caller. The
   * synchronous prefix of `_teardown` claims state = 'idle-no-runner' and
   * nulls refs; the destroy/release awaits run in the background. Caller
   * (deliver / expire) continues immediately, pushes its message to the
   * mailbox, and calls `beginSpawnCycle`.
   */
  private handleRunnerDiedInline(): void {
    // Immediate — process is already null/dead; mode is structurally
    // moot here, but `immediate` documents the absence of drain work.
    void this._teardown({
      mode: { kind: 'immediate' },
      target: 'idle-no-runner',
      skipKick: true,
    });
  }

  /** Runner reported `lifecycle/idle`. Self-eviction policy lives in the
   *  catalog — we just notify. `epoch` is the spawn cycle that installed this
   *  runner (carried by the `onIdle` closure); a late idle report from a runner
   *  whose cycle was already superseded by a teardown is ignored, so it can't
   *  re-assert `idle-with-runner` over reclaimed refs. */
  private handleRunnerIdle(epoch: number): void {
    if (this.supersededSince(epoch)) return;
    if (this._state === 'running') {
      this.setState('idle-with-runner');
      this.catalog.maybeEvictForWaiters(this);
    }
    // Other states: idle signal arrived after we already moved on — ignore.
  }

  /** Expire-cleanup turn just completed. Finalize destruction. */
  private async finishExpire(): Promise<void> {
    // Immediate — the cleanup turn already ran to completion; there's
    // no in-flight work left for drain to preserve.
    await this._teardown({
      mode: { kind: 'immediate' },
      target: 'destroyed',
      expireSideEffects: true,
    });
  }

  /** Hard-expire path (cleanup === null): no cleanup turn, immediate destroy. */
  private async hardExpire(): Promise<void> {
    this.setPhase('expiring');
    // Drain — TTL fire can race with an active turn. Drain lets that
    // turn finalize before we tear down.
    await this._teardown({
      mode: { kind: 'drain', timeoutMs: DEFAULT_DRAIN_TIMEOUT_MS },
      target: 'destroyed',
      expireSideEffects: true,
      resolveWith: { ok: false, error: 'Conversation expired' },
    });
  }

  // =========================================================================
  // Internal: setState — single chokepoint for state writes
  // =========================================================================

  /**
   * The single write site for `_state`. All transitions in this class route
   * through here so observers tied to state transitions are notified by
   * construction rather than from scattered code paths.
   *
   * Bus emits:
   * - `queued{active:true}` on entering `'awaiting-slot'`. Per Phase L,
   *   `'awaiting-slot'` means FIFO-queued (not "any wait") — the catalog's
   *   swap-eviction path stays in `'idle-no-runner'` while awaiting, so
   *   `queued` does not fire for transient sub-millisecond pressure
   *   resolution. The catalog's `markSwapFellThrough()` bridge is the
   *   only other entry path into `'awaiting-slot'`, used when a swap loses
   *   its post-yield retry race and falls through to FIFO.
   * - `queued{active:false}` on leaving `'awaiting-slot'` to any non-
   *   `'destroyed'` state. The `→ 'destroyed'` edge is silent: the
   *   participant context is going away and there is no UX to "unqueue."
   * - `state{from,to}` unconditionally on every non-self transition,
   *   emitted AFTER the queued event so subscribers observing both see
   *   them in a consistent order.
   *
   * Side-effect-driven events (`runner-removed`, `expiry-complete`) keep
   * their post-async fire-points inside `_teardown` — they depend on
   * teardown-specific information (a runner was present, expire was
   * requested) that isn't part of the from→to tuple. Both go through the
   * same `emitBus` chokepoint so all bus dispatch is centralized.
   *
   * Self-transitions (`from === target`) short-circuit. Defensive re-
   * affirms (the inner spawn loop, the post-await re-affirm of `destroyed`
   * in `_teardown`) are safe to call unconditionally without re-emitting.
   */
  private setState(target: ConversationState): void {
    const from = this._state;
    if (from === target) return;
    this._state = target;
    if (target === 'awaiting-slot') {
      // from cannot be 'awaiting-slot' here (handled by from === target above).
      this.emitBus({ kind: 'queued', view: this.view(), active: true });
    } else if (from === 'awaiting-slot' && target !== 'destroyed') {
      this.emitBus({ kind: 'queued', view: this.view(), active: false });
    }
    this.emitBus({ kind: 'state', view: this.view(), from, to: target });
  }

  /**
   * The single write site for `_phase`. Mirrors `setState` for D10
   * chokepoint discipline. Phase is monotone forward — see
   * `ConversationPhase` in `types.ts` for the transition table.
   * Backward transitions are rejected (logged + no-op) so the spec
   * invariant holds. `setPhase('terminating')` from any non-terminating
   * phase is always allowed (K.2 folded `_shuttingDown` into the phase
   * union; shutdown must always succeed).
   *
   * Self-transitions short-circuit. Bus emits a typed `phase` event on
   * every accepted transition.
   */
  private setPhase(target: ConversationPhase): void {
    const from = this._phase;
    if (from === target) return;
    const monotoneOk =
      (from === 'new' && (target === 'active' || target === 'expiring' || target === 'terminating')) ||
      (from === 'active' && (target === 'expiring' || target === 'terminating')) ||
      (from === 'expiring' && target === 'terminating');
    if (!monotoneOk) {
      logger.error(
        { scope: this.scope, key: this.key, from, target },
        'setPhase: rejected non-monotone transition',
      );
      return;
    }
    this._phase = target;
    this.emitBus({ kind: 'phase', view: this.view(), from, to: target });
  }

  /** Single dispatch site onto the event bus. The bus itself wraps each
   *  subscriber in try/catch, but we additionally guard the emit call so a
   *  misbehaving bus implementation can't break the state machine. */
  private emitBus(evt: ConversationEvent): void {
    try {
      this.eventBus.emit(evt);
    } catch (err) {
      logger.error(
        { scope: this.scope, key: this.key, kind: evt.kind, err },
        'Conversation.emitBus: eventBus.emit threw',
      );
    }
  }

  // =========================================================================
  // Internal: resolver + mailbox helpers
  // =========================================================================

  private installResolver(): Promise<RouteResult> {
    if (this.resolver !== null) {
      // Defensive: a resolver is already pending. Return a fresh resolved
      // promise so the caller doesn't deadlock — synthetic OK is the
      // documented contract.
      return Promise.resolve({ ok: true, result: null });
    }
    return new Promise<RouteResult>((resolve) => {
      this.resolver = resolve;
    });
  }

  private fireResolver(result: RouteResult): void {
    const r = this.resolver;
    if (r === null) return;
    this.resolver = null;
    try {
      r(result);
    } catch (err) {
      logger.error(
        { scope: this.scope, key: this.key, err },
        'Conversation.fireResolver: resolve threw',
      );
    }
  }

  private drainMailbox(): PendingMessage[] {
    const drained = this.mailbox;
    this.mailbox = [];
    return drained;
  }

  /** Move pipe-side-effected messages from `pipedThisSpawn` back to the head
   *  of the mailbox so the next spawn cycle re-delivers them. Caller decides
   *  WHEN to invoke (auth-retry, terminal error, catch-throw) — this is the
   *  mechanism. Idempotent: empty buffer is a no-op.
   *
   *  Spec G.4 — Conversation owns the abnormal-end replay; the runner no
   *  longer carries a parallel auth-error replay buffer. Mailbox is canonical
   *  (spec D1). Duplicate-on-replay is tolerated per the soft failure mode. */
  private requeuePipedOnAbnormalEnd(): void {
    if (this.pipedThisSpawn.length === 0) return;
    this.mailbox.unshift(...this.pipedThisSpawn);
    this.pipedThisSpawn = [];
  }

  private touchLastActive(): void {
    this._lastActive = new Date().toISOString();
  }
}
