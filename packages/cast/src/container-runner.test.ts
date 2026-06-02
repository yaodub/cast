import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---CAST_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CAST_OUTPUT_END---';

// Mock config. This is a WHOLE-MODULE replacement, not importActual+spread:
// importing the real config.ts at load runs env.ts's Zod parse and probes the
// host for a container binary, both of which fail in a bare test env. The cost is
// that this literal must track every config export container-runner.ts consumes —
// a missing one reads as `undefined` at the call site (e.g. RUNTIME_BINARY).
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'cast-agent:latest',
  CONTAINER_NAME_PREFIX: 'cast-test-',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CONTAINER_RUNTIME: 'apple-container',
  RUNTIME_BINARY: 'container',
  RUNTIME_SUPPORTS_CAP_ADD: true,
  RUNTIME_VERSION: '0.12.3',
  AGENTS_DIR: '/tmp/cast-test-agents',
  IDLE_TIMEOUT: 1800000, // 30min
  agentPath: (folder: string, ...segments: string[]) =>
    ['/tmp/cast-test-agents', folder, ...segments].join('/'),
  sessionClaudePath: (folder: string, convKey: string) =>
    `/tmp/cast-test-agents/${folder}/sessions/${convKey}/.claude`,
  mcpDir: (folder: string) =>
    `/tmp/cast-test-agents/${folder}/mcp`,
  castSocketPath: (folder: string) =>
    `/tmp/cast-test-agents/${folder}/mcp/cast.sock`,
  resolveCapabilities: () => ({
    disabledTools: [],
    resources: {},
  }),
}));

// Mock auth
vi.mock('./auth/auth.js', () => ({
  refreshSecrets: vi.fn(async () => ({ ANTHROPIC_API_KEY: 'test-key' })),
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs. existsSync defaults to true so the spawn-time existence check on
// `<agentDir>/manifest.json` (Phase 1A) passes — individual tests can override
// to false to exercise the refusal branch.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return new EventEmitter();
    }),
  };
});

import { runContainerAgent, setAuth } from './container/container-runner.js';
import type { ContainerOutput } from './container/container-runner.js';
import type { AuthResolution } from './auth/auth.js';
import type { Host } from './types.js';
import { _setMockWatcher } from './lib/config-reader.js';
import { logger } from './logger.js';
import fs from 'fs';

// Initialize mock watcher (delegates to the fs mock) and auth
_setMockWatcher({
  get: (p) => { try { return vi.mocked(fs.readFileSync)(p, 'utf-8') as string; } catch { return null; } },
});

// Initialize auth so runContainerAgent doesn't throw
const testAuth: AuthResolution = {
  mode: 'api-key',
  secrets: { ANTHROPIC_API_KEY: 'test-key' },
  meta: { source: '.env' },
};
setAuth(testAuth);

const testAgent: Host = {
  name: 'Test Agent',
  folder: 'test-agent',
};

const testInput = {
  prompt: 'Hello',
  agentFolder: 'test-agent',
  address: 'test@g.us',
};

function emitOutputMarker(proc: ReturnType<typeof createFakeProcess>, output: ContainerOutput) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testAgent,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      type: 'message',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.type).toBe('message');
    expect(result.type === 'message' && result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testAgent,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.type).toBe('error');
    expect(result.type === 'error' && result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testAgent,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      type: 'message',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.type).toBe('message');
    expect(result.type === 'message' && result.newSessionId).toBe('session-456');
  });
});

/**
 * container-runner refuses to spawn when the agent folder is gone.
 * Fails closed rather than recreating the folder, so a deleted agent
 * cannot be silently resurrected by a subsequent inbound message.
 */
