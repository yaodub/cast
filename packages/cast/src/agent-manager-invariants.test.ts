/**
 * Invariant tests for AgentManager runner-lifecycle plumbing.
 *
 * Guards the four invariants of the runner-lifecycle pipeline:
 *
 *   1. enqueue-before-release ordering in finishSpawnResult
 *   2. result-resolver always invoked on runner completion
 *   3. conversation-map identity check protects a replacement runner from
 *      being deleted when the previous runner's finishSpawnResult fires
 *   4. staging-dir cleanup coordination (once per removal, not zero/twice)
 *
 * Plus:
 *   5. console-session end-to-end smoke (__design channel creates snapshot,
 *      passes console opts to the container, cleans up snapshot on finish)
 *   6. normal + console session concurrency through their separate gates
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// --- Mocks (must be before imports) ---

vi.mock('./config.js', async () => {
  const path = await import('path');
  return {
    AGENTS_DIR: '/tmp/cast-test-agents',
    IDLE_TIMEOUT: 300_000,
    MAX_CONCURRENT_CONTAINERS: 2,
    CONFIG_DIR: '/tmp/cast-test-config',
    TIMEZONE: 'UTC',
    CONFIG_RELOAD_DEBOUNCE_MS: 15_000,
    agentPath: (folder: string, ...segments: string[]) =>
      path.join('/tmp/cast-test-agents', folder, ...segments),
    sessionCastSocketPath: (folder: string, _key: string) =>
      path.join('/tmp/cast-test-agents', folder, 'mcp', 'socket', 'testhash.sock'),
    sessionClaudePath: (folder: string, _key: string) =>
      path.join('/tmp/cast-test-agents', folder, '.console', 'claude', 'testhash'),
    castSocketPath: (folder: string) =>
      path.join('/tmp/cast-test-agents', folder, 'mcp', 'cast.sock'),
    readCapabilities: () => ({
      disabled_tools: [], additional_disabled_tools: [],
      resources: {}, extensions: {}, mcp_servers: {},
    }),
    resolveCapabilities: () => ({ disabledTools: [], resources: {} }),
    resolveMcpServers: () => [],
    readMcpServerSecrets: () => ({}),
    readServerConfig: () => ({
      consoleModel: 'claude-opus-4-7',
      consoleIsolation: 'normal',
    }),
    MAX_ATTACHMENT_BYTES: 10_000_000,
    MAX_VALIDATION_FAILURES: 3,
    MAX_OUTPUT_BYTES_DEFAULT: 32_768,
    PUSH_ROW_TTL_MS: 5 * 60 * 1000,
    PUSH_ROW_SWEEP_MS: 60 * 1000,
    EGRESS_REFRESH_MS: 5 * 60 * 1000,
    OUTBOUND_DELIVERY_TTL_MS: 6 * 60 * 60 * 1000,
    OUTBOUND_RETRY_BACKOFF_MS: [5_000, 30_000, 120_000, 600_000],
    OUTBOUND_ACK_REDUE_MS: 600_000,
    OUTBOUND_WORKER_TICK_MS: 30_000,
  };
});

// The egress refresher is exercised by its own unit test; stub it here so
// AgentManager construction + the immediate refresh tick never touch DNS or
// `container exec`.
vi.mock('./container/egress-controller.js', () => ({
  EgressController: class {
    reconcile() {
      return Promise.resolve({ kind: 'skipped', reason: 'unchanged' });
    }
    reconcileMany() {
      return Promise.resolve();
    }
    forget() {}
  },
}));

vi.mock('./agent/mcp-server.js', () => ({
  startMcpSocketServer: vi.fn(() => ({ ready: Promise.resolve(), close: vi.fn() })),
}));

vi.mock('./console/tools.js', () => ({
  startConsoleMcpServer: vi.fn(() => ({ ready: Promise.resolve(), close: vi.fn() })),
}));

vi.mock('./console/snapshot.js', () => ({
  createSnapshot: vi.fn(() => '/tmp/snap'),
  cleanupSnapshot: vi.fn(),
  snapshotPath: vi.fn((_f: string, _k: string) => '/tmp/snap'),
  keyHash: vi.fn((_k: string) => 'testhash'),
  sweepOrphanSnapshots: vi.fn(),
}));

vi.mock('./console/prompt.js', () => ({
  assembleConsolePrompt: vi.fn(() => 'mock-console-prompt'),
}));

vi.mock('./console/mounts.js', () => ({
  buildConsoleMounts: vi.fn(() => [
    { hostPath: '/agent/blueprint', containerPath: '/agent/blueprint', readonly: false },
  ]),
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./lib/utils.js', async (importOriginal) => {
  // Spread the real module — the delivery drain needs parseJsonSafe et al.;
  // a hand-listed subset silently breaks whatever the subset misses.
  const actual = await importOriginal<typeof import('./lib/utils.js')>();
  // Counter, not Date.now() — uniqueness is part of generateId's contract.
  // Packet ids key gateway.db rows (INSERT OR REPLACE), so a same-millisecond
  // collision silently clobbers a pending packet and loses its delivery.
  let idCounter = 0;
  return {
    ...actual,
    generateId: (prefix: string) => `${prefix}-test-${++idCounter}`,
    writeAtomic: vi.fn(),
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      appendFileSync: vi.fn(),
      readFileSync: vi.fn(() => '{}'),
      readdirSync: vi.fn(() => []),
      renameSync: vi.fn(),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      rmSync: vi.fn(),
    },
  };
});

// Controllable container mock — the test signals completion.

interface ContainerMock {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mock: (...args: any[]) => any;
  finish: (result?: string, sessionId?: string) => void;
  failWith: (error: string) => void;
  started: Promise<void>;
  input: { containerNetwork?: string; overrideMounts?: unknown[]; workdir?: string; bootstrap?: string };
}

function createContainerMock(): ContainerMock {
  let resolveContainer: (value: { result?: string; sessionId?: string; error?: string }) => void;
  const containerDone = new Promise<{ result?: string; sessionId?: string; error?: string }>(
    (r) => { resolveContainer = r; },
  );
  let resolveStarted: () => void;
  const started = new Promise<void>((r) => { resolveStarted = r; });
  const captured: ContainerMock['input'] = {};

  const mock = vi.fn(async (
    _agent: unknown,
    input: { containerNetwork?: string; overrideMounts?: unknown[]; workdir?: string; bootstrap?: string },
    onProcess: (proc: ChildProcess, name: string) => void,
    onOutput: (result: { type: string; result?: string; intermediate?: boolean; newSessionId?: string; error?: string }) => Promise<void>,
  ) => {
    captured.containerNetwork = input.containerNetwork;
    captured.overrideMounts = input.overrideMounts;
    captured.workdir = input.workdir;
    captured.bootstrap = input.bootstrap;
    const fakeProc = new EventEmitter() as ChildProcess;
    Object.defineProperty(fakeProc, 'pid', { value: 99999 });
    onProcess(fakeProc, 'test-container');
    resolveStarted();

    const outcome = await containerDone;
    if (outcome.error) {
      await onOutput({ type: 'error', error: outcome.error });
      return { type: 'error' as const, error: outcome.error };
    }
    const result = outcome.result ?? 'mock response';
    const sessionId = outcome.sessionId ?? 'sess-1';
    await onOutput({ type: 'message', result, newSessionId: sessionId });
    return { type: 'message' as const, result: '', newSessionId: sessionId };
  });

  return {
    mock,
    finish: (result?: string, sessionId?: string) => resolveContainer({ result, sessionId }),
    failWith: (error: string) => resolveContainer({ error }),
    started,
    input: captured,
  };
}

let containerMocks: ContainerMock[];
function nextContainerMock(): ContainerMock {
  const cm = createContainerMock();
  containerMocks.push(cm);
  return cm;
}

vi.mock('./container/container-runner.js', () => ({
  runContainerAgent: vi.fn((...args: unknown[]) => {
    const cm = nextContainerMock();
    return (cm.mock as (...args: unknown[]) => unknown)(...args);
  }),
  writeToAgent: vi.fn(() => true),
  readAgentConfig: vi.fn(() => ({})),
  // Spawn pre-check reads this — tests don't exercise the not-configured
  // path, so always return a sentinel non-null value.
  getResolvedAuth: vi.fn(() => ({ mode: 'api-key', secrets: { ANTHROPIC_API_KEY: 'test' }, meta: { source: '.env' } })),
}));

vi.mock('./agent/prompt-assembly.js', () => ({
  assembleSystemPrompt: vi.fn(() => 'mock-system-prompt'),
}));

vi.mock('./agent/agent-scheduler.js', () => ({
  AgentScheduler: class MockScheduler {
    start = vi.fn();
    stop = vi.fn();
    onScheduleChanged = vi.fn();
  },
}));

vi.mock('./agent/agent-service.js', () => ({
  AgentService: class MockService {
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    get process() { return null; }
    get status() { return 'idle'; }
  },
}));

// Shared mock for the extracted MessageLogStore bundle — both AgentDb.messages
// and ConsoleDb.messages route here. See message-log-store.ts.
const mockMessageLog = {
  logInbound: vi.fn(),
  logOutbound: vi.fn(),
  search: vi.fn(() => []),
  recent: vi.fn(() => []),
  recentOtherInboundParticipants: vi.fn(() => []),
  read: vi.fn(() => null),
};

vi.mock('./agent/agent-db.js', () => ({
  AgentDb: class MockAgentDb {
    messages = mockMessageLog;
    upsertParticipant = vi.fn(); participantExists = vi.fn(() => true);
    getAllParticipants = vi.fn(() => []);
    recordOutboundRequest = vi.fn(); recordInboundRequest = vi.fn();
    getOutboundRequest = vi.fn(() => undefined); getInboundRequest = vi.fn(() => undefined);
    updateRequestStatus = vi.fn();
    listRequests = vi.fn(() => ({ inbound: [], outbound: [] }));
    getOpenInboundRequests = vi.fn(() => []);
    closeAllRequests = vi.fn(() => ({ closedInbound: [], closedOutboundCount: 0 }));
    logEvent = vi.fn(); readEvents = vi.fn(() => []); countEvents = vi.fn(() => 0);
    close = vi.fn();
  },
}));

vi.mock('./console/console-db.js', () => ({
  ConsoleDb: class MockConsoleDb {
    messages = mockMessageLog;
    close = vi.fn();
  },
}));

vi.mock('./lib/format.js', () => ({
  formatMessages: vi.fn((msgs: Array<{ sender_name: string; content: string }>) =>
    msgs.map((m) => `[${m.sender_name}]: ${m.content}`).join('\n')),
  formatOutbound: vi.fn((t: string) => t),
  stripFrameworkTags: vi.fn((t: string) =>
    t
      .replace(/<cast:(internal|watch|schedule|service|lifecycle)\b[^>]*>[\s\S]*?<\/cast:\1>/g, '')
      .replace(/<\/?cast:(internal|watch|schedule|service|lifecycle)\b[^>]*>/g, '')
      .trim()),
  validateAgentOutput: vi.fn((raw: string) => ({
    ok: true,
    parsed: { text: raw || null, internal: null, queries: [], answers: [] },
  })),
  escapeXml: vi.fn((s: string) => s),
  formatTagAttrs: vi.fn((attrs?: Record<string, string>) =>
    attrs
      ? Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('')
      : ''),
}));

// --- Imports (after mocks) ---

import { _initTestGatewayDb } from './gateway/gateway-db.js';
import { LocalIdentityProvider } from './auth/identity.js';
import { AgentManager } from './agent/agent-manager.js';
import { conversations, slotPool, _resetConversationsForTest } from './lib/gates.js';
import { Bus } from './gateway/bus.js';
import { MessageGateway } from './gateway/message-gateway.js';
import { writeToAgent } from './container/container-runner.js';
import { createSnapshot, cleanupSnapshot } from './console/snapshot.js';
import { _setMockWatcher } from './lib/config-reader.js';
import type { Host } from './types.js';
import type { Transport } from './transports/schema.js';
import type { FileWatcher } from './lib/file-watcher.js';
import fs from 'fs';

// --- Fixtures ---

const TEST_ACL = JSON.stringify({ owner: 'operator', peers: {} });

function resetFsMocks(): void {
  vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
    if (typeof p === 'string' && p.includes('acl.json')) return true;
    return false;
  });
  vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
    if (typeof p === 'string' && p.includes('acl.json')) return TEST_ACL;
    return '{}';
  });
  vi.mocked(fs.mkdirSync).mockImplementation((() => undefined) as never);
  vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
  vi.mocked(fs.readdirSync).mockImplementation((() => []) as never);
  vi.mocked(fs.rmSync).mockImplementation(() => undefined);
  _setMockWatcher({
    get: (p) => { try { return vi.mocked(fs.readFileSync)(p, 'utf-8') as string; } catch { return null; } },
  });
}

const stubWatcher = {
  watch: () => {}, unwatch: () => {},
  get: (p: string) => { try { return vi.mocked(fs.readFileSync)(p, 'utf-8') as string; } catch { return null; } },
  onChange: () => {}, shutdown: async () => {},
  get version() { return 0; },
} as unknown as FileWatcher;

function makeMockTransport(): Transport {
  return {
    name: 'test',
    send: vi.fn(async () => {}),
    sendEvent: vi.fn(async () => {}),
    ownsParticipant: () => true,
    isConnected: () => true,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
}

function makeHost(folder: string): Host { return { name: folder, folder }; }
function agentGuid(folder: string): string { return `a:test-${folder}@test`; }

async function setupManager(folder: string): Promise<{ mgr: AgentManager; bus: Bus; transport: Transport }> {
  const transport = makeMockTransport();
  const bus = new Bus();
  const gw = new MessageGateway({
    bus, transports: () => [transport],
    identityProvider: LocalIdentityProvider._createTest(),
  });
  const host = makeHost(folder);
  const agentId = agentGuid(folder);
  const mgr = new AgentManager({ host, bus, mcpDeps: undefined, agentId, watcher: stubWatcher });
  await mgr.init();
  bus.register(agentId, mgr, 'exact', { label: folder, type: 'agent', folderPath: folder });
  // Note: test uses folder as alias (label) — equivalent to a manifest.name === folder setup.
  bus.register('local', gw, 'prefix');
  bus.register('cli', gw, 'prefix');
  return { mgr, bus, transport };
}

// =============================================================================
// Note (post SessionHost retirement): the legacy SessionHost-internal invariants
// (enqueue/release ordering, result-resolver map, identity-check on delete,
// staging-dir cleanup, shared-gate concurrent normal+console sessions,
// shutdown drain timing) are all covered by Conversation/Catalog/SlotPool
// unit tests under `conversations/` plus e2e runs. They lived
// here historically because the same plumbing also exercised AgentManager
// wiring; with the Conversations façade owning that machinery, the residual
// AgentManager-level invariants worth integration coverage are the console
// session smoke, config-watcher invalidation, key fingerprint, and single-
// shot lifecycle — all preserved below.
// =============================================================================

// =============================================================================
// Console session end-to-end smoke test
// =============================================================================

describe('Console session smoke (__design channel)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    containerMocks = [];
    _resetConversationsForTest();
    resetFsMocks();
    _initTestGatewayDb();
  });

  // Trust-boundary ACL for console-channel traffic lives at
  // `agent-bus-handler.ts` (bus → agent boundary). `ConsoleManager.route`
  // does NOT re-gate — duplicating that check would redundantly gate bus
  // arrivals and misapply to local intra-agent dispatch (the G5 silent-
  // drop bug). For bus-arrival receiver-side ACL coverage on console
  // channels (including denial of non-operator agent identities pushing
  // to `__design`/`__configure`), see `agent-bus-handler.test.ts`.
  //
  // This smoke test only verifies that `mgr.route` delivers into
  // ConsoleManager's session-host for an authorized caller — the path
  // that the bus handler hands off to after its own gate passes.
  it('routes to ConsoleManager session-host when called with operator credentials', async () => {
    const { mgr } = await setupManager('alpha');
    const addr = agentGuid('alpha');
    const p = mgr.route(addr, 'cli:user', 'help', { channel: '__design' });
    // Wait for container spawn — proves route reached the session-host
    // machinery (which it should, because bus handler would have already
    // gated this in production).
    await vi.waitFor(() => {
      expect(containerMocks.length).toBeGreaterThanOrEqual(1);
    });
    containerMocks[0].finish('ok');
    const result = await p;
    expect(result.ok).toBe(true);
  });

  it('creates a snapshot, spawns with console mounts and full network, cleans up on teardown', async () => {
    const { mgr } = await setupManager('alpha');
    const addr = agentGuid('alpha');

    const p = mgr.route(addr, 'cli:user', 'help me edit blueprint', { channel: '__design' });

    // Console spawn awaits `mcp.ready` before runContainerAgent is called, so
    // the container mock appears on a later microtask. The factory runs
    // synchronously when the slot is acquired — `createSnapshot` fires there.
    await vi.waitFor(() => {
      expect(containerMocks.length).toBeGreaterThanOrEqual(1);
    });
    expect(createSnapshot).toHaveBeenCalledTimes(1);
    await containerMocks[0].started;

    // Container got console-specific container input.
    expect(containerMocks[0].input.containerNetwork).toBe('full');
    expect(containerMocks[0].input.workdir).toBe('/agent/blueprint');
    expect(Array.isArray(containerMocks[0].input.overrideMounts)).toBe(true);
    expect(containerMocks[0].input.overrideMounts!.length).toBeGreaterThan(0);

    containerMocks[0].finish('ok');

    await p;

    // New semantic: a successful spawn leaves the conversation in
    // `idle-with-runner` holding its slot — the runner stays warm for the
    // next message. The `runner-removed` bus event (which the ConsoleManager
    // routes to per-strategy snapshot cleanup) fires on
    // teardown: expiry, swap-eviction, invalidate-replace, or shutdown.
    // Verify the cleanup wiring fires on AgentManager shutdown.
    expect(cleanupSnapshot).not.toHaveBeenCalled();
    await mgr.shutdown();
    await vi.waitFor(() => {
      expect(cleanupSnapshot).toHaveBeenCalledTimes(1);
    });
  });
});

// =============================================================================
// Concurrent normal + console sessions
// =============================================================================

describe('Concurrent normal + console sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    containerMocks = [];
    _resetConversationsForTest();
    resetFsMocks();
    _initTestGatewayDb();
  });

  // AgentManager and ConsoleManager share the process-wide `slotPool` (one
  // unified budget). Concurrent normal + console sessions each consume a slot
  // from the same budget; pressure resolves by paging (LRU swap-eviction owned
  // by `ConversationCatalog`), not by gate isolation.
  it('normal and console sessions both charge the shared slotPool', async () => {
    const { mgr } = await setupManager('alpha');
    const addr = agentGuid('alpha');

    mgr.route(addr, 'cli:user', 'normal msg');
    mgr.route(addr, 'cli:user', 'console msg', { channel: '__design' });

    await vi.waitFor(() => {
      expect(containerMocks).toHaveLength(2);
    });
    await containerMocks[0].started;
    await containerMocks[1].started;

    expect(slotPool.active).toBe(2);

    containerMocks[0].finish('normal done');
    containerMocks[1].finish('console done');

    // Post-Phase-C warm-runner semantic: a successful spawn-cycle leaves the
    // conversation in `idle-with-runner` holding its slot. Slots release on
    // teardown (TTL, swap-eviction, invalidate, or shutdown). Drive shutdown
    // to drain.
    await mgr.shutdown();
    await vi.waitFor(() => {
      expect(slotPool.active).toBe(0);
    });
  });
});

// =============================================================================
// config/ watcher invalidation
// =============================================================================

/**
 * Builds a watcher that records every onChange callback per directory so the
 * test can fire them on demand. Other watcher methods are no-ops — only
 * subscription capture is exercised here.
 */
