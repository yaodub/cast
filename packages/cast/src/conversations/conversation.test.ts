/**
 * Conversation — runtime identity per (scope, key). Tests cover the spec §2
 * state machine, resolver contract (D2), mailbox source-of-truth (D1), and
 * the structural bug-class regressions:
 *
 * - B1 (captured-entry-stale across await): the (scope, key, runner) tuple is
 *   replaced by a stable Conversation ref; impossible to capture stale state.
 * - O7 (resolver cross-talk): the resolver lives on the Conversation ref, not
 *   keyed by a string that could collide.
 * - scenario-3 (deliver-to-paged-out): no separate "paged-out" state; idle-no-
 *   runner with mailbox just re-spawns.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { _resetPanicRegistryForTest } from '../lib/panic-registry.js';

// Panic registry is a process-wide singleton; reset between tests so
// accumulated spawn-rate accounting doesn't bleed from one case to the
// next (one test's 19 spawns + the next test's 1 spawn would otherwise
// trip the 20/min threshold).
beforeEach(() => {
  _resetPanicRegistryForTest();
});


vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  Conversation,
  type ConversationCatalogRef,
} from './conversation.js';
import type { SlotResult } from './catalog.js';
import { SlotPool, type Slot } from './slot-pool.js';
import { ConversationTtl } from './ttl.js';
import { ConversationEventBus, type ConversationEvent } from './event-bus.js';
import type {
  Runner,
  RunnerFactory,
  SpawnOutcome,
  PendingMessage,
  SpawnHooks,
  DeliverKind,
  TeardownMode,
} from './runner.js';

/** Test-only state used by the mock runner. Production Runner interface
 *  no longer exposes state — Conversation never reads it. */
type MockRunnerState = 'fresh' | 'running' | 'idle' | 'closing';
import { AgentStateStore } from '../agent/state-store.js';

// =============================================================================
// Test fixtures
// =============================================================================

interface MockRunner extends Runner {
  /** Test-only state used by manualSpawn timing + assertions. Production
   *  Runner interface no longer exposes this. */
  readonly state: MockRunnerState;
  spawnSpy: Mock<(prompt: PendingMessage[], hooks: SpawnHooks) => void>;
  pipeSpy: Mock<(text: string) => void>;
  /** Captures the `opts` arg passed to `pipeMessage`. Separate from `pipeSpy`
   *  so existing assertions on text-only matching stay valid. The bug class
   *  that motivated this spy: `Conversation.expire` must pass
   *  `{ kind: 'lifecycle' }` so the runner wraps the cleanup text in
   *  `<cast:lifecycle>` and flips its internal phase. */
  pipeOptsSpy: Mock<(opts: { kind?: DeliverKind; attrs?: Record<string, string>; rawText?: string } | undefined) => void>;
  closeSpy: Mock<() => void>;
  destroySpy: Mock<(mode: TeardownMode) => void>;
  emitAuthExhaustedSpy: Mock<() => void>;
  _resolveSpawn: ((o: SpawnOutcome) => void) | null;
  _setIdle: () => void;
}

interface MockRunnerOpts {
  /** If set, spawn() blocks until manually resolved via runner._resolveSpawn(). */
  manualSpawn?: boolean;
  /** Default outcome if spawn auto-resolves. */
  spawnOutcome?: SpawnOutcome;
  /** Whether pipeMessage returns true (default) or false. */
  pipeOk?: boolean;
  /** Initial ccSessionId. */
  ccSessionId?: string;
  /** onIdle callback supplied by Conversation. */
  onIdle?: () => void;
}

function makeMockRunner(opts: MockRunnerOpts = {}): MockRunner {
  const pipeOk = opts.pipeOk ?? true;
  const spawnOutcome: SpawnOutcome =
    opts.spawnOutcome ?? { type: 'settled', result: null, outputSent: true };
  let resolveSpawnFn: ((o: SpawnOutcome) => void) | null = null;
  let state: MockRunnerState = 'fresh';
  let destroyed = false;
  let manualConsumed = false;

  const runner: MockRunner = {
    spawnSpy: vi.fn<(prompt: PendingMessage[], hooks: SpawnHooks) => void>(),
    pipeSpy: vi.fn<(text: string) => void>(),
    pipeOptsSpy: vi.fn<(opts: { kind?: DeliverKind; attrs?: Record<string, string>; rawText?: string } | undefined) => void>(),
    closeSpy: vi.fn<() => void>(),
    destroySpy: vi.fn<(mode: TeardownMode) => void>(),
    emitAuthExhaustedSpy: vi.fn<() => void>(),
    _resolveSpawn: null,
    _setIdle: () => {
      state = 'idle';
      opts.onIdle?.();
    },
    async spawn(prompt: PendingMessage[], hooks: SpawnHooks): Promise<SpawnOutcome> {
      runner.spawnSpy(prompt, hooks);
      state = 'running';
      // manualSpawn is one-shot: first call blocks until resolved via
      // `_resolveSpawn`; subsequent calls auto-resolve. Tests use this to
      // freeze the first spawn while delivering more messages, then let the
      // respawn cycle settle naturally.
      if (opts.manualSpawn && !manualConsumed) {
        manualConsumed = true;
        return new Promise<SpawnOutcome>((resolve) => {
          resolveSpawnFn = resolve;
          runner._resolveSpawn = (o) => {
            resolveSpawnFn?.(o);
            resolveSpawnFn = null;
          };
        });
      }
      state = 'idle';
      return spawnOutcome;
    },
    pipeMessage(
      text: string,
      _attachments?: unknown,
      opts?: { kind?: DeliverKind; attrs?: Record<string, string>; rawText?: string },
    ): boolean {
      runner.pipeSpy(text);
      runner.pipeOptsSpy(opts);
      return pipeOk;
    },
    close(): void {
      runner.closeSpy();
      state = 'closing';
    },
    async destroy(mode: TeardownMode): Promise<boolean> {
      runner.destroySpy(mode);
      destroyed = true;
      state = 'closing';
      return true;
    },
    async emitAuthExhausted(): Promise<void> {
      runner.emitAuthExhaustedSpy();
    },
    get state(): MockRunnerState {
      return state;
    },
    get ccSessionId(): string | undefined {
      return opts.ccSessionId;
    },
    get isDestroyed(): boolean {
      return destroyed;
    },
    get activeProcess() {
      return null;
    },
    get activeContainerName() {
      return null;
    },
  };
  return runner;
}

interface ConvFixture {
  conv: Conversation;
  runner: MockRunner | null;
  factorySpy: ReturnType<typeof vi.fn>;
  pool: SlotPool;
  ttl: ConversationTtl;
  store: AgentStateStore;
  eventBus: ConversationEventBus;
  busSpies: {
    buildSpawnHooks: ReturnType<typeof vi.fn>;
    onRunnerRemoved: ReturnType<typeof vi.fn>;
    onExpiryComplete: ReturnType<typeof vi.fn>;
    onQueued: ReturnType<typeof vi.fn>;
  };
  catalogSpies: {
    acquireSlot: ReturnType<typeof vi.fn>;
    maybeEvictForWaiters: ReturnType<typeof vi.fn>;
    unregister: ReturnType<typeof vi.fn>;
  };
  /** Manually trigger runner.onIdle (only meaningful if runner is mid-spawn). */
  triggerIdle: () => void;
  /** Manually resolve a manualSpawn runner. */
  resolveSpawn: (outcome: SpawnOutcome) => void;
}

interface MakeConvOpts {
  scope?: string;
  conversationKey?: string;
  capacity?: number;
  /** Override the factory to return a custom runner per call. */
  runnerSequence?: MockRunner[];
  runnerOpts?: MockRunnerOpts;
  /** Make the FIRST factory call throw with this message; subsequent calls
   *  construct normally. Exercises spawn-cycle containment of construction
   *  throws (the slot is already claimed when the factory runs). */
  factoryThrowsOnce?: string;
  /** Pre-existing ccSessionId in the store. */
  seedCcSessionId?: string;
  /** Override the async pressure-path of acquireSlot. The sync fast-path
   *  (capacity available) always runs unchanged via `pool.tryAcquire()`. */
  acquirePressureOverride?: (conv: Conversation, pool: SlotPool) => Promise<Slot>;
}

function makeStore(): AgentStateStore {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-conv-test-'));
  return new AgentStateStore(tmpDir);
}

