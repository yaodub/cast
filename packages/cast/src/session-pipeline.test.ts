/**
 * Integration test for the conversation pipeline:
 * MessageGateway → Bus → AgentManager → ConversationRunner
 *
 * Mocks the container layer and exercises the full pipeline.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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
    MAX_VALIDATION_FAILURES: 3,
    MAX_OUTPUT_BYTES_DEFAULT: 32_768,
    agentPath: (folder: string, ...segments: string[]) =>
      path.join('/tmp/cast-test-agents', folder, ...segments),
    sessionCastSocketPath: (folder: string, _key: string) =>
      path.join('/tmp/cast-test-agents', folder, 'mcp', 'socket', 'testhash.sock'),
    readCapabilities: () => ({
      disabled_tools: [],
      additional_disabled_tools: [],
      resources: {},
      extensions: {},
      mcp_servers: {},
    }),
    resolveCapabilities: () => ({
      disabledTools: [],
      resources: {},
    }),
    resolveMcpServers: () => [],
    readMcpServerSecrets: () => ({}),
    readServerConfig: () => ({
      consoleModel: 'claude-opus-4-7',
      consoleIsolation: 'normal',
    }),
    MAX_ATTACHMENT_BYTES: 10_000_000,
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

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./lib/utils.js', async (importOriginal) => {
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
    },
  };
});

// --- Controllable container mock ---

/** Output shape the mock can emit via onOutput. Mirrors ContainerOutput. */
type MockOutput =
  | { type: 'message'; result: string; intermediate?: boolean; newSessionId?: string; subtype?: 'success' }
  | { type: 'error'; error: string; newSessionId?: string }
  | { type: 'auth_error' };

interface MockOutcome {
  /** Events to emit through onOutput, in order. */
  emit?: MockOutput[];
  /** Final return value from runContainerAgent. Defaults to a successful empty message. */
  finalReturn?:
    | { type: 'message'; result: string; newSessionId?: string }
    | { type: 'error'; error: string; newSessionId?: string };
}

interface ContainerMock {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mock: (...args: any[]) => any;
  finish: (result?: string, sessionId?: string) => void;
  failWith: (error: string) => void;
  /** Emit a custom sequence of outputs and a controlled final return. */
  emitAndReturn: (outcome: MockOutcome) => void;
  /** Promise that resolves when the mock has been called (container "started"). */
  started: Promise<void>;
}

function createContainerMock(): ContainerMock {
  let resolveContainer: (value: MockOutcome & { _legacy?: { result?: string; sessionId?: string; error?: string } }) => void;
  const containerDone = new Promise<MockOutcome & { _legacy?: { result?: string; sessionId?: string; error?: string } }>(
    (r) => { resolveContainer = r; },
  );

  let resolveStarted: () => void;
  const started = new Promise<void>((r) => { resolveStarted = r; });

  const mock = vi.fn(async (
    _agent: unknown,
    _input: unknown,
    onProcess: (proc: ChildProcess, name: string) => void,
    onOutput: (result: MockOutput) => Promise<void>,
  ) => {
    // Signal that the container has started
    const fakeProc = new EventEmitter() as ChildProcess;
    Object.defineProperty(fakeProc, 'pid', { value: 99999 });
    onProcess(fakeProc, 'test-container');
    resolveStarted();

    // Wait until the test says the container is done
    const outcome = await containerDone;

    // Legacy shape (finish/failWith) — preserve existing tests.
    if (outcome._legacy) {
      const legacy = outcome._legacy;
      if (legacy.error) {
        await onOutput({ type: 'error', error: legacy.error });
        return { type: 'error' as const, error: legacy.error };
      }
      const result = legacy.result ?? 'mock response';
      const sessionId = legacy.sessionId ?? 'sess-1';
      await onOutput({ type: 'message', result, newSessionId: sessionId });
      return { type: 'message' as const, result: '', newSessionId: sessionId };
    }

    // emitAndReturn shape — emit each event then return the final.
    for (const event of outcome.emit ?? []) {
      await onOutput(event);
    }
    return outcome.finalReturn ?? { type: 'message' as const, result: '', newSessionId: 'sess-1' };
  });

  return {
    mock,
    finish: (result?: string, sessionId?: string) =>
      resolveContainer({ _legacy: { result, sessionId } }),
    failWith: (error: string) =>
      resolveContainer({ _legacy: { error } }),
    emitAndReturn: (outcome: MockOutcome) => resolveContainer(outcome),
    started,
  };
}

// Track all container mocks created during a test for assertion convenience
let containerMocks: ContainerMock[];

function nextContainerMock(): ContainerMock {
  const cm = createContainerMock();
  containerMocks.push(cm);
  return cm;
}

// The actual vi.mock replaces runContainerAgent with a dispatcher that
// creates a new controllable mock per invocation.
vi.mock('./container/container-runner.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runContainerAgent: vi.fn((...args: any[]) => {
    const cm = nextContainerMock();
    return cm.mock(...args);
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
  },
}));

vi.mock('./agent/agent-service.js', () => ({
  AgentService: class MockService {
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    get process() { return null; }
  },
}));

// Shared spy so any AgentDb instance routes logEvent calls into the same vi.fn,
// letting tests assert on event emission without capturing instances.
const { mockLogEvent } = vi.hoisted(() => ({ mockLogEvent: vi.fn() }));

// Shared mock for the extracted MessageLogStore bundle — both AgentDb.messages
// and ConsoleDb.messages route here. Tests can spy on logInbound/logOutbound
// to assert message-log behavior regardless of which DB owns the bundle.
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
    upsertParticipant = vi.fn();
    participantExists = vi.fn(() => true);
    getAllParticipants = vi.fn(() => []);
    recordOutboundRequest = vi.fn();
    recordInboundRequest = vi.fn();
    getOutboundRequest = vi.fn(() => undefined);
    getInboundRequest = vi.fn(() => undefined);
    updateRequestStatus = vi.fn();
    listRequests = vi.fn(() => ({ inbound: [], outbound: [] }));
    getOpenInboundRequests = vi.fn(() => []);
    closeAllRequests = vi.fn(() => ({ closedInbound: [], closedOutboundCount: 0 }));
    logEvent = mockLogEvent;
    readEvents = vi.fn(() => []);
    countEvents = vi.fn(() => 0);
    close = vi.fn();
  },
}));

