/**
 * Conversations façade — the public surface that external callers see.
 *
 * Composes `ConversationCatalog` + `ConversationTtl`. Owns no state of its
 * own; routes by `(scope, key)` to the catalog's typed conversation refs.
 *
 * Per-scope binding lives here: each scope (an agent folder, a console, a
 * server-scope console) registers a `RunnerFactory<TCtx>` + typed
 * `ConversationCallbacks<TCtx>` + per-agent `AgentStateStore` once.
 * Subsequent `deliver<TCtx>(scope, key, ...)` calls look up the binding,
 * pass ctx to the factory, and getOrCreate via the catalog.
 *
 * The TCtx generic flows through `registerScope` / `deliver` / `scheduleTtl`
 * / `get` / `inScope` so each consumer's per-conversation context type is
 * checked at the call site. Internally the binding is stored as
 * `ConversationScopeBinding<unknown>` and a single cast happens at the
 * `registerScope<TCtx>` boundary (deferred-replay pattern).
 */
import type { AgentStateStore } from '../agent/state-store.js';
import type { RouteResult } from '../types.js';
import { logger } from '../logger.js';
import type {
  BuildSpawnHooks,
  Conversation,
  ConversationView,
  DeliverOpts,
} from './conversation.js';
import type { ConversationCatalog } from './catalog.js';
import type { ConversationTtl } from './ttl.js';
import type { RunnerFactory } from './runner.js';
import type { IdleTimeoutMeta } from './types.js';
import type { ConversationEventBus, ConversationEventKind } from './event-bus.js';

export interface ConversationScopeBinding<TCtx = unknown> {
  factory: RunnerFactory<TCtx>;
  /** Per-spawn hooks factory. Collapsed from the prior
   *  `ConversationCallbacks` interface (which carried only this field) into
   *  a direct function type. Observation lives on the event bus —
   *  hosts subscribe via `Conversations.subscribeScope`. */
  buildSpawnHooks: BuildSpawnHooks<TCtx>;
  store: AgentStateStore;
}

/** Typed per-scope event handlers. Hosts populate only the kinds they care
 *  about; the façade's `subscribeScope` derives the bus subscription's `kinds`
 *  filter from which fields are present, so absent handlers don't pay dispatch
 *  cost. Each handler receives a `ConversationView<TCtx>` already narrowed to
 *  the scope's typed ctx — the cast is performed once inside the façade. */
export interface ConversationScopeHandlers<TCtx> {
  onQueued?: (view: ConversationView<TCtx>, active: boolean) => void;
  onRunnerRemoved?: (view: ConversationView<TCtx>) => void;
  onExpiryComplete?: (view: ConversationView<TCtx>) => void;
}

export interface Conversations {
  /** Process-wide event bus for transition observation. Hosts subscribe with
   *  a `scope` filter at scope-register time and dispose at scope-unregister.
   *  This is the sole observation surface for queue UX,
   *  runner removal, and expiry side-effects. */
  readonly eventBus: ConversationEventBus;

  // Scope binding
  registerScope<TCtx>(scope: string, binding: ConversationScopeBinding<TCtx>): void;
  unregisterScope(scope: string): Promise<void>;

  /** Typed event-bus subscription scoped to a single host's `scope`. Derives
   *  the bus `kinds` filter from which handlers are populated, narrows views
   *  to `ConversationView<TCtx>` once at the façade boundary, and returns a
   *  disposer the host calls at shutdown. Closes the duplication between the
   *  three host bus subscriptions that ship the same shape. */
  subscribeScope<TCtx>(
    scope: string,
    handlers: ConversationScopeHandlers<TCtx>,
  ): () => void;

  // Message routing — ctx is required so the factory closure always has the
  // data it needs to construct a runner. Internal re-delivers (mid-spawn
  // hook shims) may bypass the façade and call `Conversation.deliver`
  // directly with no ctx; the existing per-conv ctx is preserved.
  deliver<TCtx>(
    scope: string,
    key: string,
    text: string,
    ctx: TCtx,
    opts?: DeliverOpts,
  ): Promise<RouteResult>;

  // Lifecycle
  expire(scope: string, key: string, cleanup?: string | null): Promise<void>;
  invalidate(scope: string, key: string): void;
  invalidateScope(scope: string): void;