function makeConvFixture(opts: MakeConvOpts = {}): ConvFixture {
  const scope = opts.scope ?? 'agent:test';
  const conversationKey = opts.conversationKey ?? 'default|cli:user';
  const pool = new SlotPool(opts.capacity ?? 2);
  const ttl = new ConversationTtl();
  const store = makeStore();
  const eventBus = new ConversationEventBus();

  if (opts.seedCcSessionId !== undefined) {
    store.upsertConversation(conversationKey, {
      channelName: 'default',
      participant: 'cli:user',
      qualifier: null,
      ccSessionId: opts.seedCcSessionId,
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      ttl: null,
      status: 'active',
      summary: null,
    });
  }

  let currentRunner: MockRunner | null = null;
  let idleHook: (() => void) | undefined;
  let pendingSpawnResolver: ((o: SpawnOutcome) => void) | null = null;

  const sequence = opts.runnerSequence ?? [];
  let seqIdx = 0;
  let factoryThrew = false;

  const factorySpy = vi.fn((factoryOpts) => {
    if (opts.factoryThrowsOnce !== undefined && !factoryThrew) {
      factoryThrew = true;
      throw new Error(opts.factoryThrowsOnce);
    }
    idleHook = factoryOpts.onIdle;
    let runner: MockRunner;
    if (sequence.length > 0) {
      runner = sequence[seqIdx++ % sequence.length];
    } else {
      runner = makeMockRunner({ ...opts.runnerOpts, onIdle: factoryOpts.onIdle });
    }
    currentRunner = runner;
    // Capture the resolver for manualSpawn runners so tests can drive timing.
    // The inner spawn's Promise executor runs synchronously when originalSpawn
    // is called, so `_resolveSpawn` is set before we await.
    const originalSpawn = runner.spawn.bind(runner);
    runner.spawn = async (prompt, hooks) => {
      const promise = originalSpawn(prompt, hooks);
      if (runner._resolveSpawn !== null) {
        pendingSpawnResolver = runner._resolveSpawn;
      }
      return await promise;
    };
    return runner;
  });

  // The legacy `ConversationCallbacks` fields
  // (`onQueued` / `onRunnerRemoved` / `onExpiryComplete`) no longer exist —
  // the Conversation only fans transitions through `ConversationEventBus`.
  // To keep the existing assertions readable, the fixture installs a bus
  // subscriber that fans events back into the spies the tests already use.
  // The contract under test is unchanged: spy is called with the same args
  // the old callback received.
  const busSpies = {
    buildSpawnHooks: vi.fn(() => ({} as SpawnHooks)),
    onRunnerRemoved: vi.fn(),
    onExpiryComplete: vi.fn(),
    onQueued: vi.fn(),
  };
  const buildSpawnHooks = busSpies.buildSpawnHooks;
  eventBus.subscribe({}, (evt) => {
    if (evt.kind === 'queued') busSpies.onQueued(evt.view, evt.active);
    else if (evt.kind === 'runner-removed') busSpies.onRunnerRemoved(evt.view);
    else if (evt.kind === 'expiry-complete') busSpies.onExpiryComplete(evt.view);
  });

  const catalogSpies = {
    acquireSlot: vi.fn((conv: Conversation): SlotResult => {
      const fast = pool.tryAcquire();
      if (fast !== null) return { kind: 'sync', slot: fast };
      const promise = opts.acquirePressureOverride
        ? opts.acquirePressureOverride(conv, pool)
        : pool.acquire(conv);
      // Test fixture treats the pressure path as FIFO; tests that exercise
      // the swap-vs-queue split use the real ConversationCatalog directly.
      return { kind: 'queued', promise };
    }),
    maybeEvictForWaiters: vi.fn(),
    unregister: vi.fn(),
  };

  const catalog: ConversationCatalogRef = {
    acquireSlot: catalogSpies.acquireSlot,
    maybeEvictForWaiters: catalogSpies.maybeEvictForWaiters,
    unregister: catalogSpies.unregister,
  };

  const conv = new Conversation({
    scope,
    conversationKey,
    factory: factorySpy as RunnerFactory,
    catalog,
    store,
    ttl,
    buildSpawnHooks,
    eventBus,
  });

  return {
    conv,
    get runner(): MockRunner | null {
      return currentRunner;
    },
    factorySpy,
    pool,
    ttl,
    store,
    eventBus,
    busSpies,
    catalogSpies,
    triggerIdle: () => idleHook?.(),
    resolveSpawn: (outcome: SpawnOutcome) => pendingSpawnResolver?.(outcome),
  } as unknown as ConvFixture;
}

/** Wait for all microtasks to settle so async state machine work completes. */
async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// =============================================================================
// Tests — deliver from idle-no-runner (spawn cycle)
// =============================================================================

describe('Conversation — deliver from idle-no-runner', () => {
  it('initial state is idle-no-runner, new phase', () => {
    const f = makeConvFixture();
    expect(f.conv.state).toBe('idle-no-runner');
    expect(f.conv.phase).toBe('new');
    expect(f.conv.hasRunner).toBe(false);
    expect(f.conv.isExpired).toBe(false);
    expect(f.conv.isInvalidated).toBe(false);
  });

  it('first deliver triggers spawn cycle, transitions through awaiting-slot → running → idle-with-runner', async () => {
    const f = makeConvFixture();
    const result = await f.conv.deliver('hello', {});
    expect(result.ok).toBe(true);
    expect(f.factorySpy).toHaveBeenCalledTimes(1);
    expect(f.runner?.spawnSpy).toHaveBeenCalledTimes(1);
    expect(f.conv.state).toBe('idle-with-runner');
    expect(f.conv.hasRunner).toBe(true);
  });

  it('spawn receives the mailbox as drained prompt (D1 source-of-truth)', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('msg 1', {});
    const promptArg = f.runner!.spawnSpy.mock.calls[0]![0] as PendingMessage[];
    expect(promptArg).toHaveLength(1);
    expect(promptArg[0]!.text).toBe('msg 1');
  });

  it('factory receives ccSessionId + isNewConversation reflecting store state', async () => {
    const fresh = makeConvFixture();
    await fresh.conv.deliver('hi', {});
    const freshArgs = fresh.factorySpy.mock.calls[0]![0];
    expect(freshArgs.ccSessionId).toBeUndefined();
    expect(freshArgs.isNewConversation).toBe(true);

    const resumed = makeConvFixture({ seedCcSessionId: 'sess-resume' });
    await resumed.conv.deliver('hi', {});
    const resumedArgs = resumed.factorySpy.mock.calls[0]![0];
    expect(resumedArgs.ccSessionId).toBe('sess-resume');
    expect(resumedArgs.isNewConversation).toBe(false);
  });
});

// =============================================================================
// Tests — mailbox accumulates during spawn (D1)
// =============================================================================