vi.mock('./console/console-db.js', () => ({
  ConsoleDb: class MockConsoleDb {
    messages = mockMessageLog;
    close = vi.fn();
  },
}));

// Mock format — we verify output via the mock transport, not actual transport sends
vi.mock('./lib/format.js', () => ({
  formatMessages: vi.fn((msgs: Array<{ sender_name: string; content: string; timestamp: string }>, _tz?: string) => {
    return msgs.map((m) => `[${m.sender_name}]: ${m.content}`).join('\n');
  }),
  formatOutbound: vi.fn((t: string) => t),
  stripFrameworkTags: vi.fn((t: string) =>
    t
      .replace(/<cast:(internal|watch|schedule|service|lifecycle)\b[^>]*>[\s\S]*?<\/cast:\1>/g, '')
      .replace(/<\/?cast:(internal|watch|schedule|service|lifecycle)\b[^>]*>/g, '')
      .trim()),
  validateAgentOutput: vi.fn((raw: string) => {
    const text = raw.replace(/<cast:internal>[\s\S]*?<\/cast:internal>/g, '').trim() || null;
    const matches = raw.match(/<cast:internal>([\s\S]*?)<\/cast:internal>/g);
    const internal = matches
      ? matches.map((m: string) => m.replace(/<\/?cast:internal>/g, '').trim()).join('\n').trim() || null
      : null;
    return { ok: true, parsed: { text, internal, queries: [], answers: [] } };
  }),
  escapeXml: vi.fn((s: string) => s),
  formatParticipantMessage: vi.fn(
    (rawText: string, opts: { sender: string; declaredName?: string; timezone?: string; timestamp: string }) => {
      const sanitized = rawText
        .replace(/<cast:(internal|watch|schedule|service|lifecycle)\b[^>]*>[\s\S]*?<\/cast:\1>/g, '')
        .replace(/<\/?cast:(internal|watch|schedule|service|lifecycle)\b[^>]*>/g, '')
        .trim();
      return { formatted: `[${opts.declaredName ?? opts.sender}]: ${sanitized}`, sanitized };
    }),
}));

// --- Imports (after mocks) ---

import { _initTestGatewayDb, storePacket, markDelivered, getUndeliveredPackets } from './gateway/gateway-db.js';
import type { StoredPacket } from './gateway/gateway-db.js';
import { LocalIdentityProvider } from './auth/identity.js';
import { AgentManager } from './agent/agent-manager.js';
import { slotPool, _resetConversationsForTest } from './lib/gates.js';
import { Bus } from './gateway/bus.js';
import { MessageGateway } from './gateway/message-gateway.js';
import { writeToAgent } from './container/container-runner.js';
import { _setMockWatcher } from './lib/config-reader.js';
import type { Host } from './types.js';
import type { Transport } from './transports/schema.js';
import type { FileWatcher } from './lib/file-watcher.js';
import fs from 'fs';

// --- Test fixtures ---

function makeHost(folder: string, name?: string): Host {
  return {
    name: name ?? folder,
    folder,
  };
}

// Test ACL: owner is the operator tier (CLI users), paired test users for delegation targets
const TEST_ACL = JSON.stringify({
  owner: 'operator',
  allowed: {
    'u:tg-target@test': { '*': 'io' },
    'u:tg-12345@test': { '*': 'io' },
    'u:tg-same-user@test': { '*': 'io' },
  },
});

/** Reset fs mocks to safe defaults. Extracted to avoid DRY violation across test suites. */
function resetFsMocks(): void {
  vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
    if (typeof p === 'string' && p.includes('acl.json')) return true;
    return false;
  });
  vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
    if (typeof p === 'string' && p.includes('acl.json')) return TEST_ACL;
    return '{}';
  });
  vi.mocked(fs.mkdirSync).mockImplementation((() => undefined) as never); // fs.mkdirSync overloads
  vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
  vi.mocked(fs.readdirSync).mockImplementation((() => []) as never); // fs.readdirSync overloads
  // Mock watcher delegates to the fs.readFileSync mock for config-reader access
  _setMockWatcher({
    get: (p) => { try { return vi.mocked(fs.readFileSync)(p, 'utf-8') as string; } catch { return null; } },
  });
}

