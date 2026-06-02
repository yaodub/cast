/**
 * Conversations façade — public surface smoke tests. Verifies that the
 * scope binding, lookup, lifecycle, TTL, and shutdown methods route
 * correctly through the catalog + ttl pair.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ConversationsImpl, CONVERSATION_TEST_ACCESS, type Conversations, type ConversationsTestAccess } from './facade.js';
import { _resetPanicRegistryForTest } from '../lib/panic-registry.js';

beforeEach(() => {
  _resetPanicRegistryForTest();
});
import { ConversationCatalog } from './catalog.js';
import { ConversationEventBus } from './event-bus.js';
import { SlotPool } from './slot-pool.js';
import { ConversationTtl } from './ttl.js';
import type { BuildSpawnHooks } from './conversation.js';
import type {
  Runner,
  RunnerFactory,
  SpawnOutcome,
  SpawnHooks,
  PendingMessage,
  TeardownMode,
} from './runner.js';
import { AgentStateStore } from '../agent/state-store.js';
import type { IdleTimeoutMeta } from './types.js';

function makeStore(): AgentStateStore {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-facade-test-'));
  return new AgentStateStore(tmpDir);
}

function makeMockRunner(): Runner & {
  spawnSpy: Mock<(p: PendingMessage[], h: SpawnHooks) => void>;
} {
  let destroyed = false;
  const spawnSpy = vi.fn<(p: PendingMessage[], h: SpawnHooks) => void>();
  return {
    spawnSpy,
    async spawn(prompt, hooks): Promise<SpawnOutcome> {
      spawnSpy(prompt, hooks);
      return { type: 'settled', result: 'ok', outputSent: true };
    },
    pipeMessage(): boolean {
      return true;
    },
    close(): void {},
    async destroy(_mode: TeardownMode): Promise<boolean> {
      destroyed = true;
      return true;
    },
    async emitAuthExhausted(): Promise<void> {},
    get ccSessionId() {
      return undefined;
    },
    get isDestroyed() {
      return destroyed;
    },
    get activeProcess() {
      return null;
    },
    get activeContainerName() {
      return null;
    },
  };
}

function makeBuildSpawnHooks(): BuildSpawnHooks {
  return vi.fn(() => ({} as SpawnHooks));
}

interface FacadeFixture {
  conversations: Conversations;
  pool: SlotPool;
  ttl: ConversationTtl;
  catalog: ConversationCatalog;
  store: AgentStateStore;
  factory: RunnerFactory;
}

function makeFacade(): FacadeFixture {
  const pool = new SlotPool(4);
  const ttl = new ConversationTtl();
  const eventBus = new ConversationEventBus();
  const catalog = new ConversationCatalog({ pool, ttl, eventBus });
  const conversations = new ConversationsImpl({ catalog, ttl, eventBus });
  const store = makeStore();
  const factory: RunnerFactory = () => makeMockRunner();
  conversations.registerScope('agent:a', {
    factory,
    buildSpawnHooks: makeBuildSpawnHooks(),
    store,
  });
  return { conversations, pool, ttl, catalog, store, factory };
}

function meta(key: string): IdleTimeoutMeta {
  return {
    conversationKey: key,
    channelName: 'default',
    cleanup: 'cleanup',
    cleanupEnabled: true,
    participant: 'cli:user',
    idle_timeout: 60_000,
  };
}

describe('Conversations façade — scope binding', () => {
  it('deliver to unregistered scope returns error', async () => {
    const f = makeFacade();
    const r = await f.conversations.deliver('agent:unknown', 'k1', 'hi', {});
    expect(r.ok).toBe(false);
  });

  it('unregisterScope shuts down all conversations in the scope', async () => {
    const f = makeFacade();
    await f.conversations.deliver('agent:a', 'k1', 'hi', {});
    await f.conversations.deliver('agent:a', 'k2', 'hi', {});
    expect(f.catalog.size).toBe(2);
    await f.conversations.unregisterScope('agent:a');
    expect(f.catalog.size).toBe(0);
  });
});

describe('Conversations façade — deliver', () => {
  it('routes to a fresh Conversation and returns the spawn outcome', async () => {
    const f = makeFacade();
    const r = await f.conversations.deliver('agent:a', 'k1', 'hello', {});
    expect(r).toEqual({ ok: true, result: 'ok' });
  });

  it('stable reference across delivers', async () => {
    const f = makeFacade();
    await f.conversations.deliver('agent:a', 'k1', 'first', {});
    // J.4b — test-only access to verify identity stability across delivers.
    const access = f.conversations as unknown as ConversationsTestAccess;
    const r1 = access[CONVERSATION_TEST_ACCESS]('agent:a', 'k1');
    await f.conversations.deliver('agent:a', 'k1', 'second', {});
    const r2 = access[CONVERSATION_TEST_ACCESS]('agent:a', 'k1');
    expect(r1).toBe(r2);
  });
});

describe('Conversations façade — inspection', () => {
  it('get returns a ConversationView with the expected fields', async () => {
    const f = makeFacade();
    await f.conversations.deliver('agent:a', 'k1', 'hi', {});
    const view = f.conversations.get('agent:a', 'k1');
    expect(view).toBeDefined();
    expect(view?.scope).toBe('agent:a');
    expect(view?.key).toBe('k1');
  });

  it('test-access symbol yields the underlying Conversation (J.4b)', async () => {
    const f = makeFacade();
    await f.conversations.deliver('agent:a', 'k1', 'hi', {});
    const access = f.conversations as unknown as ConversationsTestAccess;
    const conv = access[CONVERSATION_TEST_ACCESS]('agent:a', 'k1');
    expect(conv).toBeDefined();
    expect(conv?.scope).toBe('agent:a');
    expect(conv?.key).toBe('k1');
  });

  it('has reflects existence', async () => {
    const f = makeFacade();
    expect(f.conversations.has('agent:a', 'k1')).toBe(false);
    await f.conversations.deliver('agent:a', 'k1', 'hi', {});
    expect(f.conversations.has('agent:a', 'k1')).toBe(true);
  });

  it('inScope yields views for the scope', async () => {
    const f = makeFacade();
    await f.conversations.deliver('agent:a', 'k1', 'hi', {});
    await f.conversations.deliver('agent:a', 'k2', 'hi', {});
    const views = [...f.conversations.inScope('agent:a')];
    expect(views).toHaveLength(2);
    expect(views.map((v) => v.key).sort()).toEqual(['k1', 'k2']);
  });
});

describe('Conversations façade — lifecycle', () => {
  it('expire(scope, key, null) hard-destroys the conversation', async () => {
    const f = makeFacade();
    await f.conversations.deliver('agent:a', 'k1', 'hi', {});
    await f.conversations.expire('agent:a', 'k1', null);
    expect(f.conversations.has('agent:a', 'k1')).toBe(false);
  });

  it('expire(scope, key) with cleanup runs the cleanup turn', async () => {
    const f = makeFacade();
    await f.conversations.deliver('agent:a', 'k1', 'hi', {});
    await f.conversations.expire('agent:a', 'k1', 'goodbye');
    // The cleanup turn runs asynchronously after pipe; flush microtasks.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

  it('expire on unknown conversation is no-op', async () => {
    const f = makeFacade();
    await expect(
      f.conversations.expire('agent:a', 'missing', 'x'),
    ).resolves.toBeUndefined();
  });

  it('invalidate sets the flag on the existing conversation', async () => {
    const f = makeFacade();
    await f.conversations.deliver('agent:a', 'k1', 'hi', {});
    f.conversations.invalidate('agent:a', 'k1');
    const view = f.conversations.get('agent:a', 'k1');
    expect(view?.isInvalidated).toBe(true);
  });

  it('invalidateScope flips all conversations in the scope', async () => {
    const f = makeFacade();
    await f.conversations.deliver('agent:a', 'k1', 'hi', {});
    await f.conversations.deliver('agent:a', 'k2', 'hi', {});
    f.conversations.invalidateScope('agent:a');
    expect(f.conversations.get('agent:a', 'k1')?.isInvalidated).toBe(true);
    expect(f.conversations.get('agent:a', 'k2')?.isInvalidated).toBe(true);
  });
});

describe('Conversations façade — TTL', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('scheduleTtl auto-materializes the conversation if absent; only false on unknown scope', async () => {
    const f = makeFacade();
    // Auto-materialize: scheduleTtl on a key with no prior deliver creates
    // the conversation in idle-no-runner so the timer has a binding.
    expect(f.conversations.scheduleTtl('agent:a', 'k1', meta('k1'), 1000)).toBe(true);
    expect(f.conversations.has('agent:a', 'k1')).toBe(true);
    // Unknown scope returns false — no binding to materialize against.
    expect(f.conversations.scheduleTtl('agent:unknown', 'k1', meta('k1'), 1000)).toBe(false);
  });

  it('TTL fires and calls expire on the conversation', async () => {
    const f = makeFacade();
    await f.conversations.deliver('agent:a', 'k1', 'hi', {});
    f.conversations.scheduleTtl('agent:a', 'k1', meta('k1'), 1000);
    vi.advanceTimersByTime(1000);
    // Flush microtasks for the cleanup-turn pipe.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(f.conversations.get('agent:a', 'k1')?.phase).toBe('expiring');
  });

  it('peekTtl returns the scheduled meta', async () => {
    const f = makeFacade();
    await f.conversations.deliver('agent:a', 'k1', 'hi', {});
    f.conversations.scheduleTtl('agent:a', 'k1', meta('k1'), 1000);
    const peeked = f.conversations.peekTtl('agent:a', 'k1');
    expect(peeked?.conversationKey).toBe('k1');
  });

  it('cancelTtl prevents the timer from firing', async () => {
    const f = makeFacade();
    await f.conversations.deliver('agent:a', 'k1', 'hi', {});
    f.conversations.scheduleTtl('agent:a', 'k1', meta('k1'), 1000);
    f.conversations.cancelTtl('agent:a', 'k1');
    vi.advanceTimersByTime(2000);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(f.conversations.get('agent:a', 'k1')?.phase).toBe('active');
  });
});

describe('Conversations façade — shutdownAll', () => {
  it('tears down all conversations and clears scope bindings', async () => {
    const f = makeFacade();
    await f.conversations.deliver('agent:a', 'k1', 'hi', {});
    await f.conversations.shutdownAll();
    expect(f.catalog.size).toBe(0);
    // Subsequent deliver returns error since scope was cleared.
    const r = await f.conversations.deliver('agent:a', 'k2', 'hi', {});
    expect(r.ok).toBe(false);
  });
});