function makeCapturingWatcher(): {
  watcher: FileWatcher;
  fire: (dir: string, filePath: string) => void;
} {
  const handlers = new Map<string, Array<(filePath: string) => void>>();
  const watcher = {
    watch: () => {},
    unwatch: () => {},
    get: (p: string) => {
      try { return vi.mocked(fs.readFileSync)(p, 'utf-8') as string; } catch { return null; }
    },
    onChange: (dir: string, cb: (filePath: string) => void) => {
      const list = handlers.get(dir) ?? [];
      list.push(cb);
      handlers.set(dir, list);
    },
    shutdown: async () => {},
    get version() { return 0; },
  } as unknown as FileWatcher;
  const fire = (dir: string, filePath: string): void => {
    for (const cb of handlers.get(dir) ?? []) cb(filePath);
  };
  return { watcher, fire };
}

async function setupManagerWithCapture(folder: string): Promise<{
  mgr: AgentManager;
  fire: (dir: string, filePath: string) => void;
}> {
  const transport = makeMockTransport();
  const bus = new Bus();
  const gw = new MessageGateway({
    bus, transports: () => [transport],
    identityProvider: LocalIdentityProvider._createTest(),
  });
  const host = makeHost(folder);
  const agentId = agentGuid(folder);
  const { watcher, fire } = makeCapturingWatcher();
  const mgr = new AgentManager({ host, bus, mcpDeps: undefined, agentId, watcher });
  await mgr.init();
  bus.register(agentId, mgr, 'exact', { label: folder, type: 'agent', folderPath: folder });
  bus.register('local', gw, 'prefix');
  bus.register('cli', gw, 'prefix');
  return { mgr, fire };
}