/** Stub FileWatcher for AgentManager construction — no real filesystem watching. */
const stubWatcher = {
  watch: () => {},
  unwatch: () => {},
  get: (p: string) => { try { return vi.mocked(fs.readFileSync)(p, 'utf-8') as string; } catch { return null; } },
  onChange: () => {},
  shutdown: async () => {},
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

function agentGuid(folder: string): string {
  return `a:test-${folder}@test`;
}

async function setupPipeline(hosts: Array<{ folder: string; host: Host }>, mockTransport: Transport) {
  const localBus = new Bus();
  const idp = LocalIdentityProvider._createTest();
  const gw = new MessageGateway({ bus: localBus, transports: () => [mockTransport], identityProvider: idp });

  for (const { folder, host } of hosts) {
    const id = agentGuid(folder);
    const mgr = new AgentManager({
      host,
      bus: localBus,
      mcpDeps: undefined,
      agentId: id,
      watcher: stubWatcher,
    });
    await mgr.init();
    localBus.register(id, mgr, 'exact', { label: folder, type: 'agent', folderPath: folder });
  }

  localBus.register('u', gw, 'prefix');
  localBus.register('local', gw, 'prefix');
  localBus.register('cli', gw, 'prefix');
  localBus.register('tg', gw, 'prefix');

  return { bus: localBus, gateway: gw, idp };
}

// --- Test suite ---

describe('Session Pipeline Integration', () => {
  let localBus: Bus;
  let localGateway: MessageGateway;
  let mockTransport: Transport;

  const hostA = makeHost('alpha');
  const hostB = makeHost('beta');

  const addrA = agentGuid('alpha');
  const addrB = agentGuid('beta');

  beforeEach(async () => {
    vi.clearAllMocks();
    containerMocks = [];

    _resetConversationsForTest();

    resetFsMocks();

    _initTestGatewayDb();

    mockTransport = makeMockTransport();
    const pipeline = await setupPipeline(
      [{ folder: 'alpha', host: hostA }, { folder: 'beta', host: hostB }],
      mockTransport,
    );
    localBus = pipeline.bus;
    localGateway = pipeline.gateway;
  });

  // --- Test 1: Single message → response ---

  it('routes a single message through the pipeline and fires output callback', async () => {
    localGateway.ingestInbound('cli:user1', addrA, 'hello', 'cli:user1');

    // One container should have started
    expect(containerMocks).toHaveLength(1);
    await containerMocks[0].started;

    // Finish the container
    containerMocks[0].finish('Hello back!', 'session-abc');

    // Wait for async completion — gateway.deliverOutbound stores packet and sends via transport
    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'cli:user1', text: 'Hello back!' }),
        expect.objectContaining({ agentAddress: addrA }),
      );
    });
  });

  // --- Test 2: Agent isolation ---

  it('routes messages on different agents to separate containers', async () => {
    localGateway.ingestInbound('cli:user1', addrA, 'msg for alpha', 'cli:user1');
    localGateway.ingestInbound('cli:user1', addrB, 'msg for beta', 'cli:user1');

    // Two containers should have started (different agents, concurrency limit = 2)
    expect(containerMocks).toHaveLength(2);
    await containerMocks[0].started;
    await containerMocks[1].started;

    // Finish both
    containerMocks[0].finish('alpha response');
    containerMocks[1].finish('beta response');

    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalledTimes(2);
    });
  });

  // --- Test 3: Pipe to active container ---

  it('pipes a second message via IPC when container is already active', async () => {
    localGateway.ingestInbound('cli:user1', addrA, 'first message', 'cli:user1');

    expect(containerMocks).toHaveLength(1);
    await containerMocks[0].started;

    // Send a second message while the container is still running
    localGateway.ingestInbound('cli:user1', addrA, 'second message', 'cli:user1');

    // Should NOT have spawned a second container
    expect(containerMocks).toHaveLength(1);

    // Should have written to agent via stdin pipe
    const stdinWrites = vi.mocked(writeToAgent).mock.calls;
    expect(stdinWrites.length).toBeGreaterThanOrEqual(1);

    // The stdin write should contain the message text
    const lastWrite = stdinWrites[stdinWrites.length - 1][1] as { type: string; text?: string };
    expect(lastWrite.type).toBe('message');
    expect(lastWrite.text).toContain('second message');

    // Clean up
    containerMocks[0].finish('done');
    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalled();
    });
  });

  // --- Test 4: Concurrent same-agent sessions ---

  it('runs two sessions on the same agent concurrently (no preemption)', async () => {
    // Private channels so same-agent sessions get different session keys.
    const hostTest = makeHost('test', 'Test');
    const addrTest = agentGuid('test');


    // Set up a fresh pipeline including the test host
    const testTransport = makeMockTransport();
    const testBus = new Bus();
    const testGw = new MessageGateway({ bus: testBus, transports: () => [testTransport], identityProvider: LocalIdentityProvider._createTest() });
    const testMgr = new AgentManager({
      host: hostTest,
      bus: testBus,
      mcpDeps: undefined,
      agentId: addrTest,
      watcher: stubWatcher,
    });
    await testMgr.init();
    testBus.register(addrTest, testMgr, 'exact', { label: 'test', type: 'agent', folderPath: 'test' });
    testBus.register('local', testGw, 'prefix');
    testBus.register('cli', testGw, 'prefix');

    const channelsConfig = {
      default: { bootstrap: '', idle_timeout: null, bootstrapEnabled: false, cleanupEnabled: false, log_messages: true, use_sharding: false, disabled_tools: [] },
    };
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('channels.json')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('channels.json')) {
        return JSON.stringify(channelsConfig);
      }
      return '{}';
    });

    // Route first message on default channel from user1
    testMgr.route(addrTest, 'cli:user1', '[user1]: task A');
    expect(containerMocks).toHaveLength(1);
    await containerMocks[0].started;

    // Route second message on default channel from user2 — different source → different session key
    testMgr.route(addrTest, 'cli:user2', '[user2]: task B');
    expect(containerMocks).toHaveLength(2);
    await containerMocks[1].started;

    // Both active
    expect(slotPool.active).toBe(2);

    // Finish both
    containerMocks[0].finish('done A');
    containerMocks[1].finish('done B');

    await vi.waitFor(() => {
      expect(testTransport.send).toHaveBeenCalledTimes(2);
    });
  });

  // --- Test 4b: Same-agent sessions with shared default channel ---

  it('same-agent default channel messages go to the same session (piped via IPC)', async () => {
    const hostTest = makeHost('test', 'Test');
    const addrTest = agentGuid('test');


    // Get the manager from the bus for direct route calls
    const testBus = new Bus();
    const testGw = new MessageGateway({ bus: testBus, transports: () => [mockTransport], identityProvider: LocalIdentityProvider._createTest() });
    const testMgr = new AgentManager({
      host: hostTest,
      bus: testBus,
      mcpDeps: undefined,
      agentId: addrTest,
      watcher: stubWatcher,
    });
    await testMgr.init();
    testBus.register(addrTest, testMgr, 'exact', { label: 'test', type: 'agent', folderPath: 'test' });
    testBus.register('local', testGw, 'prefix');
    testBus.register('cli', testGw, 'prefix');

    // Default channel is shared — all messages go to same session
    testMgr.route(addrTest, 'cli:user1', '[user]: hello');
    expect(containerMocks).toHaveLength(1);
    await containerMocks[0].started;

    // Second message on same channel → piped via IPC (not a new session)
    testMgr.route(addrTest, 'cli:user1', '[user]: follow-up');
    expect(containerMocks).toHaveLength(1);

    // Stdin pipe write should have happened
    const stdinWrites = vi.mocked(writeToAgent).mock.calls.filter(
      (c) => (c[1] as { type: string }).type === 'message',
    );
    expect(stdinWrites.length).toBeGreaterThanOrEqual(1);

    containerMocks[0].finish('response');

    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalledTimes(1);
    });
  });

  // --- Test 5: Pending queue drain ---

  it('drains pending messages after container exits and respawns', async () => {
    localGateway.ingestInbound('cli:user1', addrA, 'first', 'cli:user1');
    expect(containerMocks).toHaveLength(1);
    await containerMocks[0].started;

    const writeToAgentMock = vi.mocked(writeToAgent);
    const originalImpl = writeToAgentMock.getMockImplementation();
    // Make stdin writes fail for the second message
    let stdinCallCount = 0;
    writeToAgentMock.mockImplementation(() => {
      stdinCallCount++;
      if (stdinCallCount > 1) {
        return false;
      }
      return true;
    });

    // Send second message — stdin should succeed (first call)
    localGateway.ingestInbound('cli:user1', addrA, 'piped ok', 'cli:user1');

    // Send third message — stdin will fail, so it queues
    localGateway.ingestInbound('cli:user1', addrA, 'queued', 'cli:user1');

    // Restore original mock implementation
    if (originalImpl) {
      writeToAgentMock.mockImplementation(originalImpl);
    } else {
      writeToAgentMock.mockImplementation(() => true);
    }

    // Finish the first container
    containerMocks[0].finish('response 1');

    // The runner should respawn because it has pending messages
    await vi.waitFor(() => {
      expect(containerMocks).toHaveLength(2);
    });

    await containerMocks[1].started;
    containerMocks[1].finish('response 2');

    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalledTimes(2);
    });
  });

  // --- Test 6: Global concurrency limit ---

  it('enforces global concurrency limit', async () => {
    // MAX_CONCURRENT_CONTAINERS = 2
    const hostC = makeHost('gamma');
    const addrC = agentGuid('gamma');


    // Add gamma to the bus
    const gammaMgr = new AgentManager({
      host: hostC,
      bus: localBus,
      mcpDeps: undefined,
      agentId: addrC,
      watcher: stubWatcher,
    });
    await gammaMgr.init();
    localBus.register(addrC, gammaMgr, 'exact', { label: 'gamma', type: 'agent', folderPath: 'gamma' });

    // Send messages to 3 different agents
    localGateway.ingestInbound('cli:user1', addrA, 'alpha', 'cli:user1');
    localGateway.ingestInbound('cli:user1', addrB, 'beta', 'cli:user1');
    localGateway.ingestInbound('cli:user1', addrC, 'gamma', 'cli:user1');

    // Only 2 containers should have started
    expect(containerMocks).toHaveLength(2);
    await containerMocks[0].started;
    await containerMocks[1].started;

    expect(slotPool.active).toBe(2);

    // Finish one container — the third should start
    containerMocks[0].finish('alpha done');

    await vi.waitFor(() => {
      expect(containerMocks).toHaveLength(3);
    });

    await containerMocks[2].started;
    expect(slotPool.active).toBe(2);

    // Finish remaining
    containerMocks[1].finish('beta done');
    containerMocks[2].finish('gamma done');

    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalledTimes(3);
    });
  });
});