  // Inspection
  get<TCtx>(scope: string, key: string): ConversationView<TCtx> | undefined;
  has(scope: string, key: string): boolean;
  inScope<TCtx>(scope: string): Iterable<ConversationView<TCtx>>;
  /** Like `inScope` but skips expired views (phase === 'expiring' — cleanup
   *  turn in progress or imminent teardown). The chokepoint for "give me
   *  the conversations that are still answering work" — closes the
   *  `for (view of inScope) if (view.isExpired) continue` boilerplate that
   *  shipped at every consumer pre-I.5. */
  inScopeActive<TCtx>(scope: string): Iterable<ConversationView<TCtx>>;

  // TTL — ctx (optional) is stored on the conversation so a later TTL fire
  // has the data it needs even if no deliver has happened yet.
  scheduleTtl<TCtx>(
    scope: string,
    key: string,
    meta: IdleTimeoutMeta,
    delayMs: number,
    ctx?: TCtx,
  ): boolean;
  cancelTtl(scope: string, key: string): void;
  peekTtl(scope: string, key: string): IdleTimeoutMeta | undefined;

  // Shutdown
  shutdownAll(): Promise<void>;
}

/**
 * Test-only escape hatch (J.4b). Production code reaches the conversation
 * exclusively through the typed `ConversationView` returned by `get()` —
 * `view.ref` was removed from the public interface so a misnamed reach-
 * through can't pass typecheck. Tests that need the underlying
 * `Conversation` (state inspection, manual transitions) cast the façade to
 * `ConversationsTestAccess` and call `conversations[CONVERSATION_TEST_ACCESS](
 *  scope, key)`.
 *
 * Symbol-keyed property: doesn't appear in property-name auto-complete, can't
 * be hit by structural typing, and the cast at the test boundary is loud
 * enough that a future ESLint rule (or grep audit) finds every use easily.
 */
export const CONVERSATION_TEST_ACCESS = Symbol('conversation-test-access');

export interface ConversationsTestAccess {
  [CONVERSATION_TEST_ACCESS](scope: string, key: string): Conversation | undefined;
}

export class ConversationsImpl implements Conversations, ConversationsTestAccess {
  private readonly catalog: ConversationCatalog;
  private readonly ttl: ConversationTtl;
  readonly eventBus: ConversationEventBus;
  private scopes = new Map<string, ConversationScopeBinding<unknown>>();

  constructor(opts: {
    catalog: ConversationCatalog;
    ttl: ConversationTtl;
    eventBus: ConversationEventBus;
  }) {
    this.catalog = opts.catalog;
    this.ttl = opts.ttl;
    this.eventBus = opts.eventBus;
  }

  // =========================================================================
  // Scope binding
  // =========================================================================

  registerScope<TCtx>(scope: string, binding: ConversationScopeBinding<TCtx>): void {
    // The binding's factory + callbacks are typed on TCtx at the call site;
    // here we erase the parameter and store as ScopeBinding<unknown>. The
    // catalog hands the stored factory ctx values typed as `unknown`; the
    // factory closure narrows internally (TS-typed inside the consumer).
    this.scopes.set(scope, binding as ConversationScopeBinding<unknown>);
  }

  async unregisterScope(scope: string): Promise<void> {
    this.scopes.delete(scope);
    await this.catalog.shutdownScope(scope);
  }

  subscribeScope<TCtx>(
    scope: string,
    handlers: ConversationScopeHandlers<TCtx>,
  ): () => void {
    const kinds: ConversationEventKind[] = [];
    if (handlers.onQueued) kinds.push('queued');
    if (handlers.onRunnerRemoved) kinds.push('runner-removed');
    if (handlers.onExpiryComplete) kinds.push('expiry-complete');
    // Empty handlers — return a no-op disposer rather than registering a
    // dead subscription that the bus would still iterate.
    if (kinds.length === 0) return () => {};
    // The view cast is the deferred-replay pattern:
    // the `scope` filter guarantees every emitted event came from a
    // Conversation registered under this scope's typed binding, so
    // re-narrowing `ConversationView<unknown>` to `<TCtx>` is sound.
    return this.eventBus.subscribe({ scope, kinds }, (evt) => {
      const view = evt.view as ConversationView<TCtx>;
      switch (evt.kind) {
        case 'queued':
          handlers.onQueued?.(view, evt.active);
          return;
        case 'runner-removed':
          handlers.onRunnerRemoved?.(view);
          return;
        case 'expiry-complete':
          handlers.onExpiryComplete?.(view);
          return;
      }
    });
  }

  // =========================================================================
  // Message routing
  // =========================================================================