describe('config/ watcher invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    containerMocks = [];
    _resetConversationsForTest();
    resetFsMocks();
    _initTestGatewayDb();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The debounce window from `config.ts::CONFIG_RELOAD_DEBOUNCE_MS`. Mocked at
  // the top of this file to 15_000ms. Keep these in sync if the constant moves.
  const DEBOUNCE_MS = 15_000;

  it.each([
    'agent.json',
    'provisions.json',
    'mcp-servers.json',
  ])('config/%s change schedules debounced markAllInvalidated', async (filename) => {
    const { mgr, fire } = await setupManagerWithCapture('alpha');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgrAny = mgr as any;
    const spy = vi.spyOn(conversations, 'invalidateScope');

    fire('/tmp/cast-test-agents/alpha/config', `/tmp/cast-test-agents/alpha/config/${filename}`);

    // No fire before window elapses — proves the debounce gate.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(spy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // Both-branches discipline: the filter must reject paths it doesn't recognize.
  it('config/foo.json (unrecognized) does NOT schedule a reload', async () => {
    const { mgr, fire } = await setupManagerWithCapture('alpha');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgrAny = mgr as any;
    const spy = vi.spyOn(conversations, 'invalidateScope');

    fire('/tmp/cast-test-agents/alpha/config', '/tmp/cast-test-agents/alpha/config/foo.json');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rapid edits within the window coalesce into one markAllInvalidated', async () => {
    const { mgr, fire } = await setupManagerWithCapture('alpha');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgrAny = mgr as any;
    const spy = vi.spyOn(conversations, 'invalidateScope');

    for (let i = 0; i < 5; i++) {
      fire('/tmp/cast-test-agents/alpha/config', '/tmp/cast-test-agents/alpha/config/agent.json');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 100);
    }
    // Now elapse the final quiet window.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // schedule.txt is hot-reloaded by AgentScheduler; not a runner spawn input.
  // Both-branches discipline: schedule.txt must NOT trigger markAllInvalidated.
  it('blueprint/props/schedule.txt does NOT trigger markAllInvalidated', async () => {
    const { mgr, fire } = await setupManagerWithCapture('alpha');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgrAny = mgr as any;
    const spy = vi.spyOn(conversations, 'invalidateScope');

    fire(
      '/tmp/cast-test-agents/alpha/blueprint/props',
      '/tmp/cast-test-agents/alpha/blueprint/props/schedule.txt',
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);

    expect(spy).not.toHaveBeenCalled();
  });

  // Both-branches discipline: a non-schedule blueprint/props edit MUST trigger
  // invalidation. Pairs with the schedule.txt negative case above.
  it('blueprint/props/settings.json DOES trigger debounced markAllInvalidated', async () => {
    const { mgr, fire } = await setupManagerWithCapture('alpha');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgrAny = mgr as any;
    const spy = vi.spyOn(conversations, 'invalidateScope');

    fire(
      '/tmp/cast-test-agents/alpha/blueprint/props',
      '/tmp/cast-test-agents/alpha/blueprint/props/settings.json',
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// AgentManager.shutdown drain contract: the SIGKILL fallback and natural-close
// paths are covered by e2e runs (SIGKILL crash recovery) and by
// `conversations.shutdownScope` unit tests. The previous integration probe
// reached into `sessionHost.getRunners()` internals that no longer exist
// post SessionHost retirement.
// =============================================================================

// =============================================================================
// AgentManager.computeKeyFingerprint — used by the AGENTS_DIR reconciler to
// detect rapid-churn rebuilds (folder unlinked + recreated within debounce).
// =============================================================================

describe('AgentManager.computeKeyFingerprint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFsMocks();
  });

  it('returns sha256 of secrets/agent.key content', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('secrets/agent.key')) {
        return Buffer.from('PRIVATE-KEY-A') as unknown as string;
      }
      return '{}';
    });
    const fp = AgentManager.computeKeyFingerprint('alpha');
    // sha256 hex is 64 chars; deterministic.
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different fingerprints for different key contents', () => {
    let returnA = true;
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('secrets/agent.key')) {
        return Buffer.from(returnA ? 'KEY-A' : 'KEY-B') as unknown as string;
      }
      return '{}';
    });
    const fpA = AgentManager.computeKeyFingerprint('alpha');
    returnA = false;
    const fpB = AgentManager.computeKeyFingerprint('alpha');
    expect(fpA).not.toBe(fpB);
  });

  it('returns empty string when key file is unreadable (treated as always-mismatch)', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('secrets/agent.key')) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return '{}';
    });
    expect(AgentManager.computeKeyFingerprint('alpha')).toBe('');
  });
});