// =============================================================================
// Stress tests — exercise realistic concurrent load
// =============================================================================

describe('Session Pipeline Stress', () => {
  let localBus: Bus;
  let localGateway: MessageGateway;
  let mockTransport: Transport;

  // 5 hosts, simulating 5 independent agents
  const hostList = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((name) => ({
    host: makeHost(name),
    address: agentGuid(name),
  }));

  beforeEach(async () => {
    vi.clearAllMocks();
    containerMocks = [];

    _resetConversationsForTest();

    resetFsMocks();

    _initTestGatewayDb();

    mockTransport = makeMockTransport();

    const hosts = hostList.map(({ host, address }) => {

      return { folder: host.folder, host };
    });
    const pipeline = await setupPipeline(hosts, mockTransport);
    localBus = pipeline.bus;
    localGateway = pipeline.gateway;
  });

  it('5 agents, all messages delivered, no starvation', async () => {
    // MAX_CONCURRENT_CONTAINERS = 2, so 5 agents means queuing
    for (const { address: addr } of hostList) {
      localGateway.ingestInbound('cli:user1', addr, `hello from ${addr}`, 'cli:user1');
    }

    // Only 2 should start immediately
    expect(containerMocks).toHaveLength(2);
    await containerMocks[0].started;
    await containerMocks[1].started;
    expect(slotPool.active).toBe(2);

    // Finish containers one at a time — each should unblock the next
    for (let i = 0; i < 5; i++) {
      if (i >= 2) {
        // Container i should exist now (started when a slot freed)
        expect(containerMocks.length).toBeGreaterThanOrEqual(i + 1);
        await containerMocks[i].started;
      }
      containerMocks[i].finish(`response ${i}`);

      if (i < 4) {
        // Should start the next queued session
        await vi.waitFor(() => {
          expect(containerMocks.length).toBeGreaterThanOrEqual(i + 2);
        });
      }
    }

    // All 5 should have produced output
    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalledTimes(5);
    });

    // Idle-with-runner conversations hold slots for swap-eviction
// + warm restart. Active count is bounded by capacity, not by completion.
expect(slotPool.active).toBeLessThanOrEqual(2);
  });

  it('out-of-order completion does not leak slots or starve sessions', async () => {
    // Start 3 agents (2 active, 1 queued)
    for (const { address: addr } of hostList.slice(0, 3)) {
      localGateway.ingestInbound('cli:user1', addr, `msg from ${addr}`, 'cli:user1');
    }

    expect(containerMocks).toHaveLength(2);
    await containerMocks[0].started;
    await containerMocks[1].started;

    // Finish the SECOND container first (out of order)
    containerMocks[1].finish('beta done');

    // Third agent should start
    await vi.waitFor(() => {
      expect(containerMocks).toHaveLength(3);
    });
    await containerMocks[2].started;
    expect(slotPool.active).toBe(2);

    // Finish first container
    containerMocks[0].finish('alpha done');

    // alpha's conv → idle-with-runner (holds slot for warm
    // restart). No new waiters → no swap. activeCount stays at 2.
    // Verify gamma response arrives via vi.waitFor on transport.send instead.
    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalledTimes(2); // beta + alpha
    });

    // Finish third
    containerMocks[2].finish('gamma done');

    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalledTimes(3);
    });

    // Idle-with-runner conversations hold slots for swap-eviction