describe('Conversation — mailbox SOT (D1)', () => {
  it('concurrent delivers during a running spawn pipe via IPC (state is running)', async () => {
    const f = makeConvFixture({ runnerOpts: { manualSpawn: true } });
    const p1 = f.conv.deliver('a', {});
    await settle();
    // After the sync dispatch, state transitions awaiting-slot → running
    // by the time we hit the spawn await. Concurrent delivers during the
    // running window pipe via IPC, not queue.
    expect(f.conv.state).toBe('running');
    const p2 = f.conv.deliver('b', {});
    const p3 = f.conv.deliver('c', {});
    expect(f.runner!.pipeSpy).toHaveBeenCalledWith('b');
    expect(f.runner!.pipeSpy).toHaveBeenCalledWith('c');
    expect(f.conv.mailboxSize).toBe(0); // both piped successfully

    f.resolveSpawn({ type: 'settled', result: 'a-result', outputSent: true });
    await Promise.all([p1, p2, p3]);
    expect(f.runner!.spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('mailbox accumulates only when pipe fails or runner is dead', async () => {
    const r = makeMockRunner({ manualSpawn: true, pipeOk: false });
    const f = makeConvFixture({ runnerSequence: [r, makeMockRunner()] });
    void f.conv.deliver('a', {});
    await settle();
    expect(f.conv.state).toBe('running');
    // Pipe fails → handleRunnerDiedInline → state → idle-no-runner.
    // The next deliver pushes to mailbox and begins a fresh spawn cycle.
    void f.conv.deliver('b', {});
    await settle(20);
    // b was queued in mailbox after pipe failure; second runner picked it up.
    expect(f.factorySpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('first deliver gets a real promise; subsequent get synthetic OK', async () => {
    const f = makeConvFixture({ runnerOpts: { manualSpawn: true } });
    const p1 = f.conv.deliver('first', {});
    await settle();
    // p1 is still pending (spawn manual)
    const p2 = f.conv.deliver('second', {});
    const r2 = await p2;
    expect(r2).toEqual({ ok: true, result: null });
    // p1 still pending; resolve spawn
    f.resolveSpawn({ type: 'settled', result: 'final', outputSent: true });
    const r1 = await p1;
    expect(r1).toEqual({ ok: true, result: 'final' });
  });
});

// =============================================================================
// Tests — deliver from running / idle-with-runner (IPC pipe)
// =============================================================================

describe('Conversation — IPC pipe path', () => {
  it('deliver from idle-with-runner pipes via IPC and transitions to running', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    expect(f.conv.state).toBe('idle-with-runner');

    const r = await f.conv.deliver('second', {});
    expect(r).toEqual({ ok: true, result: null });
    expect(f.runner!.pipeSpy).toHaveBeenCalledWith('second');
    expect(f.conv.state).toBe('running');
  });

  it('pipe failure triggers runner-died handling: slot released, state → idle-no-runner, mailbox drives respawn', async () => {
    const r1 = makeMockRunner();
    const r2 = makeMockRunner();
    const f = makeConvFixture({ runnerSequence: [r1, r2] });
    await f.conv.deliver('first', {});
    expect(f.conv.state).toBe('idle-with-runner');
    // Force pipe failure
    r1.pipeMessage = vi.fn(() => false);
    const p = f.conv.deliver('second', {});
    // Should respawn with a new runner
    await p;
    expect(f.factorySpy.mock.calls.length).toBe(2);
    expect(f.conv.state).toBe('idle-with-runner');
  });
});

// =============================================================================
// Tests — resolver contract (D2)
// =============================================================================

describe('Conversation — resolver (D2)', () => {
  it('first deliver receives the spawn outcome', async () => {
    const f = makeConvFixture({
      runnerOpts: {
        spawnOutcome: {
          type: 'settled',
          result: 'spawn-result',
          outputSent: true,
        },
      },
    });
    const r = await f.conv.deliver('hello', {});
    expect(r).toEqual({ ok: true, result: 'spawn-result' });
  });

  it('terminal spawn error fires resolver with error', async () => {
    const f = makeConvFixture({
      runnerOpts: {
        spawnOutcome: {
          type: 'terminal-error',
          error: 'spawn failed',
          outputSent: false,
        },
      },
    });
    const r = await f.conv.deliver('hello', {});
    expect(r).toEqual({ ok: false, error: 'spawn failed' });
  });

  it('resolver fires once across auth-retry inner-loop iterations (first settled)', async () => {
    // J.3b — `SpawnOutcome` no longer carries a `needsRespawn` flag.
    // Inner-loop iteration is driven by auth-retry (the only path that
    // re-enters spawn() on the same runner instance). Verify the resolver
    // fires exactly once when the final retry settles.
    let spawnCallCount = 0;
    const f = makeConvFixture();
    f.factorySpy.mockImplementation((factoryOpts) => {
      const runner = makeMockRunner({ onIdle: factoryOpts.onIdle });
      runner.spawn = vi.fn(async (): Promise<SpawnOutcome> => {
        spawnCallCount++;
        if (spawnCallCount < 2) {
          // First spawn hits auth-error → inner loop retries on same runner.
          return { type: 'auth-error', outputSent: false };
        }
        return { type: 'settled', result: 'final', outputSent: true };
      });
      return runner;
    });
    const p = f.conv.deliver('msg1', {});
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toBe('final');
    // Sanity — the inner loop iterated twice (1 retry + 1 settle).
    expect(spawnCallCount).toBe(2);
  });

  it('destroyed conversation rejects deliver', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    await f.conv.shutdown();
    const r = await f.conv.deliver('after', {});
    expect(r).toEqual({ ok: false, error: 'Conversation destroyed' });
  });
});

// =============================================================================
// Tests — auth-retry replay (pipedThisSpawn migration)
// =============================================================================

describe('Conversation — auth-retry replay (G.4)', () => {
  it('auth-retry requeues piped messages and re-delivers them in the retry spawn (same runner)', async () => {
    // Auth-retry stays on the same runner instance — Conversation retries
    // the spawn cycle, not the runner. So spawnSpy fires twice on r1.
    const r1 = makeMockRunner({ manualSpawn: true });
    const f = makeConvFixture({ runnerSequence: [r1] });

    const p = f.conv.deliver('initial', {});
    await vi.waitFor(() => expect(r1.spawnSpy).toHaveBeenCalledTimes(1));

    // Mid-spawn pipe — populates Conversation.pipedThisSpawn.
    await f.conv.deliver('mid-spawn-piped', {});
    expect(r1.pipeSpy).toHaveBeenCalledWith('mid-spawn-piped');

    // Settle spawn 1 with authError → triggers retry on the same runner.
    f.resolveSpawn({ type: 'auth-error', outputSent: false });

    // Retry spawn (call #2 on r1) inherits the requeued message.
    await vi.waitFor(() => expect(r1.spawnSpy).toHaveBeenCalledTimes(2));
    const retryPrompt = r1.spawnSpy.mock.calls[1]![0]!;
    expect(retryPrompt.map((m) => m.text)).toEqual(['mid-spawn-piped']);
    await p;
  });

  it('clean settle clears pipedThisSpawn — no phantom replay on subsequent respawn', async () => {
    // Spawn 1: blocks, settles cleanly with a piped message during it.
    // Force a respawn via pipe-fail on a NEW deliver. New runner's spawn must
    // NOT include the original piped message — clean settle cleared it.
    const r1 = makeMockRunner({ manualSpawn: true });
    const r2 = makeMockRunner();
    const f = makeConvFixture({ runnerSequence: [r1, r2] });

    const p = f.conv.deliver('initial', {});
    await vi.waitFor(() => expect(r1.spawnSpy).toHaveBeenCalled());

    await f.conv.deliver('piped-during-spawn-1', {});

    // Clean settle — no error, no authError.
    f.resolveSpawn({ type: 'settled', result: null, outputSent: true });
    await p;
    expect(f.conv.state).toBe('idle-with-runner');

    // Force a respawn: pipe-fail on next deliver → runner-died → spawn r2.
    r1.pipeMessage = vi.fn(() => false);
    await f.conv.deliver('after-clean', {});

    await vi.waitFor(() => expect(r2.spawnSpy).toHaveBeenCalled());
    const spawn2Prompt = r2.spawnSpy.mock.calls[0]![0]!;
    // Must include ONLY 'after-clean'. If pipedThisSpawn weren't cleared,
    // 'piped-during-spawn-1' would be at the head.
    expect(spawn2Prompt.map((m) => m.text)).toEqual(['after-clean']);
  });

  it('terminal spawn error preserves pipedThisSpawn to mailbox head; next deliver replays', async () => {
    // Spawn 1: blocks, gets a piped msg, then errors terminally.
    // After teardown, a new deliver kicks spawn on r2 which sees [piped, new].
    const r1 = makeMockRunner({ manualSpawn: true });
    const r2 = makeMockRunner();
    const f = makeConvFixture({ runnerSequence: [r1, r2] });

    const p = f.conv.deliver('initial', {});
    await vi.waitFor(() => expect(r1.spawnSpy).toHaveBeenCalled());

    await f.conv.deliver('piped', {});

    f.resolveSpawn({ type: 'terminal-error', error: 'boom', outputSent: false });

    const settled = await p;
    expect(settled).toEqual({ ok: false, error: 'boom' });

    // New deliver triggers spawn on r2 which drains mailbox.
    await f.conv.deliver('next', {});
    await vi.waitFor(() => expect(r2.spawnSpy).toHaveBeenCalled());
    const spawn2Prompt = r2.spawnSpy.mock.calls[0]![0]!;
    // Order: 'piped' was unshifted into mailbox head, 'next' pushed after.
    expect(spawn2Prompt.map((m) => m.text)).toEqual(['piped', 'next']);
  });

});

// =============================================================================
// Tests — invalidate
// =============================================================================

describe('Conversation — invalidate', () => {
  it('invalidate sets the flag but does not eagerly destroy runner', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    expect(f.conv.state).toBe('idle-with-runner');
    f.conv.invalidate();
    expect(f.conv.isInvalidated).toBe(true);
    expect(f.conv.state).toBe('idle-with-runner');
    expect(f.conv.hasRunner).toBe(true);
  });

  it('next deliver after invalidate replaces the runner', async () => {
    const r1 = makeMockRunner();
    const r2 = makeMockRunner();
    const f = makeConvFixture({ runnerSequence: [r1, r2] });
    await f.conv.deliver('first', {});
    f.conv.invalidate();
    await f.conv.deliver('second', {});
    expect(f.factorySpy).toHaveBeenCalledTimes(2);
    expect(r2.spawnSpy).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Tests — yieldSlot (R4 re-entrance guard)
// =============================================================================

describe('Conversation — yieldSlot', () => {
  it('yieldSlot destroys runner and releases slot', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    expect(f.conv.state).toBe('idle-with-runner');
    expect(f.pool.active).toBe(1);

    await f.conv.yieldSlot();
    expect(f.conv.state).toBe('idle-no-runner');
    expect(f.conv.hasRunner).toBe(false);
    expect(f.runner!.destroySpy).toHaveBeenCalled();
    expect(f.pool.active).toBe(0);
  });

  it('yieldSlot is no-op outside idle-with-runner', async () => {
    const f = makeConvFixture();
    // From idle-no-runner: reject
    await f.conv.yieldSlot();
    expect(f.runner).toBeNull();
  });

  it('R4 — two yieldSlot calls do not both destroy', async () => {
    const f = makeConvFixture({ runnerOpts: { manualSpawn: false } });
    await f.conv.deliver('first', {});
    // Make destroy slow so two calls can race
    const originalDestroy = f.runner!.destroy.bind(f.runner!);
    let destroyCount = 0;
    f.runner!.destroy = vi.fn(async (mode: TeardownMode) => {
      destroyCount++;
      await new Promise((r) => setTimeout(r, 10));
      return originalDestroy(mode);
    });

    const [_, _2] = await Promise.all([f.conv.yieldSlot(), f.conv.yieldSlot()]);
    expect(destroyCount).toBe(1);
  });
});

// =============================================================================
// Tests — markSwapFellThrough (bridge from catalog swap path)
// =============================================================================

describe('Conversation — markSwapFellThrough', () => {
  it('from idle-no-runner transitions to awaiting-slot and emits queued{active:true}', () => {
    const f = makeConvFixture();
    expect(f.conv.state).toBe('idle-no-runner');
    f.busSpies.onQueued.mockClear();
    f.conv.markSwapFellThrough();
    expect(f.conv.state).toBe('awaiting-slot');
    expect(f.busSpies.onQueued).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('no-ops when not in idle-no-runner', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    expect(f.conv.state).toBe('idle-with-runner');
    f.busSpies.onQueued.mockClear();
    f.conv.markSwapFellThrough();
    // State unchanged; no queued event fired.
    expect(f.conv.state).toBe('idle-with-runner');
    expect(f.busSpies.onQueued).not.toHaveBeenCalled();
  });

  it('no-ops when isTerminating', async () => {
    const f = makeConvFixture();
    expect(f.conv.state).toBe('idle-no-runner');
    // setPhase('terminating') is what shutdown() does first — simulate that
    // state without awaiting the full shutdown teardown.
    const shutdownPromise = f.conv.shutdown();
    f.busSpies.onQueued.mockClear();
    f.conv.markSwapFellThrough();
    // Did not advance to awaiting-slot — the terminating guard fired.
    expect(f.conv.state).not.toBe('awaiting-slot');
    expect(f.busSpies.onQueued).not.toHaveBeenCalled();
    await shutdownPromise;
  });

  it('idempotent — second call after successful transition is a no-op', () => {
    const f = makeConvFixture();
    f.conv.markSwapFellThrough();
    expect(f.conv.state).toBe('awaiting-slot');
    f.busSpies.onQueued.mockClear();
    f.conv.markSwapFellThrough();
    // Guard rejects: state is awaiting-slot, not idle-no-runner.
    expect(f.busSpies.onQueued).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Tests — expire
// =============================================================================

describe('Conversation — expire', () => {
  it('expire(text) from idle-with-runner pipes cleanup and stays running', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    await f.conv.expire('cleanup');
    expect(f.runner!.pipeSpy).toHaveBeenCalledWith('cleanup');
    expect(f.conv.phase).toBe('expiring');
  });

  // Regression — `Conversation.expire` must pipe the cleanup text with
  // `kind: 'lifecycle'` so the runner (a) wraps the body as
  // `<cast:lifecycle>...</cast:lifecycle>` and (b) flips its internal phase
  // to 'expired', which is what suppresses the cleanup-turn reply from
  // reaching the user. Calling `pipeMessage(cleanup)` with no opts sends a
  // plain participant message and the cleanup-turn output leaks out as a
  // normal chat reply.
  it('expire(text) pipes cleanup with kind: "lifecycle"', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    f.runner!.pipeOptsSpy.mockClear();
    await f.conv.expire('cleanup');
    expect(f.runner!.pipeOptsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'lifecycle' }),
    );
  });

  it('expire(text) from idle-no-runner spawns a cleanup runner', async () => {
    const f = makeConvFixture();
    await f.conv.expire('please clean up');
    // expire kicks off the cleanup spawn cycle asynchronously; let it settle.
    await settle(10);
    expect(f.factorySpy).toHaveBeenCalled();
    expect(f.runner!.spawnSpy).toHaveBeenCalled();
    expect(f.conv.state).toBe('destroyed');
    expect(f.busSpies.onExpiryComplete).toHaveBeenCalled();
  });

  it('expire(null) hard-destroys: no cleanup turn, transitions to destroyed with drain', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    await f.conv.expire(null);
    expect(f.conv.state).toBe('destroyed');
    // Hard-expire calls destroy with drain mode so an in-flight turn can
    // finalize its disk writes. The close-hint write happens inside the
    // runner's destroy() implementation, not via the separate close()
    // method on the Runner interface — Conversation no longer calls
    // close() from _teardown.
    expect(f.runner!.destroySpy).toHaveBeenCalled();
    const lastDestroyArg = f.runner!.destroySpy.mock.calls.at(-1)?.[0];
    expect(lastDestroyArg).toEqual({ kind: 'drain', timeoutMs: expect.any(Number) });
  });

  it('expire on already-expiring is no-op', async () => {
    const f = makeConvFixture({ runnerOpts: { manualSpawn: true } });
    void f.conv.deliver('first', {});
    await settle();
    void f.conv.expire('cleanup-1');
    await settle();
    void f.conv.expire('cleanup-2');
    await settle();
    // Resolve spawn so it can settle
    f.resolveSpawn({ type: 'settled', result: null, outputSent: true });
    await settle(10);
    expect(f.busSpies.onExpiryComplete).toHaveBeenCalledTimes(1);
  });

  it('after expire completes, catalog.unregister is called', async () => {
    const f = makeConvFixture();
    await f.conv.expire('clean');
    await settle(10);
    expect(f.catalogSpies.unregister).toHaveBeenCalled();
  });
});

// =============================================================================
// Tests — shutdown
// =============================================================================

describe('Conversation — shutdown', () => {
  it('shutdown fires resolver with shutdown error', async () => {
    const f = makeConvFixture({ runnerOpts: { manualSpawn: true } });
    const p = f.conv.deliver('msg', {});
    await settle();
    expect(f.conv.state).toBe('running');
    await f.conv.shutdown();
    const r = await p;
    expect(r).toEqual({ ok: false, error: 'Server shutting down' });
    expect(f.conv.state).toBe('destroyed');
  });

  it('shutdown is idempotent', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('msg', {});
    await f.conv.shutdown();
    await expect(f.conv.shutdown()).resolves.toBeUndefined();
  });

  it('shutdown from idle-no-runner', async () => {
    const f = makeConvFixture();
    await f.conv.shutdown();
    expect(f.conv.state).toBe('destroyed');
    expect(f.catalogSpies.unregister).toHaveBeenCalled();
  });

  it('I.9 — concurrent shutdown calls share the in-flight teardown Promise; destroy fires once', async () => {
    const r = makeMockRunner();
    const f = makeConvFixture({ runnerSequence: [r] });
    await f.conv.deliver('msg', {});
    expect(f.conv.state).toBe('idle-with-runner');

    // Two concurrent shutdowns. The first claims the in-flight slot; the
    // second sees `_teardownInFlight !== null` and receives the same
    // Promise. Both await; destroy fires exactly once.
    const p1 = f.conv.shutdown();
    const p2 = f.conv.shutdown();
    await Promise.all([p1, p2]);

    expect(r.destroySpy).toHaveBeenCalledTimes(1);
    expect(f.conv.state).toBe('destroyed');
  });

  it('J.2 — yieldSlot + shutdown race: shutdown still lands on destroyed', async () => {
    // Race: yieldSlot initiates a teardown to idle-no-runner just before
    // shutdown initiates a teardown to destroyed. Pre-J.2 the in-flight
    // Promise (target='idle-no-runner') would settle and shutdown's await
    // returns with state==='idle-no-runner' — conversation leaks as a
    // half-torn entity. With J.2 shutdown re-tears-down until state is
    // 'destroyed'.
    const r = makeMockRunner();
    const f = makeConvFixture({ runnerSequence: [r] });
    await f.conv.deliver('msg', {});
    expect(f.conv.state).toBe('idle-with-runner');

    // Fire yieldSlot first (claims the in-flight slot with target='idle-no-runner');
    // then shutdown sees the in-flight slot and awaits it. The first await
    // returns with state==='idle-no-runner'; J.2's `while` loop runs a
    // second teardown with target='destroyed' to win.
    const yieldP = f.conv.yieldSlot({ skipDrain: true });
    const shutdownP = f.conv.shutdown();
    await Promise.all([yieldP, shutdownP]);

    expect(f.conv.state).toBe('destroyed');
    expect(f.catalogSpies.unregister).toHaveBeenCalled();
    expect(r.destroySpy).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Tests — destroyed state guards
// =============================================================================

describe('Conversation — destroyed state', () => {
  let f: ConvFixture;
  beforeEach(async () => {
    f = makeConvFixture();
    await f.conv.shutdown();
  });

  it('deliver after destroyed returns error', async () => {
    const r = await f.conv.deliver('x', {});
    expect(r).toEqual({ ok: false, error: 'Conversation destroyed' });
  });

  it('expire after destroyed is no-op', async () => {
    await expect(f.conv.expire('x')).resolves.toBeUndefined();
  });

  it('invalidate after destroyed is no-op', () => {
    expect(() => f.conv.invalidate()).not.toThrow();
  });

  it('yieldSlot after destroyed is no-op', async () => {
    await expect(f.conv.yieldSlot()).resolves.toBeUndefined();
  });
});

// =============================================================================
// Tests — slot acquisition behavior
// =============================================================================

describe('Conversation — slot acquisition', () => {
  it('queues when pool is saturated; spawns when slot becomes available', async () => {
    const f = makeConvFixture({ capacity: 1 });
    // Fill the pool
    const slot1 = f.pool.tryAcquire();
    expect(slot1).not.toBeNull();

    const p = f.conv.deliver('msg', {});
    await settle();
    expect(f.conv.state).toBe('awaiting-slot');

    slot1!.release();
    await p;
    expect(f.conv.state).toBe('idle-with-runner');
  });

  it('catalog acquireSlot returns kind:sync on the fast path', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('hello', {});
    expect(f.catalogSpies.acquireSlot).toHaveBeenCalled();
    const result = f.catalogSpies.acquireSlot.mock.results[0]?.value as SlotResult;
    expect(result.kind).toBe('sync');
  });

  it('catalog acquireSlot returns kind:queued when pool is saturated (test fixture treats pressure as FIFO)', async () => {
    const f = makeConvFixture({ capacity: 1 });
    // Saturate the pool to force the pressure path.
    const slot1 = f.pool.tryAcquire();
    expect(slot1).not.toBeNull();
    const p = f.conv.deliver('hello', {});
    await settle();
    expect(f.catalogSpies.acquireSlot).toHaveBeenCalledWith(f.conv);
    const result = f.catalogSpies.acquireSlot.mock.results[0]?.value as SlotResult;
    // The test fixture (see makeConvFixture) returns 'queued' for the pressure
    // path; the real ConversationCatalog distinguishes 'swap' vs 'queued' based
    // on findLRUVictim(). Catalog-side tests cover that classifier directly.
    expect(result.kind).toBe('queued');
    slot1!.release();
    await p;
  });
});

// =============================================================================
// Tests — onIdle hook + maybeEvictForWaiters
// =============================================================================

describe('Conversation — onIdle integration', () => {
  it('runner.onIdle from running transitions to idle-with-runner and notifies catalog', async () => {
    const f = makeConvFixture({ runnerOpts: { manualSpawn: true } });
    const p = f.conv.deliver('msg', {});
    await settle();
    expect(f.conv.state).toBe('running');

    // Mid-spawn idle event from runner is unusual but the conversation must
    // handle it: we simulate via the captured idle hook.
    f.resolveSpawn({ type: 'settled', result: 'ok', outputSent: true });
    await p;
    expect(f.conv.state).toBe('idle-with-runner');
    // maybeEvictForWaiters is called on transition to idle-with-runner
    expect(f.catalogSpies.maybeEvictForWaiters).toHaveBeenCalledWith(f.conv);
  });
});

// =============================================================================
// Tests — chokepoint conformance regressions (Bugs A & B, spec §21)
// =============================================================================

describe('Conversation — Bug A regression (yieldSlot desync)', () => {
  it('yieldSlot with concurrent deliver: message kicks a new spawn cycle after yield lands', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    expect(f.conv.state).toBe('idle-with-runner');

    // Make destroy slow so the await window is observable. During the await,
    // the conversation has runner=null but state still === 'idle-with-runner'
    // (the bug). A concurrent deliver in this window must not lose the message.
    let destroyResolver: (() => void) | null = null;
    const firstRunner = f.runner!;
    firstRunner.destroy = vi.fn(async () => {
      return new Promise<boolean>((resolve) => {
        destroyResolver = () => resolve(true);
      });
    });

    const yieldPromise = f.conv.yieldSlot();
    await settle();

    // Concurrent deliver during the yieldSlot await.
    const deliverPromise = f.conv.deliver('during-yield', {});
    await settle();

    destroyResolver!();
    await yieldPromise;
    await deliverPromise;
    await settle(10);

    // After yield completes, the queued message must drive a new spawn cycle.
    // Buggy code leaves the message stuck in the mailbox because state never
    // re-reaches 'idle-no-runner' from a path that triggers beginSpawnCycle.
    expect(f.factorySpy).toHaveBeenCalledTimes(2);
    expect(f.conv.state).toBe('idle-with-runner');
    expect(f.conv.mailboxSize).toBe(0);
  });
});

describe('Conversation — Bug B regression (shutdown clobber)', () => {
  it('shutdown during inner spawn loop does not resurrect destroyed state', async () => {
    const f = makeConvFixture({ runnerOpts: { manualSpawn: true } });
    const deliverPromise = f.conv.deliver('msg', {});
    await settle();
    expect(f.conv.state).toBe('running');

    // Shutdown while spawn is in flight.
    const shutdownPromise = f.conv.shutdown();
    await settle();
    expect(f.conv.state).toBe('destroyed');

    // Now resolve the spawn — buggy code runs `_state = 'idle-with-runner'`
    // at the tail of runSpawnCycle, clobbering 'destroyed'.
    f.resolveSpawn({ type: 'settled', result: 'late', outputSent: true });
    await deliverPromise;
    await shutdownPromise;
    await settle(10);

    // Must remain 'destroyed'.
    expect(f.conv.state).toBe('destroyed');
  });
});

describe('Conversation — superseded spawn cycle does not clobber successor (I2 / ownership epoch)', () => {
  it('a stale cycle whose spawn resolves after a teardown does not re-assert state over the successor', async () => {
    const r1 = makeMockRunner({ manualSpawn: true });
    const r2 = makeMockRunner({ manualSpawn: true });
    const f = makeConvFixture({ runnerSequence: [r1, r2], capacity: 2 });

    // Cycle #1 owns r1 and parks on its held spawn.
    const p1 = f.conv.deliver('a', {});
    await settle();
    expect(f.conv.state).toBe('running');

    // Env-stale teardown supersedes cycle #1: invalidate + deliver triggers
    // replaceInvalidatedRunner → teardown to idle-no-runner (bumps the
    // ownership epoch) → a replacement cycle #2 acquires its own slot (capacity
    // 2) and installs a LIVE runner r2, also parked on its held spawn.
    f.conv.invalidate();
    const p2 = f.conv.deliver('b', {});
    await settle(10);
    expect(f.conv.state).toBe('running');
    expect(f.conv.hasRunner).toBe(true); // r2 is live and now owns the conversation
    expect(f.factorySpy).toHaveBeenCalledTimes(2);

    // Resolve cycle #1's OWN held spawn (r1) so the superseded cycle reaches
    // its settle. It must NOT re-assert idle-with-runner over cycle #2's
    // running r2 — that premature idle-with-runner is the phantom-eviction
    // window the ownership epoch closes.
    r1._resolveSpawn!({ type: 'settled', result: 'a', outputSent: true });
    await settle(10);
    expect(f.conv.state).toBe('running'); // successor intact, not clobbered
    expect(f.conv.hasRunner).toBe(true);
    // The stale settle bailed before its side effects — no eviction fired.
    expect(f.catalogSpies.maybeEvictForWaiters).not.toHaveBeenCalled();

    // Cycle #2 settles normally; the conversation lands idle-with-runner with
    // its live runner, and the queued message was not stranded.
    r2._resolveSpawn!({ type: 'settled', result: 'b', outputSent: true });
    await Promise.all([p1, p2]);
    await settle(20);
    expect(f.conv.state).toBe('idle-with-runner');
    expect(f.conv.hasRunner).toBe(true);
    expect(f.conv.mailboxSize).toBe(0);
  });
});

// =============================================================================
// Tests — setState chokepoint + queue-transition bus events
//
// The state-write chokepoint replaces 11 scattered `this._state = X` sites.
// Transition-tuple events (queued enter/exit) emit by construction; side-
// effect-driven events (runner-removed, expiry-complete) emit from the
// post-async points inside `_teardown`. These tests pin both sets of
// behaviors and the edge cases identified during the chokepoint design.
//
// The fixture installs a universal bus subscriber that fans events into the
// `busSpies` map, so legacy-style assertions on `busSpies.onQueued`
// keep reading as direct checks of the bus contract.
// =============================================================================

describe('Conversation — setState chokepoint: queue enter/exit', () => {
  it('onQueued(true) fires when entering awaiting-slot via beginSpawnCycle', async () => {
    const f = makeConvFixture({ capacity: 1 });
    // Saturate the pool so the spawn cycle parks in awaiting-slot.
    const blocker = f.pool.tryAcquire();
    expect(blocker).not.toBeNull();

    void f.conv.deliver('hello', {});
    await settle();
    expect(f.conv.state).toBe('awaiting-slot');
    expect(f.busSpies.onQueued).toHaveBeenCalledTimes(1);
    expect(f.busSpies.onQueued).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'agent:test' }),
      true,
    );

    blocker!.release();
    await settle(10);
  });

  it('onQueued(false) fires when leaving awaiting-slot for running (slot acquired)', async () => {
    const f = makeConvFixture({ capacity: 1 });
    const blocker = f.pool.tryAcquire();
    const deliverP = f.conv.deliver('hello', {});
    await settle();
    expect(f.conv.state).toBe('awaiting-slot');
    expect(f.busSpies.onQueued.mock.calls).toEqual([
      [expect.any(Object), true],
    ]);

    blocker!.release();
    await deliverP;
    expect(f.conv.state).toBe('idle-with-runner');
    // Two calls total: (true) on enter, (false) on exit. No third call from
    // running → idle-with-runner (that transition does not toggle onQueued).
    expect(f.busSpies.onQueued.mock.calls).toEqual([
      [expect.any(Object), true],
      [expect.any(Object), false],
    ]);
  });

  it('onQueued(false) fires when slot acquisition rejects (awaiting-slot → idle-no-runner)', async () => {
    const f = makeConvFixture({
      capacity: 1,
      acquirePressureOverride: () =>
        Promise.reject(new Error('SlotPool: acquire cancelled')),
    });
    // Saturate the pool to force the pressure path.
    const blocker = f.pool.tryAcquire();
    expect(blocker).not.toBeNull();

    const result = await f.conv.deliver('hello', {});
    expect(result).toEqual({ ok: false, error: 'SlotPool: acquire cancelled' });
    expect(f.conv.state).toBe('idle-no-runner');
    expect(f.busSpies.onQueued.mock.calls).toEqual([
      [expect.any(Object), true],
      [expect.any(Object), false],
    ]);
    blocker!.release();
  });

  it('onQueued(false) does NOT fire when leaving awaiting-slot for destroyed (shutdown)', async () => {
    const f = makeConvFixture({ capacity: 1 });
    const blocker = f.pool.tryAcquire();
    void f.conv.deliver('hello', {});
    await settle();
    expect(f.conv.state).toBe('awaiting-slot');
    expect(f.busSpies.onQueued).toHaveBeenCalledTimes(1);

    await f.conv.shutdown();
    expect(f.conv.state).toBe('destroyed');
    // Only the original onQueued(true). No false on destroy — by design,
    // since the participant context is going away and there is no UX to
    // "unqueue."
    expect(f.busSpies.onQueued).toHaveBeenCalledTimes(1);
    expect(f.busSpies.onQueued).toHaveBeenLastCalledWith(
      expect.any(Object),
      true,
    );
    blocker!.release();
  });

  it('onQueued(false) does NOT fire when hardExpire transitions awaiting-slot → destroyed', async () => {
    const f = makeConvFixture({ capacity: 1 });
    const blocker = f.pool.tryAcquire();
    void f.conv.deliver('hello', {});
    await settle();
    expect(f.conv.state).toBe('awaiting-slot');
    expect(f.busSpies.onQueued).toHaveBeenCalledTimes(1);

    await f.conv.expire(null);
    expect(f.conv.state).toBe('destroyed');
    expect(f.busSpies.onQueued).toHaveBeenCalledTimes(1);
    blocker!.release();
  });

  it('onQueued fires again on re-queue after teardown drain (post-await spawn cycle)', async () => {
    // Setup: idle-with-runner, pipe fails on next deliver → handleRunnerDiedInline →
    // teardown to idle-no-runner. The teardown's post-await guard observes a
    // non-empty mailbox and kicks runSpawnCycle. With the pool forced to async
    // on the re-queue, the cycle transitions to awaiting-slot and onQueued fires.
    // (On the sync fast path the re-queue bypasses awaiting-slot entirely;
    // this test specifically exercises the async-path firing.)
    const r1 = makeMockRunner();
    const r2 = makeMockRunner();
    const f = makeConvFixture({ runnerSequence: [r1, r2] });
    await f.conv.deliver('first', {});
    expect(f.conv.state).toBe('idle-with-runner');
    // Reset call count to focus on the re-queue cycle.
    f.busSpies.onQueued.mockClear();

    // Force the next acquireSlot to return queued so the re-queue path
    // transitions through awaiting-slot. Manual resolver lets us drive
    // timing without racing the real pool.
    let asyncResolve!: (slot: Slot) => void;
    const heldSlot = f.pool.tryAcquire()!;
    f.catalogSpies.acquireSlot.mockImplementationOnce(() => ({
      kind: 'queued',
      promise: new Promise<Slot>((resolve) => {
        asyncResolve = resolve;
      }),
    }));

    // Force pipe failure on r1 to trigger teardown + re-queue.
    r1.pipeMessage = vi.fn(() => false);
    const p = f.conv.deliver('second', {});
    await settle();
    expect(f.conv.state).toBe('awaiting-slot');

    asyncResolve(heldSlot);
    await p;
    await settle(10);

    // The pipeline went running → idle-no-runner → awaiting-slot → running →
    // idle-with-runner. onQueued fired (true) on awaiting-slot entry, then
    // (false) on exit.
    const calls = f.busSpies.onQueued.mock.calls.map((c) => c[1]);
    expect(calls).toEqual([true, false]);
  });

  it('queue transitions still drive correctly when no bus subscriber listens', async () => {
    // Callbacks are collapsed to `buildSpawnHooks` only. With no
    // bus subscriber, queue transitions should still drive cleanly — the
    // bus emits to nobody but the state machine progresses as designed.
    const f = makeConvFixture({ capacity: 1 });
    const minimalCatalog: ConversationCatalogRef = {
      acquireSlot: (conv) => {
        const fast = f.pool.tryAcquire();
        if (fast !== null) return { kind: 'sync', slot: fast };
        return { kind: 'queued', promise: f.pool.acquire(conv) };
      },
      maybeEvictForWaiters: () => undefined,
      unregister: () => undefined,
    };
    // Brand-new bus with no subscribers, so the conversation's emits land
    // nowhere — the state machine has to be unaffected.
    const isolatedBus = new ConversationEventBus();
    const conv = new Conversation({
      scope: 'agent:test',
      conversationKey: 'minimal|cli:user',
      factory: f.factorySpy as RunnerFactory,
      catalog: minimalCatalog,
      store: f.store,
      ttl: f.ttl,
      buildSpawnHooks: () => ({} as SpawnHooks),
      eventBus: isolatedBus,
    });
    const blocker = f.pool.tryAcquire();
    const p = conv.deliver('hi', {});
    await settle();
    expect(conv.state).toBe('awaiting-slot');
    blocker!.release();
    await p;
    expect(conv.state).toBe('idle-with-runner');
  });

  it('onQueued tolerates a throwing callback — state transitions are not interrupted', async () => {
    const f = makeConvFixture({ capacity: 1 });
    f.busSpies.onQueued.mockImplementation(() => {
      throw new Error('hook intentionally throws');
    });
    const blocker = f.pool.tryAcquire();
    const p = f.conv.deliver('hi', {});
    await settle();
    expect(f.conv.state).toBe('awaiting-slot');
    blocker!.release();
    await p;
    expect(f.conv.state).toBe('idle-with-runner');
  });
});

describe('Conversation — setState chokepoint: idempotent self-transitions', () => {
  it('self-transition (running → running) does not re-fire onQueued', async () => {
    // The inner-spawn loop's "re-affirm running" call (and other defensive
    // self-writes) must not produce any spurious hook firings. Saturate the
    // pool with a blocker so the first deliver goes through the async
    // (awaiting-slot) path; this gives us a baseline (true, false) pair to
    // verify the inner-loop respawn iterations don't add stray firings.
    // J.3b — no `needsRespawn` flag; drive multi-iteration via auth-retry
    // (the only mechanism that re-enters spawn() on the same runner; auth-
    // retry triggers an inner-loop continue with re-affirmed 'running').
    let spawnAttempts = 0;
    const f = makeConvFixture({ capacity: 1 });
    f.factorySpy.mockImplementation((factoryOpts) => {
      const r = makeMockRunner({ onIdle: factoryOpts.onIdle });
      r.spawn = vi.fn(async (): Promise<SpawnOutcome> => {
        spawnAttempts++;
        if (spawnAttempts < 3) {
          return { type: 'auth-error', outputSent: false };
        }
        return { type: 'settled', result: 'final', outputSent: false };
      });
      return r;
    });

    const blocker = f.pool.tryAcquire();
    const p = f.conv.deliver('hello', {});
    await settle();
    expect(f.conv.state).toBe('awaiting-slot');
    blocker!.release();
    await p;
    expect(spawnAttempts).toBe(3);
    expect(f.conv.state).toBe('idle-with-runner');
    // Exactly one (true) on awaiting-slot entry, one (false) on exit to
    // running. The 3 inner-loop running re-affirms must NOT add false
    // firings — self-transition short-circuits.
    const calls = f.busSpies.onQueued.mock.calls.map((c) => c[1]);
    expect(calls).toEqual([true, false]);
  });

  it('destroyed re-affirm inside _teardown does not double-fire runner-removed', async () => {
    // _teardown writes state via setState, then later re-affirms 'destroyed'
    // via a second setState call. The self-transition must short-circuit so
    // bus emits don't fire twice. (`runner-removed` is emitted directly from
    // _teardown after the destroy await, not from setState — but if setState
    // ever sprouts a runner-removed rule it must respect self-transitions.)
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    expect(f.conv.state).toBe('idle-with-runner');
    expect(f.busSpies.onRunnerRemoved).not.toHaveBeenCalled();

    await f.conv.shutdown();
    expect(f.conv.state).toBe('destroyed');
    expect(f.busSpies.onRunnerRemoved).toHaveBeenCalledTimes(1);
  });
});

describe('Conversation — chokepoint preserves runner/expiry hook semantics', () => {
  it('onRunnerRemoved fires once per teardown of a live runner (yieldSlot)', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    expect(f.conv.state).toBe('idle-with-runner');
    expect(f.busSpies.onRunnerRemoved).not.toHaveBeenCalled();

    await f.conv.yieldSlot();
    expect(f.conv.state).toBe('idle-no-runner');
    expect(f.busSpies.onRunnerRemoved).toHaveBeenCalledTimes(1);
  });

  it('onRunnerRemoved fires on hardExpire when a runner was present', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    await f.conv.expire(null);
    expect(f.busSpies.onRunnerRemoved).toHaveBeenCalledTimes(1);
  });

  it('onRunnerRemoved does NOT fire on shutdown when no runner was attached', async () => {
    const f = makeConvFixture();
    await f.conv.shutdown();
    expect(f.busSpies.onRunnerRemoved).not.toHaveBeenCalled();
  });

  it('onExpiryComplete fires after a soft-expire cleanup turn completes', async () => {
    const f = makeConvFixture();
    await f.conv.expire('please clean up');
    await settle(10);
    expect(f.conv.state).toBe('destroyed');
    expect(f.busSpies.onExpiryComplete).toHaveBeenCalledTimes(1);
  });

  it('onExpiryComplete fires after hardExpire', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    await f.conv.expire(null);
    expect(f.busSpies.onExpiryComplete).toHaveBeenCalledTimes(1);
  });

  it('onExpiryComplete does NOT fire on plain shutdown (no expire intent)', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    await f.conv.shutdown();
    expect(f.busSpies.onExpiryComplete).not.toHaveBeenCalled();
  });

  it('onExpiryComplete fires AFTER onQueued events (ordering)', async () => {
    // Expire from idle-no-runner spawns a cleanup runner. With the pool
    // saturated (forcing the async path) the full path is
    // idle-no-runner → awaiting-slot → running → destroyed. We expect:
    //   onQueued(true) on awaiting-slot entry
    //   onQueued(false) on awaiting-slot → running
    //   onExpiryComplete on running → destroyed
    // This pins the relative ordering of hook dispatch. (On the sync fast
    // path the awaiting-slot state is bypassed entirely and onQueued doesn't
    // fire — that's the new spec-aligned behavior; tested separately above.)
    const f = makeConvFixture({ capacity: 1 });
    const events: string[] = [];
    f.busSpies.onQueued.mockImplementation((_, active) =>
      events.push(`onQueued(${active})`),
    );
    f.busSpies.onExpiryComplete.mockImplementation(() =>
      events.push('onExpiryComplete'),
    );
    f.busSpies.onRunnerRemoved.mockImplementation(() =>
      events.push('onRunnerRemoved'),
    );

    const blocker = f.pool.tryAcquire();
    const p = f.conv.expire('please clean up');
    await settle();
    expect(f.conv.state).toBe('awaiting-slot');
    blocker!.release();
    await p;
    await settle(10);

    expect(events[0]).toBe('onQueued(true)');
    expect(events[1]).toBe('onQueued(false)');
    // onExpiryComplete and onRunnerRemoved both fire during _teardown;
    // expireSideEffects fires first in the current sequence.
    expect(events).toContain('onExpiryComplete');
    expect(events).toContain('onRunnerRemoved');
    expect(events.indexOf('onExpiryComplete')).toBeLessThan(events.indexOf('onRunnerRemoved'));
  });
});