// =============================================================================
// Single-shot lifecycle decoupling
// =============================================================================
//
// Single-shot channels (idle_timeout: null) historically skipped both bootstrap
// and cleanup hooks unconditionally. The runner now honors `bootstrapEnabled`
// and `cleanupEnabled` (derived from the channel.json `lifecycle` enum) on
// single-shot the same way persistent channels do — bootstrap runs in
// topology-only mode (no prior session), cleanup pipes a `<cast:lifecycle>`
// turn into the still-running container via `runner.expire(message)` right
// after the reply, then closes when the cleanup turn completes.
//
// These tests verify the four-cell matrix of lifecycle × single-shot:
//   - "full"          → bootstrap fires, cleanup IPC fires
//   - "none"          → neither fires (regression guard; today's behavior)
//   - "cleanup-only"  → cleanup IPC fires, no bootstrap
//   - "bootstrap-only"→ bootstrap fires, no cleanup IPC

interface SingleShotChannelOpts {
  lifecycle: 'none' | 'bootstrap-only' | 'cleanup-only' | 'full';
  bootstrap?: string;
  cleanup?: string;
}

/**
 * Set up FS mocks so `loadChannelsConfig` returns a single `default` channel
 * with the given lifecycle and optional bootstrap/cleanup body text. The
 * channel-config loader reads via `fs.readdirSync` + `readText` (which routes
 * through the test mockWatcher → `fs.readFileSync`), so we override both.
 */