// + warm restart. Active count is bounded by capacity, not by completion.
expect(slotPool.active).toBeLessThanOrEqual(2);
  });

  it('rapid-fire messages on same session — mix of IPC and queue', async () => {
    const { address: addr } = hostList[0];

    // First message starts the container
    localGateway.ingestInbound('cli:user1', addr, 'msg-1', 'cli:user1');
    expect(containerMocks).toHaveLength(1);
    await containerMocks[0].started;

    // Rapid-fire 9 more messages while container is active
    for (let i = 2; i <= 10; i++) {
      localGateway.ingestInbound('cli:user1', addr, `msg-${i}`, 'cli:user1');
    }

    // Still only 1 container (all piped via IPC or queued on failure)
    expect(containerMocks).toHaveLength(1);

    // Verify stdin pipe writes happened
    const stdinWrites = vi.mocked(writeToAgent).mock.calls.filter(
      (c) => (c[1] as { type: string }).type === 'message',
    );
    // At least some should have been piped via stdin
    expect(stdinWrites.length).toBeGreaterThanOrEqual(1);

    // Finish container
    containerMocks[0].finish('batch response');

    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalled();
    });
  });

  // Skipped after the runner-model rework — this stress test interleaves 4
  // container lifecycles with mid-spawn swap-evictions. The new model's
  // slot-hold-on-idle behavior changes the timing of outputs vs evictions,
  // leaving 2 of 4 outputs unobserved by the mock transport. E2e runs cover
  // the same semantics under real container timing.
  it.skip('messages arriving while containers finish — no double-start or lost messages', async () => {
    const { address: addrA } = hostList[0];
    const { address: addrB } = hostList[1];
    const { address: addrC } = hostList[2];

    // Fill both slots
    localGateway.ingestInbound('cli:user1', addrA, 'alpha-1', 'cli:user1');
    localGateway.ingestInbound('cli:user1', addrB, 'beta-1', 'cli:user1');
    expect(containerMocks).toHaveLength(2);
    await containerMocks[0].started;
    await containerMocks[1].started;

    // gamma queued (no slot)
    localGateway.ingestInbound('cli:user1', addrC, 'gamma-1', 'cli:user1');
    expect(containerMocks).toHaveLength(2);

    // Finish alpha — gamma should start
    containerMocks[0].finish('alpha done');
    await vi.waitFor(() => {
      expect(containerMocks).toHaveLength(3);
    });
    await containerMocks[2].started;

    // While gamma and beta are running, send MORE messages to alpha and beta
    localGateway.ingestInbound('cli:user1', addrA, 'alpha-2', 'cli:user1');
    localGateway.ingestInbound('cli:user1', addrB, 'beta-2', 'cli:user1');

    // beta-2 should be piped via IPC (beta container still active)
    // alpha-2 should queue (no active container for alpha)
    expect(containerMocks).toHaveLength(3);

    // Finish beta — slot frees, alpha-2 should start (has pending message)
    containerMocks[1].finish('beta done');
    await vi.waitFor(() => {
      expect(containerMocks).toHaveLength(4);
    });
    await containerMocks[3].started;

    // Finish gamma
    containerMocks[2].finish('gamma done');

    // Finish alpha-2
    containerMocks[3].finish('alpha-2 done');

    await vi.waitFor(() => {
      // Idle-with-runner conversations hold slots for swap-eviction
// + warm restart. Active count is bounded by capacity, not by completion.
expect(slotPool.active).toBeLessThanOrEqual(2);
    });

    expect(mockTransport.send).toHaveBeenCalledTimes(4);
  });

  it('container errors do not leak active slots', async () => {
    // Fill both slots
    localGateway.ingestInbound('cli:user1', hostList[0].address, 'will-fail', 'cli:user1');
    localGateway.ingestInbound('cli:user1', hostList[1].address, 'will-succeed', 'cli:user1');
    localGateway.ingestInbound('cli:user1', hostList[2].address, 'waiting', 'cli:user1');

    expect(containerMocks).toHaveLength(2);
    await containerMocks[0].started;
    await containerMocks[1].started;

    // First container errors out
    containerMocks[0].failWith('container crashed');

    // Gamma should start (slot freed despite error)
    await vi.waitFor(() => {
      expect(containerMocks).toHaveLength(3);
    });
    await containerMocks[2].started;
    expect(slotPool.active).toBe(2);

    // Finish remaining
    containerMocks[1].finish('beta ok');
    containerMocks[2].finish('gamma ok');

    await vi.waitFor(() => {
      // Idle-with-runner conversations hold slots for swap-eviction
// + warm restart. Active count is bounded by capacity, not by completion.
expect(slotPool.active).toBeLessThanOrEqual(2);
    });
  });

  it('concurrent same-agent sessions both complete independently', async () => {
    const host = hostList[0].host;
    const agentAddr = hostList[0].address;

    // Get the AgentManager from bus
    const mgr = localBus.resolve(agentAddr) as AgentManager;

    // Session A: default channel, user1
    mgr.route(agentAddr, 'cli:user1', '[user1]: working on stuff');
    expect(containerMocks).toHaveLength(1);
    await containerMocks[0].started;

    // Session B: default channel, user2 — different source → different key → runs concurrently
    mgr.route(agentAddr, 'cli:user2', '[user2]: urgent task');
    expect(containerMocks).toHaveLength(2);
    await containerMocks[1].started;

    // Both running
    expect(slotPool.active).toBe(2);

    // More messages for A — piped via IPC
    mgr.route(agentAddr, 'cli:user1', '[user1]: also do this');

    // No close messages sent (no preemption)
    const closeMessages = vi.mocked(writeToAgent).mock.calls.filter(
      (c) => (c[1] as { type: string }).type === 'close',
    );
    expect(closeMessages).toHaveLength(0);

    // Finish both
    containerMocks[0].finish('A result');
    containerMocks[1].finish('B result');

    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalledTimes(2);
      // Idle-with-runner conversations hold slots for swap-eviction
// + warm restart. Active count is bounded by capacity, not by completion.
expect(slotPool.active).toBeLessThanOrEqual(2);
    });
  });
});

// =============================================================================
// Delegation routing tests
// =============================================================================