  async deliver<TCtx>(
    scope: string,
    key: string,
    text: string,
    ctx: TCtx,
    opts?: DeliverOpts,
  ): Promise<RouteResult> {
    const binding = this.scopes.get(scope);
    if (binding === undefined) {
      logger.warn({ scope, key }, 'Conversations.deliver: unknown scope');
      return { ok: false, error: `Unknown scope: ${scope}` };
    }
    const conv = this.catalog.getOrCreate({
      scope,
      conversationKey: key,
      factory: binding.factory,
      buildSpawnHooks: binding.buildSpawnHooks,
      store: binding.store,
    });
    return conv.deliver(text, ctx, opts);
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async expire(
    scope: string,
    key: string,
    cleanup: string | null = null,
  ): Promise<void> {
    const conv = this.catalog.get(scope, key);
    if (conv === undefined) return;
    await conv.expire(cleanup);
  }

  invalidate(scope: string, key: string): void {
    const conv = this.catalog.get(scope, key);
    if (conv !== undefined) conv.invalidate();
  }

  invalidateScope(scope: string): void {
    for (const conv of this.catalog.inScope(scope)) {
      conv.invalidate();
    }
  }

  // =========================================================================
  // Inspection
  // =========================================================================

  get<TCtx>(scope: string, key: string): ConversationView<TCtx> | undefined {
    const conv = this.catalog.get(scope, key);
    return conv === undefined ? undefined : conv.view<TCtx>();
  }

  has(scope: string, key: string): boolean {
    return this.catalog.has(scope, key);
  }

  *inScope<TCtx>(scope: string): IterableIterator<ConversationView<TCtx>> {
    for (const conv of this.catalog.inScope(scope)) {
      yield conv.view<TCtx>();
    }
  }

  *inScopeActive<TCtx>(scope: string): IterableIterator<ConversationView<TCtx>> {
    for (const conv of this.catalog.inScope(scope)) {
      if (conv.isExpired) continue;
      yield conv.view<TCtx>();
    }
  }

  /** J.4b — test-only access to the underlying Conversation. Symbol-keyed so
   *  it can't be hit by structural typing or property-name autocomplete. */
  [CONVERSATION_TEST_ACCESS](scope: string, key: string): Conversation | undefined {
    return this.catalog.get(scope, key);
  }

  // =========================================================================
  // TTL
  // =========================================================================

  /**
   * Schedule (or replace) the idle-timeout timer for `(scope, key)`. If the
   * Conversation doesn't exist yet, materialize it in the `idle-no-runner`
   * state — boot-time TTL restoration and any other "schedule before first
   * deliver" path doesn't need a separate `ensureConversation` call. Returns
   * `false` only if the scope is unknown.
   *
   * `ctx` (optional) is stored on the Conversation so the TTL's cleanup spawn
   * has the data the factory needs even if no deliver has happened yet.
   */
  scheduleTtl<TCtx>(
    scope: string,
    key: string,
    meta: IdleTimeoutMeta,
    delayMs: number,
    ctx?: TCtx,
  ): boolean {
    const binding = this.scopes.get(scope);
    if (binding === undefined) {
      logger.warn({ scope, key }, 'Conversations.scheduleTtl: unknown scope');
      return false;
    }
    const conv = this.catalog.getOrCreate({
      scope,
      conversationKey: key,
      factory: binding.factory,
      buildSpawnHooks: binding.buildSpawnHooks,
      store: binding.store,
    });
    conv.setCtx(ctx);
    this.ttl.scheduleTtl(conv, meta, delayMs);
    return true;
  }

  cancelTtl(scope: string, key: string): void {
    const conv = this.catalog.get(scope, key);
    if (conv !== undefined) this.ttl.cancelTtl(conv);
  }

  peekTtl(scope: string, key: string): IdleTimeoutMeta | undefined {
    const conv = this.catalog.get(scope, key);
    return conv === undefined ? undefined : this.ttl.peekMeta(conv);
  }

  // =========================================================================
  // Shutdown
  // =========================================================================

  async shutdownAll(): Promise<void> {
    this.scopes.clear();
    await this.catalog.shutdownAll();
  }

  /**
   * Test-only: synchronously clear all scope bindings and reset the
   * underlying catalog/pool/ttl. Used by per-suite `beforeEach` to start
   * from a clean slate without awaiting destroyer chains.
   */
  _reset(): void {
    this.scopes.clear();
    this.catalog._reset();
  }
}