function setupSingleShotDefaultChannel(folder: string, opts: SingleShotChannelOpts): void {
  const channelsDir = `/tmp/cast-test-agents/${folder}/blueprint/channels`;
  const defaultDir = `${channelsDir}/default`;
  const channelJson = JSON.stringify({ idle_timeout: null, lifecycle: opts.lifecycle });

  vi.mocked(fs.readdirSync).mockImplementation(((p: unknown) => {
    if (typeof p === 'string' && p === channelsDir) {
      return [{ name: 'default', isDirectory: () => true } as unknown as fs.Dirent];
    }
    return [];
  }) as never);

  vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
    if (typeof p !== 'string') return '{}';
    if (p.includes('acl.json')) return TEST_ACL;
    if (p === `${defaultDir}/channel.json`) return channelJson;
    if (opts.bootstrap && p === `${defaultDir}/bootstrap.md`) return opts.bootstrap;
    if (opts.cleanup && p === `${defaultDir}/cleanup.md`) return opts.cleanup;
    return '{}';
  });
}

/** Find the writeToAgent invocation that piped the cleanup `<cast:lifecycle>` turn. */
function findCleanupIpc(): unknown {
  return vi.mocked(writeToAgent).mock.calls.find(([, msg]) => {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as { type?: string; text?: string };
    return m.type === 'message' && typeof m.text === 'string'
      && m.text.startsWith('<cast:lifecycle>This conversation is closing.');
  });
}