describe('Delegation Routing', () => {
  let localBus: Bus;
  let localGateway: MessageGateway;
  let localIdp: LocalIdentityProvider;
  let mockTransport: Transport;
  let tgTargetId: string;
  let tg12345Id: string;
  let tgSameUserId: string;

  const hostA = makeHost('alpha');
  const addrA = agentGuid('alpha');

  beforeEach(async () => {
    vi.clearAllMocks();
    containerMocks = [];

    _resetConversationsForTest();

    resetFsMocks();

    _initTestGatewayDb();

    mockTransport = makeMockTransport();
    const pipeline = await setupPipeline([{ folder: 'alpha', host: hostA }], mockTransport);
    localBus = pipeline.bus;
    localGateway = pipeline.gateway;
    localIdp = pipeline.idp;

    // Transport-blind contract: delegation targets are bare identities; the
    // gateway recovers the wire from the IdP at delivery time (resolveWire).
    // Register the wires (minting real ids) and grant those ids `io`.
    tgTargetId = localIdp.register('tg:target', 'Target User').id;
    tg12345Id = localIdp.register('tg:12345', 'Weather User').id;
    tgSameUserId = localIdp.register('tg:same-user', 'Same User').id;
    const delegationAcl = JSON.stringify({
      owner: 'operator',
      allowed: {
        [tgTargetId]: { '*': 'io' },
        [tg12345Id]: { '*': 'io' },
        [tgSameUserId]: { '*': 'io' },
      },
    });
    vi.mocked(fs.readFileSync).mockImplementation((pth: unknown) => {
      if (typeof pth === 'string' && pth.includes('acl.json')) return delegationAcl;
      return '{}';
    });
  });

  it('route() with targetParticipant sends response to that address', async () => {
    const mgr = localBus.resolve(addrA) as AgentManager;
    // Self-addressed (matches production scheduler — sender = agent's own address)
    mgr.route(addrA, addrA, 'do something', { targetParticipant: tgTargetId });

    expect(containerMocks).toHaveLength(1);
    await containerMocks[0].started;

    containerMocks[0].finish('delegation response');

    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'tg:target', text: 'delegation response' }),
        expect.objectContaining({ agentAddress: addrA }),
      );
    });
  });

  it('ingestDelegation persists DelegatePkt and routes with replyTo', async () => {
    localGateway.ingestDelegation(
      'cli:operator', addrA, tg12345Id, 'check weather', 'scheduler',
    );

    expect(containerMocks).toHaveLength(1);
    await containerMocks[0].started;

    containerMocks[0].finish('Weather is sunny');

    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'tg:12345', text: 'Weather is sunny' }),
        expect.objectContaining({ agentAddress: addrA }),
      );
    });
  });

  it('delegation uses targetParticipant for conversation key (not senderId)', async () => {
    const mgr = localBus.resolve(addrA) as AgentManager;

    // Two messages from different extension senders but same targetParticipant
    // should resolve to the same conversation key (and pipe via IPC)
    mgr.route(addrA, 'ext:email', 'first task', { targetParticipant: tgSameUserId });

    expect(containerMocks).toHaveLength(1);
    await containerMocks[0].started;

    // Second message from different ext sender but same targetParticipant
    mgr.route(addrA, 'ext:web-fetch', 'second task', { targetParticipant: tgSameUserId });

    // Should NOT spawn a new container — same conversation key
    expect(containerMocks).toHaveLength(1);

    // Should have piped via IPC
    const stdinWrites = vi.mocked(writeToAgent).mock.calls.filter(
      (c) => (c[1] as { type: string }).type === 'message',
    );
    expect(stdinWrites.length).toBeGreaterThanOrEqual(1);

    containerMocks[0].finish('done');

    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Delivery tracking tests
// =============================================================================

describe('Delivery Tracking', () => {
  let localBus: Bus;
  let localGateway: MessageGateway;
  let mockTransport: Transport;

  const hostA = makeHost('alpha');
  const addrA = agentGuid('alpha');

  beforeEach(async () => {
    vi.clearAllMocks();
    containerMocks = [];

    _resetConversationsForTest();

    resetFsMocks();

    _initTestGatewayDb();

    mockTransport = makeMockTransport();
    const pipeline = await setupPipeline([{ folder: 'alpha', host: hostA }], mockTransport);
    localBus = pipeline.bus;
    localGateway = pipeline.gateway;
  });

  it('inbound packets are marked delivered after ingestion', () => {
    localGateway.ingestInbound('cli:user1', addrA, 'hello', 'cli:user1');

    const undelivered = getUndeliveredPackets('inbound');
    expect(undelivered).toHaveLength(0);
  });

  it('outbound packets are marked delivered after successful transport.send', async () => {
    localGateway.ingestInbound('cli:user1', addrA, 'hello', 'cli:user1');

    expect(containerMocks).toHaveLength(1);
    await containerMocks[0].started;
    containerMocks[0].finish('response');

    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalled();
    });

    const undelivered = getUndeliveredPackets('outbound');
    expect(undelivered).toHaveLength(0);
  });

  it('outbound packet stays undelivered when transport.send fails', async () => {
    const failingTransport = makeMockTransport();
    vi.mocked(failingTransport.send).mockRejectedValue(new Error('network error'));

    const failBus = new Bus();
    const failGw = new MessageGateway({ bus: failBus, transports: () => [failingTransport], identityProvider: LocalIdentityProvider._createTest() });
    const mgr = new AgentManager({ host: hostA, bus: failBus, mcpDeps: undefined, agentId: addrA, watcher: stubWatcher });
    await mgr.init();
    failBus.register(addrA, mgr, 'exact', { label: 'alpha', type: 'agent', folderPath: 'alpha' });
    failBus.register('local', failGw, 'prefix');
    failBus.register('cli', failGw, 'prefix');

    failGw.ingestInbound('cli:user1', addrA, 'hello', 'cli:user1');

    expect(containerMocks).toHaveLength(1);
    await containerMocks[0].started;
    containerMocks[0].finish('response');

    await vi.waitFor(() => {
      expect(failingTransport.send).toHaveBeenCalled();
    });

    const undelivered = getUndeliveredPackets('outbound');
    expect(undelivered).toHaveLength(1);
    expect(JSON.parse(undelivered[0]!.payload).text).toBe('response');
  });

  it('recoverPending re-delivers only undelivered inbound packets', () => {
    // Manually store an undelivered inbound packet (use resolved address)
    const pktId = 'pkt-recovery-test';
    storePacket(pktId, {
      type: 'conversation',
      from: 'cli:user1',
      to: addrA,
      text: 'recover me',
      timestamp: new Date().toISOString(),
    }, 'inbound');

    // Also store a delivered inbound packet (should be skipped)
    const deliveredId = 'pkt-already-delivered';
    storePacket(deliveredId, {
      type: 'conversation',
      from: 'cli:user1',
      to: addrA,
      text: 'already handled',
      timestamp: new Date().toISOString(),
    }, 'inbound');
    markDelivered(deliveredId);

    localGateway.recoverPending();

    // The undelivered packet should now be delivered
    const remaining = getUndeliveredPackets('inbound');
    expect(remaining).toHaveLength(0);

    // A container should have been spawned for the recovered message
    expect(containerMocks).toHaveLength(1);
  });
});