describe('container-runner agent-folder existence guard', () => {
  beforeEach(() => {
    vi.useRealTimers();
    fakeProc = createFakeProcess();
    // Default existsSync to true so other tests stay green; per-test overrides below.
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  it('throws when the agent folder is missing (yanked)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await expect(
      runContainerAgent(testAgent, testInput, () => {}),
    ).rejects.toThrow(/Agent folder "test-agent" no longer exists; refusing to spawn/);

    // Critical assertion: must NOT have called mkdirSync on the agent dir.
    // Pre-Phase-1A, the runner unconditionally `mkdirSync(agentDir, recursive: true)`,
    // which would resurrect a deleted folder.
    const mkdirCalls = vi.mocked(fs.mkdirSync).mock.calls;
    const resurrectionCall = mkdirCalls.find(([p]) =>
      typeof p === 'string' && p.endsWith('/test-agent'),
    );
    expect(resurrectionCall).toBeUndefined();
  });

  it('checks folder existence (not manifest.json) — console manager folders have no manifest', async () => {
    let checked: string | null = null;
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      checked = String(p);
      return false;
    });

    await expect(
      runContainerAgent(testAgent, testInput, () => {}),
    ).rejects.toThrow();

    // The first existsSync call should be against the agent folder, not against
    // a manifest.json path inside it. This protects console-manager scratch
    // folders (`.config-manager`, `.design-manager`, `.security-manager`),
    // which legitimately have no manifest but are real spawn targets.
    expect(checked).toMatch(/test-agent$/);
    expect(checked).not.toMatch(/manifest\.json/);
  });
});

/**
 * Phase 1B: writeContainerLog tolerates write failures.
 * If the agent folder is yanked between spawn and exit, writing the run log
 * would throw ENOENT — pre-Phase-1B that crashed the host node process.
 */
describe('writeContainerLog ENOENT tolerance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not throw when writeFileSync fails (e.g. parent dir gone mid-conversation)', async () => {
    // Make every writeFileSync throw, simulating folder deletion.
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });

    const resultPromise = runContainerAgent(
      testAgent,
      testInput,
      () => {},
      vi.fn(async () => {}),
    );

    // Drive the run to completion via a normal close — exit handler will call
    // writeContainerLog, which would throw without the try/catch.
    emitOutputMarker(fakeProc, { type: 'message', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    // Should resolve cleanly — no uncaught throw from the log write.
    const result = await resultPromise;
    expect(result.type).toBe('message');
  });

  // ENOENT is the *expected* failure during a hot agent unload (folder yanked
  // mid-conversation). Logging it at WARN clutters steady-state logs once the
  // bug it diagnoses (Phase 1B) is trusted. Downgrade ENOENT specifically to
  // debug; keep WARN for unexpected failure modes (perms, disk full, etc.).
  it('logs ENOENT at debug level (expected during hot unload)', async () => {
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.warn).mockClear();

    const resultPromise = runContainerAgent(
      testAgent, testInput, () => {}, vi.fn(async () => {}),
    );
    emitOutputMarker(fakeProc, { type: 'message', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const debugCalls = vi.mocked(logger.debug).mock.calls;
    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const debugLogFailure = debugCalls.find(
      ([, msg]) => msg === 'Container log write failed',
    );
    const warnLogFailure = warnCalls.find(
      ([, msg]) => msg === 'Container log write failed',
    );
    expect(debugLogFailure).toBeDefined();
    expect(warnLogFailure).toBeUndefined();
  });

  it('logs non-ENOENT failures at warn level (unexpected modes)', async () => {
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.warn).mockClear();

    const resultPromise = runContainerAgent(
      testAgent, testInput, () => {}, vi.fn(async () => {}),
    );
    emitOutputMarker(fakeProc, { type: 'message', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const warnLogFailure = vi.mocked(logger.warn).mock.calls.find(
      ([, msg]) => msg === 'Container log write failed',
    );
    expect(warnLogFailure).toBeDefined();
  });
});

/**
 * modelOverrides — verifies that the host-side resolver picks the right model
 * given a channel/phase context, that the resolved value lands in the stdin
 * init message, and that host-only fields (`channelName`, `phase`) never leak
 * to the runner via stdin.
 */