describe('Single-shot honors lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    containerMocks = [];
    _resetConversationsForTest();
    resetFsMocks();
    _initTestGatewayDb();
  });

  it('lifecycle: "full" — bootstrap passed and cleanup IPC fires after reply', async () => {
    setupSingleShotDefaultChannel('alpha', {
      lifecycle: 'full',
      bootstrap: 'bootstrap body',
      cleanup: 'cleanup body',
    });
    const { mgr, transport } = await setupManager('alpha');
    const addr = agentGuid('alpha');

    mgr.route(addr, 'cli:user', 'hello');
    await containerMocks[0]!.started;

    // Bootstrap content was threaded into the container input. The profile
    // bootstrap is prepended by agent-route.ts:144-153, so check substring.
    expect(containerMocks[0]!.input.bootstrap).toContain('bootstrap body');

    containerMocks[0]!.finish('reply text');

    // Reply lands on the transport, then cleanup pipes via writeToAgent.
    await vi.waitFor(() => {
      expect(transport.send).toHaveBeenCalled();
      expect(findCleanupIpc()).toBeDefined();
    });

    const replyCallOrder = vi.mocked(transport.send).mock.invocationCallOrder[0]!;
    const cleanupCall = vi.mocked(writeToAgent).mock.calls.findIndex(([, msg]) => {
      const m = msg as { type?: string; text?: string };
      return m.type === 'message' && typeof m.text === 'string'
        && m.text.startsWith('<cast:lifecycle>');
    });
    expect(cleanupCall).toBeGreaterThanOrEqual(0);
    const cleanupCallOrder = vi.mocked(writeToAgent).mock.invocationCallOrder[cleanupCall]!;
    // Reply must be enqueued onto the transport before cleanup starts piping.
    expect(replyCallOrder).toBeLessThan(cleanupCallOrder);
  });

  it('lifecycle: "none" — no bootstrap and no cleanup IPC (regression guard)', async () => {
    setupSingleShotDefaultChannel('alpha', { lifecycle: 'none' });
    const { mgr, transport } = await setupManager('alpha');
    const addr = agentGuid('alpha');

    mgr.route(addr, 'cli:user', 'hello');
    await containerMocks[0]!.started;
    expect(containerMocks[0]!.input.bootstrap).toBeUndefined();

    containerMocks[0]!.finish('reply text');

    await vi.waitFor(() => {
      expect(transport.send).toHaveBeenCalled();
    });
    expect(findCleanupIpc()).toBeUndefined();
  });

  it('lifecycle: "cleanup-only" — cleanup IPC fires, bootstrap does not', async () => {
    setupSingleShotDefaultChannel('alpha', {
      lifecycle: 'cleanup-only',
      cleanup: 'cleanup body',
    });
    const { mgr, transport } = await setupManager('alpha');
    const addr = agentGuid('alpha');

    mgr.route(addr, 'cli:user', 'hello');
    await containerMocks[0]!.started;
    expect(containerMocks[0]!.input.bootstrap).toBeUndefined();

    containerMocks[0]!.finish('reply text');

    await vi.waitFor(() => {
      expect(transport.send).toHaveBeenCalled();
      expect(findCleanupIpc()).toBeDefined();
    });
  });

  it('lifecycle: "bootstrap-only" — bootstrap fires, cleanup IPC does not', async () => {
    setupSingleShotDefaultChannel('alpha', {
      lifecycle: 'bootstrap-only',
      bootstrap: 'bootstrap body',
    });
    const { mgr, transport } = await setupManager('alpha');
    const addr = agentGuid('alpha');

    mgr.route(addr, 'cli:user', 'hello');
    await containerMocks[0]!.started;
    expect(containerMocks[0]!.input.bootstrap).toContain('bootstrap body');

    containerMocks[0]!.finish('reply text');

    await vi.waitFor(() => {
      expect(transport.send).toHaveBeenCalled();
    });
    expect(findCleanupIpc()).toBeUndefined();
  });
});