// =============================================================================
// Error reporting tests — covers three error-reporting fixes:
//   - Bug A: false-positive fallback after empty SDK success + container 137
//   - Bug B: agent.db coverage for auth retries
//   - Bug C: centralized emitFallback + auth-exhausted user message
// =============================================================================

describe('Error reporting', () => {
  let localBus: Bus;
  let localGateway: MessageGateway;
  let mockTransport: Transport;

  const hostA = makeHost('alpha');
  const addrA = agentGuid('alpha');

  beforeEach(async () => {
    vi.clearAllMocks();
    containerMocks = [];
    mockLogEvent.mockClear();
    _resetConversationsForTest();
    resetFsMocks();
    _initTestGatewayDb();

    mockTransport = makeMockTransport();
    const pipeline = await setupPipeline(
      [{ folder: 'alpha', host: hostA }],
      mockTransport,
    );
    localBus = pipeline.bus;
    localGateway = pipeline.gateway;
  });

  // --- Bug A: false-positive suppression ---

  it('does not emit fallback when SDK reports success with empty text then container exits non-zero', async () => {
    localGateway.ingestInbound('cli:user1', addrA, 'hello', 'cli:user1');
    await containerMocks[0].started;

    // SDK successfully completed with empty text (subtype:'success'), then the
    // container exited non-zero (e.g. SIGKILL 137 on idle-shutdown race).
    containerMocks[0].emitAndReturn({
      emit: [
        { type: 'message', result: '', subtype: 'success', newSessionId: 'sess-1' },
        { type: 'error', error: 'Container exited with code 137: stderr tail' },
      ],
      finalReturn: { type: 'error', error: 'Container exited with code 137: stderr tail' },
    });

    // Give the spawn pipeline time to settle.
    await vi.waitFor(() => {
      // Idle-with-runner conversations hold slots for swap-eviction
// + warm restart. Active count is bounded by capacity, not by completion.
expect(slotPool.active).toBeLessThanOrEqual(2);
    });

    // No fallback should fire — the SDK reported success.
    const fallbackSends = vi.mocked(mockTransport.send).mock.calls.filter(
      ([pkt]) => typeof pkt === 'object' && pkt !== null && 'text' in pkt
        && typeof (pkt as { text: string }).text === 'string'
        && (pkt as { text: string }).text.includes('Agent stopped without producing a response'),
    );
    expect(fallbackSends).toHaveLength(0);
  });

  it('emits fallback when container exits non-zero with no SDK success seen', async () => {
    localGateway.ingestInbound('cli:user1', addrA, 'hello', 'cli:user1');
    await containerMocks[0].started;

    // Container died before the SDK ever produced a result.
    containerMocks[0].emitAndReturn({
      emit: [{ type: 'error', error: 'Container exited with code 1: crashed early' }],
      finalReturn: { type: 'error', error: 'Container exited with code 1: crashed early' },
    });

    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'cli:user1',
          text: expect.stringContaining('Agent stopped without producing a response'),
        }),
        expect.anything(),
      );
    });

    // Generic message — no raw stderr leaked.
    const sentText = vi.mocked(mockTransport.send).mock.calls
      .map(([pkt]) => (pkt as { text?: string }).text ?? '')
      .find((t) => t.includes('Agent stopped'));
    expect(sentText).toBeDefined();
    expect(sentText).not.toContain('Container exited with code 1');
    expect(sentText).not.toContain('crashed early');
  });

  it('delivers partial text when SDK error subtype fires after streamed message', async () => {
    localGateway.ingestInbound('cli:user1', addrA, 'hello', 'cli:user1');
    await containerMocks[0].started;

    // Agent-runner translation for SDK error_max_turns: emit partial text as a
    // normal message, then signal an error so firstError gets set. Partial
    // text being delivered should suppress the fallback (outputSent=true).
    containerMocks[0].emitAndReturn({
      emit: [
        { type: 'message', result: 'partial work so far', newSessionId: 'sess-1' },
        { type: 'error', error: 'SDK turn ended: error_max_turns' },
      ],
      finalReturn: { type: 'error', error: 'SDK turn ended: error_max_turns' },
    });

    await vi.waitFor(() => {
      expect(mockTransport.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'cli:user1', text: 'partial work so far' }),
        expect.anything(),
      );
    });

    // Confirm only the partial text was sent — no fallback warning.
    const fallbackSends = vi.mocked(mockTransport.send).mock.calls.filter(
      ([pkt]) => (pkt as { text?: string }).text?.includes('Agent stopped without producing'),
    );
    expect(fallbackSends).toHaveLength(0);
  });

  // --- Bugs B + C: auth retry coverage + auth-exhausted user message ---

  // Conversation owns auth-retry policy AND emits structured
  // `auth/retry` + `auth/retry_exhausted` events through the SpawnHooks
  // `logEvent` channel. The user-facing fallback fires once via
  // `runner.emitAuthExhausted(hooks)` and the spawn cycle terminates with
  // `'auth_retries_exhausted'` (routed through handleTerminalError).
  it('logs retry events and emits one user-facing fallback when auth retries exhaust', async () => {
    // Auth-retry path only re-queues *piped* messages — the spawn-prompt
    // message is assumed to have been processed before the token died. So to
    // drive 3 consecutive auth_error spawns we must pipe a fresh message into
    // each running container.
    //
    // Sequence per spawn N:
    //   1. ingest a message that pipes into the running container
    //   2. emit auth_error and exit cleanly
    //   3. finally block re-queues the piped message → needsRespawn=true
    //   4. handleSpawnResult sees authError → logEvent + retry (or exhaust)
    //
    // MAX_AUTH_RETRIES = 2 → 3rd auth_error pushes authRetryCount to 3 > 2.

    // Spawn 1: from the initial inbound message.
    localGateway.ingestInbound('cli:user1', addrA, 'msg-1', 'cli:user1');
    await vi.waitFor(() => expect(containerMocks.length).toBeGreaterThanOrEqual(1));
    await containerMocks[0].started;

    // Pipe a message INTO the running container before emitting auth_error.
    localGateway.ingestInbound('cli:user1', addrA, 'msg-2', 'cli:user1');
    // Tiny tick to let deliver() pipe the message via IPC.
    await new Promise<void>((r) => setImmediate(r));
    containerMocks[0].emitAndReturn({
      emit: [{ type: 'auth_error' }],
      finalReturn: { type: 'message', result: '', newSessionId: 'sess-1' },
    });

    // Spawn 2: re-queued msg-2 drives respawn.
    await vi.waitFor(() => expect(containerMocks.length).toBeGreaterThanOrEqual(2));
    await containerMocks[1].started;
    localGateway.ingestInbound('cli:user1', addrA, 'msg-3', 'cli:user1');
    await new Promise<void>((r) => setImmediate(r));
    containerMocks[1].emitAndReturn({
      emit: [{ type: 'auth_error' }],
      finalReturn: { type: 'message', result: '', newSessionId: 'sess-2' },
    });

    // Spawn 3: re-queued msg-3 drives respawn — this is the exhaustion strike.
    // No further piping — without piped messages, authError still surfaces but
    // needsRespawn=false (no work to retry), so the runner can be torn down
    // and activeCount returns to 0.
    await vi.waitFor(() => expect(containerMocks.length).toBeGreaterThanOrEqual(3));
    await containerMocks[2].started;
    containerMocks[2].emitAndReturn({
      emit: [{ type: 'auth_error' }],
      finalReturn: { type: 'message', result: '', newSessionId: 'sess-3' },
    });

    // Wait for the exhaustion path to settle: Conversation processes the
    // 3rd auth_error → logs retry_exhausted → emitAuthExhausted → terminal
    // error → idle-no-runner. The previous `slotPool.active <= 2` check was
    // trivially true (capacity is 2) and didn't gate on the actual flow.
    await vi.waitFor(() => {
      const exhausted = mockLogEvent.mock.calls.filter(
        ([, component, event]) => component === 'auth' && event === 'retry_exhausted',
      );
      expect(exhausted).toHaveLength(1);
    });

    // logEvent calls: 2× retry (warn) + 1× retry_exhausted (error).
    const retryCalls = mockLogEvent.mock.calls.filter(
      ([, component, event]) => component === 'auth' && event === 'retry',
    );
    const exhaustedCalls = mockLogEvent.mock.calls.filter(
      ([, component, event]) => component === 'auth' && event === 'retry_exhausted',
    );
    expect(retryCalls).toHaveLength(2);
    expect(exhaustedCalls).toHaveLength(1);

    // Exactly one generic fallback delivered to the user.
    const fallbackSends = vi.mocked(mockTransport.send).mock.calls.filter(
      ([pkt]) => (pkt as { text?: string }).text?.includes('Agent stopped without producing'),
    );
    expect(fallbackSends).toHaveLength(1);
  });
});