describe('Conversation — chokepoint edge cases identified in design', () => {
  it('auth retry loop does NOT toggle onQueued (state stays running across retries)', async () => {
    // Simulate two consecutive auth errors followed by success. State should
    // remain 'running' across the inner-loop iterations; onQueued must not
    // fire because we never re-enter awaiting-slot.
    let calls = 0;
    const f = makeConvFixture();
    f.factorySpy.mockImplementation((factoryOpts) => {
      const r = makeMockRunner({ onIdle: factoryOpts.onIdle });
      r.spawn = vi.fn(async (): Promise<SpawnOutcome> => {
        calls++;
        if (calls <= 2) {
          return { type: 'auth-error', outputSent: false };
        }
        return { type: 'settled', result: 'ok', outputSent: true };
      });
      return r;
    });

    const p = f.conv.deliver('hello', {});
    const r = await p;
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);

    // onQueued may fire at most (true) then (false) for the one awaiting-slot
    // pass, but never more — there's no second awaiting-slot entry.
    const queuedCalls = f.busSpies.onQueued.mock.calls;
    const trues = queuedCalls.filter((c) => c[1] === true).length;
    const falses = queuedCalls.filter((c) => c[1] === false).length;
    expect(trues).toBeLessThanOrEqual(1);
    expect(falses).toBeLessThanOrEqual(1);
  });

  it('post-teardown re-queue: onQueued fires for the second awaiting-slot entry', async () => {
    // Pipe failure on a running runner (during deliver): deliver routes through
    // handleRunnerDiedInline → _teardown → 'idle-no-runner'. The teardown's
    // post-await guard observes a non-empty mailbox (the very message that
    // just failed to pipe) and kicks runSpawnCycle. With the re-queue forced
    // through the async path, the second awaiting-slot entry fires onQueued.
    //
    // Setup: capacity 1 with a blocker held during the first deliver forces
    // the first deliver's awaiting-slot enter/exit pair. After the conv
    // settles to idle-with-runner, an acquireSlot override forces the
    // re-queue path through async as well.
    const r1 = makeMockRunner({ pipeOk: false });
    const r2 = makeMockRunner();
    const f = makeConvFixture({ capacity: 1, runnerSequence: [r1, r2] });

    // First deliver: saturate pool then release to force async.
    const blocker = f.pool.tryAcquire();
    const p1 = f.conv.deliver('first', {});
    await settle();
    expect(f.conv.state).toBe('awaiting-slot');
    blocker!.release();
    await p1;
    expect(f.conv.state).toBe('idle-with-runner');
    expect(
      f.busSpies.onQueued.mock.calls.map((c) => c[1]),
    ).toEqual([true, false]);

    // Re-queue: force queued with a manual resolver so the path is observable.
    let asyncResolve!: (slot: Slot) => void;
    const reuseSlot = f.pool.tryAcquire()!;
    f.catalogSpies.acquireSlot.mockImplementationOnce(() => ({
      kind: 'queued',
      promise: new Promise<Slot>((resolve) => {
        asyncResolve = resolve;
      }),
    }));

    // Second deliver: pipe fails on r1 → teardown → re-queue (forced async).
    r1.pipeMessage = vi.fn(() => false);
    const p2 = f.conv.deliver('second', {});
    await settle();
    expect(f.conv.state).toBe('awaiting-slot');

    asyncResolve(reuseSlot);
    await p2;
    await settle(10);

    // Pipeline: idle-with-runner → idle-no-runner (teardown) → awaiting-slot
    // (re-queue, async) → running → idle-with-runner. Two awaiting-slot
    // enter/exit pairs total.
    expect(f.conv.state).toBe('idle-with-runner');
    const calls = f.busSpies.onQueued.mock.calls.map((c) => c[1]);
    expect(calls).toEqual([true, false, true, false]);
  });

  it('shutdown from idle-no-runner does not fire onQueued at all', async () => {
    // Initial state is idle-no-runner. Shutting down should not synthesize
    // a queued-false event from nowhere.
    const f = makeConvFixture();
    await f.conv.shutdown();
    expect(f.busSpies.onQueued).not.toHaveBeenCalled();
  });

  it('shutdown from idle-with-runner does not fire onQueued', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    expect(f.conv.state).toBe('idle-with-runner');
    f.busSpies.onQueued.mockClear();
    await f.conv.shutdown();
    expect(f.busSpies.onQueued).not.toHaveBeenCalled();
  });

  it('deliver from running pipes IPC — no awaiting-slot, no onQueued', async () => {
    const f = makeConvFixture({ runnerOpts: { manualSpawn: true } });
    const p1 = f.conv.deliver('a', {});
    await settle();
    expect(f.conv.state).toBe('running');
    f.busSpies.onQueued.mockClear();

    void f.conv.deliver('b', {});
    void f.conv.deliver('c', {});
    expect(f.busSpies.onQueued).not.toHaveBeenCalled();

    f.resolveSpawn({ type: 'settled', result: 'ok', outputSent: true });
    await p1;
  });
});