// =============================================================================
// Transport-blind spawn seam — buildRunnerOpts feeds `replyTo || participant`
// into assembleSystemPrompt, whose isParticipantAddress guard is the single
// validation point for everything the runner later trusts (participantAddress
// = the same expression). assembleSystemPrompt is module-mocked here, so these
// tests pin the WIRING (which value reaches the guard); the guard's BEHAVIOR
// on that value (bare accepted, compound/raw-wire rejected) is pinned in
// prompt-assembly.test.ts. Together they cover the cold-spawn push regression.
// =============================================================================

describe('buildRunnerOpts — participant guard seam', () => {
  const TEST_CHANNEL = {
    idle_timeout: null,
    lifecycle: 'none',
    log_messages: false,
    use_sharding: false,
    disabled_tools: [],
  };

  type SeamParams = {
    address: string;
    conversationKey: string;
    channel: unknown;
    channelName: string;
    participant?: string;
    replyTo?: string;
  };
  function callSeam(mgr: AgentManager, p: { participant?: string; replyTo?: string }): void {
    const m = mgr as unknown as { buildRunnerOpts: (params: SeamParams) => unknown };
    m.buildRunnerOpts({
      address: 'a:test-seam@test',
      conversationKey: `default|${p.replyTo ?? p.participant ?? ''}`,
      channel: TEST_CHANNEL,
      channelName: 'default',
      ...p,
    });
  }

  async function promptSpy() {
    const { assembleSystemPrompt } = await import('./agent/prompt-assembly.js');
    return vi.mocked(assembleSystemPrompt);
  }

  it('a bare push/scheduler target reaches the guard as-is', async () => {
    const { mgr } = await setupManager('seam-bare');
    const spy = await promptSpy();
    spy.mockClear();
    callSeam(mgr, { participant: 'u:f9a68fcd75@a9bdb7' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].participant).toBe('u:f9a68fcd75@a9bdb7');
  });

  it('replyTo takes precedence — the delegation leg is what the guard validates', async () => {
    // participantAddress (message-log writer + outbound routing) is
    // `replyTo || participant`; the guard must see the SAME value, or the
    // writer would trust an unvalidated leg.
    const { mgr } = await setupManager('seam-replyto');
    const spy = await promptSpy();
    spy.mockClear();
    callSeam(mgr, { participant: 'u:original@srv', replyTo: 'u:delegate@srv' });
    expect(spy.mock.calls[0]![0].participant).toBe('u:delegate@srv');
  });
});