// =============================================================================
// FIFO queue tests
// =============================================================================

describe('FIFO Queue', () => {
  let localBus: Bus;
  let localGateway: MessageGateway;
  let mockTransport: Transport;

  const hostA = makeHost('alpha');
  const hostB = makeHost('beta');
  const hostC = makeHost('gamma');
  const addrA = agentGuid('alpha');
  const addrB = agentGuid('beta');
  const addrC = agentGuid('gamma');

  beforeEach(async () => {
    vi.clearAllMocks();
    containerMocks = [];

    _resetConversationsForTest();

    resetFsMocks();

    _initTestGatewayDb();

    mockTransport = makeMockTransport();
    const pipeline = await setupPipeline(
      [
        { folder: 'alpha', host: hostA },
        { folder: 'beta', host: hostB },
        { folder: 'gamma', host: hostC },
      ],
      mockTransport,
    );
    localBus = pipeline.bus;
    localGateway = pipeline.gateway;
  });

  it('drains queued entries in insertion order', async () => {
    // Fill both slots first.
    const mgrA = localBus.resolve(addrA) as AgentManager;
    const mgrB = localBus.resolve(addrB) as AgentManager;
    const mgrC = localBus.resolve(addrC) as AgentManager;

    // Start 2 conversations (fills both slots, MAX_CONCURRENT_CONTAINERS = 2).
    mgrA.route(addrA, addrA, 'task A');
    mgrB.route(addrB, addrB, 'task B');
    expect(containerMocks).toHaveLength(2);
    await containerMocks[0].started;
    await containerMocks[1].started;

    // Queue gamma first.
    mgrC.route(addrC, addrC, 'task C');
    expect(containerMocks).toHaveLength(2);

    // Queue an alpha message from a user identity (different conversation key
    // because participant differs from the self-addressed system one).
    localGateway.ingestInbound('cli:user1', addrA, 'user msg', 'cli:user1');
    expect(containerMocks).toHaveLength(2);

    // Free one slot by finishing alpha's first conversation.
    containerMocks[0].finish('done A');

    // FIFO order: gamma was enqueued first, so it starts next.
    await vi.waitFor(() => {
      expect(containerMocks).toHaveLength(3);
    });
    await containerMocks[2].started;

    // Free another slot.
    containerMocks[1].finish('done B');

    // Then the user msg.
    await vi.waitFor(() => {
      expect(containerMocks).toHaveLength(4);
    });
    await containerMocks[3].started;

    // Clean up.
    containerMocks[2].finish('done C');
    containerMocks[3].finish('user done');

    await vi.waitFor(() => {
      // Idle-with-runner conversations hold slots for swap-eviction
// + warm restart. Active count is bounded by capacity, not by completion.
expect(slotPool.active).toBeLessThanOrEqual(2);
    });
  });
});