// =============================================================================
// Tests — deferred awaiting-slot entry (spec §14.H)
//
// The conversation enters 'awaiting-slot' only when the slot acquisition
// returns kind:'async'. On the sync fast path (capacity available), the
// transition is idle-no-runner → running directly. This aligns implementation
// with spec §2.94 / §13.I3 and eliminates the spurious "queued flash" that
// rendered as user-visible "Waiting…" messages on Telegram.
// =============================================================================

describe('Conversation — deferred awaiting-slot entry', () => {
  it('sync fast path skips awaiting-slot — no onQueued fires when pool has capacity', async () => {
    const f = makeConvFixture({ capacity: 2 });
    await f.conv.deliver('hello', {});
    expect(f.conv.state).toBe('idle-with-runner');
    expect(f.busSpies.onQueued).not.toHaveBeenCalled();
  });

  it('async path enters awaiting-slot and fires onQueued(true) then (false)', async () => {
    const f = makeConvFixture({ capacity: 1 });
    const blocker = f.pool.tryAcquire();
    const p = f.conv.deliver('hello', {});
    await settle();
    expect(f.conv.state).toBe('awaiting-slot');
    expect(f.busSpies.onQueued).toHaveBeenCalledTimes(1);
    expect(f.busSpies.onQueued).toHaveBeenLastCalledWith(expect.any(Object), true);

    blocker!.release();
    await p;
    expect(f.conv.state).toBe('idle-with-runner');
    expect(f.busSpies.onQueued.mock.calls.map((c) => c[1])).toEqual([true, false]);
  });

  it('terminal error in the only spawn settles back to idle-no-runner cleanly', async () => {
    // With Step 1, _teardown leaves state in 'idle-no-runner' (not the old
    // 'awaiting-slot'). When the spawn cycle's terminal-error path observes
    // an empty mailbox after teardown, it returns instead of re-entering
    // slot acquisition. Verify the outer while exits and the conversation
    // settles to idle-no-runner with no runner.
    const f = makeConvFixture({ capacity: 2 });
    f.factorySpy.mockImplementation((factoryOpts) => {
      const r = makeMockRunner({ onIdle: factoryOpts.onIdle });
      r.spawn = vi.fn(async () => ({
        type: 'terminal-error',
        error: 'boom',
        outputSent: false,
      } as const));
      return r;
    });

    const result = await f.conv.deliver('a', {});
    await settle(10);
    expect(result.ok).toBe(false);
    expect(f.conv.state).toBe('idle-no-runner');
    expect(f.conv.hasRunner).toBe(false);
    expect(f.busSpies.onQueued).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Tests — event bus emission
//
// `Conversation` emits typed events onto its `ConversationEventBus`. After
// The bus is the sole observation surface — the legacy
// `ConversationCallbacks` fields (onQueued, onRunnerRemoved, onExpiryComplete)
// were removed. These tests pin the bus contract from the Conversation side:
// every chokepoint (setState, setPhase, _teardown post-async) emits the
// expected event.
// =============================================================================

describe('Conversation — event bus emission', () => {
  it('bus receives state events on every non-self transition', async () => {
    const f = makeConvFixture({ capacity: 1 });
    const events: ConversationEvent[] = [];
    f.eventBus.subscribe({ kinds: ['state'] }, (e) => events.push(e));

    // Force async slot acquisition so we observe the full sequence
    // idle-no-runner → awaiting-slot → running → idle-with-runner.
    const blocker = f.pool.tryAcquire();
    const p = f.conv.deliver('hello', {});
    await settle();
    blocker!.release();
    await p;

    const pairs = events.map((e) =>
      e.kind === 'state' ? [e.from, e.to] : null,
    );
    expect(pairs).toContainEqual(['idle-no-runner', 'awaiting-slot']);
    expect(pairs).toContainEqual(['awaiting-slot', 'running']);
    expect(pairs).toContainEqual(['running', 'idle-with-runner']);
  });

  it('bus does NOT emit state event on self-transition (matches setState semantics)', async () => {
    // Inner-loop re-affirm of 'running' should produce zero extra state events.
    let spawnAttempts = 0;
    const f = makeConvFixture();
    f.factorySpy.mockImplementation((factoryOpts) => {
      const r = makeMockRunner({ onIdle: factoryOpts.onIdle });
      r.spawn = vi.fn(async (): Promise<SpawnOutcome> => {
        spawnAttempts++;
        if (spawnAttempts < 3) {
          // Auth-retry drives inner-loop iteration (the only path that
          // re-enters spawn on the same runner; post-J.3b there's no
          // needsRespawn flag).
          return { type: 'auth-error', outputSent: false };
        }
        return { type: 'settled', result: 'final', outputSent: false };
      });
      return r;
    });

    const stateEvents: ConversationEvent[] = [];
    f.eventBus.subscribe({ kinds: ['state'] }, (e) => stateEvents.push(e));

    await f.conv.deliver('hello', {});
    // Sync fast path: idle-no-runner → running → idle-with-runner. The two
    // 'running' re-affirms inside the inner loop must not produce events.
    const transitions = stateEvents.map((e) =>
      e.kind === 'state' ? `${e.from}->${e.to}` : '',
    );
    expect(transitions).toEqual(['idle-no-runner->running', 'running->idle-with-runner']);
    expect(spawnAttempts).toBe(3);
  });

  it('bus receives queued(true)/queued(false) on awaiting-slot enter/exit', async () => {
    const f = makeConvFixture({ capacity: 1 });
    const queuedEvents: boolean[] = [];
    f.eventBus.subscribe({ kinds: ['queued'] }, (e) => {
      if (e.kind === 'queued') queuedEvents.push(e.active);
    });

    const blocker = f.pool.tryAcquire();
    const p = f.conv.deliver('hi', {});
    await settle();
    expect(f.conv.state).toBe('awaiting-slot');
    blocker!.release();
    await p;

    expect(queuedEvents).toEqual([true, false]);
    // The fixture's universal subscriber (see makeConvFixture) re-fans the
    // bus events into the busSpies map, so this assertion mirrors the
    // bus check — kept here so legacy assertions on `busSpies.onQueued`
    // throughout the suite continue to read cleanly.
    expect(f.busSpies.onQueued.mock.calls.map((c) => c[1])).toEqual([true, false]);
  });

  it('bus emits phase event on phase transition (new → active on first spawn success)', async () => {
    const f = makeConvFixture();
    const phaseEvents: ConversationEvent[] = [];
    f.eventBus.subscribe({ kinds: ['phase'] }, (e) => phaseEvents.push(e));

    await f.conv.deliver('hello', {});
    const transitions = phaseEvents.map((e) =>
      e.kind === 'phase' ? `${e.from}->${e.to}` : '',
    );
    expect(transitions).toEqual(['new->active']);
  });

  it('bus emits phase event on transition to expiring', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    const phaseEvents: ConversationEvent[] = [];
    f.eventBus.subscribe({ kinds: ['phase'] }, (e) => phaseEvents.push(e));

    await f.conv.expire('cleanup');
    const transitions = phaseEvents.map((e) =>
      e.kind === 'phase' ? `${e.from}->${e.to}` : '',
    );
    expect(transitions).toEqual(['active->expiring']);
  });

  it('bus emits runner-removed event after teardown when a runner was present (yieldSlot)', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    const removedEvents: ConversationEvent[] = [];
    f.eventBus.subscribe({ kinds: ['runner-removed'] }, (e) => removedEvents.push(e));

    await f.conv.yieldSlot();
    expect(removedEvents).toHaveLength(1);
    expect(removedEvents[0]!.kind).toBe('runner-removed');
    // Fixture's universal subscriber fans the bus event into the
    // `onRunnerRemoved` spy — kept for symmetry with the bus-emit assertion.
    expect(f.busSpies.onRunnerRemoved).toHaveBeenCalledTimes(1);
  });

  it('bus emits expiry-complete event after teardown when expireSideEffects (hardExpire)', async () => {
    const f = makeConvFixture();
    await f.conv.deliver('first', {});
    const expiryEvents: ConversationEvent[] = [];
    f.eventBus.subscribe({ kinds: ['expiry-complete'] }, (e) => expiryEvents.push(e));

    await f.conv.expire(null);
    expect(expiryEvents).toHaveLength(1);
    expect(expiryEvents[0]!.kind).toBe('expiry-complete');
    // Fixture's universal subscriber fans the bus event into the
    // `onExpiryComplete` spy — kept for symmetry with the bus-emit assertion.
    expect(f.busSpies.onExpiryComplete).toHaveBeenCalledTimes(1);
  });

  it('bus emits expiry-complete event after soft-expire cleanup turn', async () => {
    const f = makeConvFixture();
    const expiryEvents: ConversationEvent[] = [];
    f.eventBus.subscribe({ kinds: ['expiry-complete'] }, (e) => expiryEvents.push(e));

    await f.conv.expire('please clean up');
    await settle(10);
    expect(expiryEvents).toHaveLength(1);
  });

  // The legacy `ConversationCallbacks` observation fields were removed.
  // The bus is now mandatory and the back-compat-no-bus test that
  // used to live here is gone with the surface it covered.
});

// ---------------------------------------------------------------------------
// Spawn-cycle containment — factory throw
// ---------------------------------------------------------------------------

describe('Conversation — factory throw containment', () => {
  it('factory throw → resolver settles {ok:false}, state idle-no-runner, slot released', async () => {
    const f = makeConvFixture({ factoryThrowsOnce: 'boom: construction failed', capacity: 2 });

    const result = await f.conv.deliver('hi', {});
    await settle(10);

    // The deliver promise SETTLES with the error — pre-containment it never
    // settled (the throw escaped `void runSpawnCycle()` as an unhandled
    // rejection) and the caller waited forever.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('boom: construction failed');

    // No zombie: state recovered, no runner, slot back in the pool.
    expect(f.conv.state).toBe('idle-no-runner');
    expect(f.pool.active).toBe(0);
  });

  it('does not loop on the poisoned message (at-most-once: mailbox dropped)', async () => {
    const f = makeConvFixture({ factoryThrowsOnce: 'persistent construction error' });

    await f.conv.deliver('poison', {});
    await settle(10);

    // Exactly one construction attempt — the teardown kick must not re-enter
    // on the dropped message and re-throw in a loop.
    expect(f.factorySpy).toHaveBeenCalledTimes(1);
  });

  it('subsequent deliver spawns cleanly after a factory throw', async () => {
    const f = makeConvFixture({ factoryThrowsOnce: 'transient construction error', capacity: 2 });

    const first = await f.conv.deliver('first', {});
    await settle(10);
    expect(first.ok).toBe(false);

    // Second deliver drives a fresh spawn — the fixture's factory only
    // throws once, so this constructs a healthy runner.
    const second = await f.conv.deliver('second', {});
    await settle(10);
    expect(second.ok).toBe(true);
    expect(f.factorySpy).toHaveBeenCalledTimes(2);
    expect(f.conv.state).toBe('idle-with-runner');
    expect(f.pool.active).toBe(1);
  });

  it('subsequent message black-hole regression: deliveries after the throw are not silently swallowed', async () => {
    const f = makeConvFixture({ factoryThrowsOnce: 'boom' });

    const p1 = f.conv.deliver('one', {});
    await settle(10);
    expect((await p1).ok).toBe(false);

    // Pre-containment the conversation wedged in running/null-runner and this
    // second deliver queued into a mailbox nothing would ever drain while
    // synthesizing {ok:true}. Now it must actually spawn and settle truthfully.
    const p2 = await f.conv.deliver('two', {});
    await settle(10);
    expect(p2.ok).toBe(true);
    expect(f.runner?.spawnSpy).toHaveBeenCalled();
  });
});