describe('container-runner modelOverrides', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Capture the first stdin write (init message) as a parsed JSON object. */
  async function captureInit(
    input: Parameters<typeof runContainerAgent>[1],
    agentConfig: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Wire the agent.json content via the existing fs.readFileSync mock.
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith('/config/agent.json')) return JSON.stringify(agentConfig);
      return '';
    });

    let initLine: string | null = null;
    const origWrite = fakeProc.stdin.write.bind(fakeProc.stdin);
    fakeProc.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (initLine === null && typeof chunk === 'string') {
        initLine = chunk;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return origWrite(chunk as any, ...(rest as [any, any]));
    }) as typeof fakeProc.stdin.write;

    const resultPromise = runContainerAgent(testAgent, input, () => {}, vi.fn(async () => {}));
    emitOutputMarker(fakeProc, { type: 'message', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    if (!initLine) throw new Error('no init message captured');
    return JSON.parse((initLine as string).trim());
  }

  it('resolves channel override into init message `model`', async () => {
    const init = await captureInit(
      { ...testInput, channelName: 'email' } as Parameters<typeof runContainerAgent>[1],
      {
        model: 'claude-sonnet-4-6',
        modelOverrides: [{ channel: 'email', model: 'claude-haiku-4-5' }],
      },
    );
    expect(init.model).toBe('claude-haiku-4-5');
  });

  it('falls back to top-level model when channel does not match', async () => {
    const init = await captureInit(
      { ...testInput, channelName: 'default' } as Parameters<typeof runContainerAgent>[1],
      {
        model: 'claude-sonnet-4-6',
        modelOverrides: [{ channel: 'email', model: 'claude-haiku-4-5' }],
      },
    );
    expect(init.model).toBe('claude-sonnet-4-6');
  });

  it('resolves a cleanup-phase override when phase=cleanup is set', async () => {
    const init = await captureInit(
      {
        ...testInput,
        channelName: 'default',
        phase: 'cleanup',
      } as Parameters<typeof runContainerAgent>[1],
      {
        model: 'claude-sonnet-4-6',
        modelOverrides: [
          { channel: 'default', phase: 'cleanup', model: 'claude-haiku-4-5' },
        ],
      },
    );
    expect(init.model).toBe('claude-haiku-4-5');
  });

  it('emits `bootstrapModel` when bootstrap is present and a phase override matches', async () => {
    const init = await captureInit(
      {
        ...testInput,
        bootstrap: 'gather context here',
        channelName: 'default',
      } as Parameters<typeof runContainerAgent>[1],
      {
        model: 'claude-sonnet-4-6',
        modelOverrides: [
          { channel: 'default', phase: 'bootstrap', model: 'claude-haiku-4-5' },
        ],
      },
    );
    expect(init.bootstrapModel).toBe('claude-haiku-4-5');
    // Main model unaffected since the override is phase-specific.
    expect(init.model).toBe('claude-sonnet-4-6');
  });

  it('omits `bootstrapModel` when bootstrap is absent', async () => {
    const init = await captureInit(
      { ...testInput, channelName: 'default' } as Parameters<typeof runContainerAgent>[1],
      { model: 'claude-sonnet-4-6' },
    );
    expect(init.bootstrapModel).toBeUndefined();
  });

  it('does not leak host-only fields (channelName, phase) into the init message', async () => {
    const init = await captureInit(
      {
        ...testInput,
        channelName: 'email',
        phase: 'cleanup',
      } as Parameters<typeof runContainerAgent>[1],
      { model: 'claude-sonnet-4-6' },
    );
    expect(init.channelName).toBeUndefined();
    expect(init.phase).toBeUndefined();
  });

  it('sets isCleanup=true on the init message for a cold-path cleanup spawn', async () => {
    const init = await captureInit(
      { ...testInput, channelName: 'default', phase: 'cleanup' } as Parameters<typeof runContainerAgent>[1],
      { model: 'claude-sonnet-4-6' },
    );
    // Wire-visible derivative of the host-only `phase` — lets the runner tag
    // the init turn's usage as the `cleanup` phase. `phase` itself stays stripped.
    expect(init.isCleanup).toBe(true);
    expect(init.phase).toBeUndefined();
  });

  it('omits isCleanup for a normal spawn', async () => {
    const init = await captureInit(
      { ...testInput, channelName: 'default' } as Parameters<typeof runContainerAgent>[1],
      { model: 'claude-sonnet-4-6' },
    );
    expect(init.isCleanup).toBeUndefined();
  });
});
