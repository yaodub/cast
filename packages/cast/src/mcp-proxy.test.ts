/**
 * Unit tests for McpProxyManager.applyDelta.
 *
 * Covers the diff/start/stop/restart logic and the single-slot rerun queue.
 * The real `McpProxy` is replaced via the constructor's `proxyFactory` hook,
 * so its `start`/`stop` are deterministic. Host-proxy ↔ container-socket
 * integration is out of scope (deferred follow-up).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./config.js', () => ({
  agentPath: (folder: string, ...segments: string[]) =>
    ['/tmp/test-agents', folder, ...segments].join('/'),
  mcpDir: (folder: string) => `/tmp/test-agents/${folder}/mcp`,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readdirSync: vi.fn(() => []),
      unlinkSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
  };
});

import {
  McpProxyManager,
  hashServer,
  type ProxyFactory,
  type ProxyHandle,
} from './agent/mcp-proxy.js';
import type { ResolvedMcpServer } from './config.js';

function server(name: string, env: Record<string, string> = {}): ResolvedMcpServer {
  return { name, transport: 'stdio', command: '/usr/bin/echo', args: [name], env };
}

interface FakeHandle extends ProxyHandle {
  startCalls: number;
  stopCalls: number;
  startMode: 'resolve' | 'reject' | 'manual';
  resolveStart: () => void;
  rejectStart: (err: unknown) => void;
}

interface Recorder {
  proxies: FakeHandle[];
  events: string[];
  factory: ProxyFactory;
  setNextStartMode: (mode: 'resolve' | 'reject' | 'manual') => void;
}

function makeRecorder(): Recorder {
  const rec: Recorder = {
    proxies: [],
    events: [],
    factory: () => { throw new Error('uninitialized'); },
    setNextStartMode: () => {},
  };
  let nextMode: 'resolve' | 'reject' | 'manual' = 'resolve';
  rec.setNextStartMode = (mode) => { nextMode = mode; };
  rec.factory = (config) => {
    let resolveStart = () => {};
    let rejectStart: (err: unknown) => void = () => {};
    const handle: FakeHandle = {
      name: config.name,
      port: undefined,
      startCalls: 0,
      stopCalls: 0,
      startMode: nextMode,
      resolveStart: () => resolveStart(),
      rejectStart: (err) => rejectStart(err),
      async start() {
        this.startCalls++;
        rec.events.push(`start:${this.name}`);
        if (this.startMode === 'reject') {
          throw new Error(`start failed for ${this.name}`);
        }
        if (this.startMode === 'manual') {
          await new Promise<void>((res, rej) => {
            resolveStart = res;
            rejectStart = rej;
          });
        }
      },
      async stop() {
        this.stopCalls++;
        rec.events.push(`stop:${this.name}`);
      },
    };
    rec.proxies.push(handle);
    nextMode = 'resolve'; // reset to default for the next proxy
    return handle;
  };
  return rec;
}

let recorder: Recorder;

beforeEach(() => {
  recorder = makeRecorder();
});

describe('hashServer', () => {
  it('returns the same hash for two configs with identical fields', () => {
    expect(hashServer(server('a'))).toBe(hashServer(server('a')));
  });

  it('returns different hashes when env values differ', () => {
    expect(hashServer(server('a', { K: '1' }))).not.toBe(hashServer(server('a', { K: '2' })));
  });

  it('is stable across env key insertion order', () => {
    const a = hashServer(server('a', { Z: '1', A: '2' }));
    const b = hashServer(server('a', { A: '2', Z: '1' }));
    expect(a).toBe(b);
  });

  it('returns different hashes for different transports', () => {
    const stdio = hashServer({ name: 'a', transport: 'stdio', command: '/x', args: [], env: {} });
    const sse = hashServer({ name: 'a', transport: 'sse', url: 'http://x', env: {} });
    expect(stdio).not.toBe(sse);
  });
});

describe('McpProxyManager.applyDelta', () => {
  it('returns noop when applying empty to empty', async () => {
    const m = new McpProxyManager('alpha', recorder.factory);
    const result = await m.applyDelta([]);
    expect(result.type).toBe('noop');
  });

  it('returns added on empty → [A]', async () => {
    const m = new McpProxyManager('alpha', recorder.factory);
    const result = await m.applyDelta([server('A')]);
    expect(result.type).toBe('changed');
    if (result.type === 'changed') {
      expect(result.summary.added).toEqual(['A']);
      expect(result.summary.removed).toEqual([]);
      expect(result.summary.changed).toEqual([]);
    }
    expect(recorder.proxies).toHaveLength(1);
    expect(recorder.proxies[0].startCalls).toBe(1);
  });

  it('returns removed on [A] → empty', async () => {
    const m = new McpProxyManager('alpha', recorder.factory);
    await m.applyDelta([server('A')]);
    const result = await m.applyDelta([]);
    expect(result.type).toBe('changed');
    if (result.type === 'changed') {
      expect(result.summary.removed).toEqual(['A']);
    }
    expect(recorder.proxies[0].stopCalls).toBe(1);
  });

  it("returns changed on [A] → [A'] (hash differs)", async () => {
    const m = new McpProxyManager('alpha', recorder.factory);
    await m.applyDelta([server('A', { K: '1' })]);
    const result = await m.applyDelta([server('A', { K: '2' })]);
    expect(result.type).toBe('changed');
    if (result.type === 'changed') {
      expect(result.summary.changed).toEqual(['A']);
      expect(result.summary.added).toEqual([]);
      expect(result.summary.removed).toEqual([]);
    }
    // Two proxies created (initial + restart); first stopped before second start
    expect(recorder.proxies).toHaveLength(2);
    expect(recorder.proxies[0].stopCalls).toBe(1);
    expect(recorder.proxies[1].startCalls).toBe(1);
  });

  it('returns noop on [A] → [A] when configs are identical (hash equal)', async () => {
    const m = new McpProxyManager('alpha', recorder.factory);
    await m.applyDelta([server('A', { K: '1' })]);
    const result = await m.applyDelta([server('A', { K: '1' })]);
    expect(result.type).toBe('noop');
    expect(recorder.proxies).toHaveLength(1);
    expect(recorder.proxies[0].startCalls).toBe(1);
    expect(recorder.proxies[0].stopCalls).toBe(0);
  });

  // Both-branches discipline: a same-name change MUST restart, an identical
  // config MUST NOT — the hash gate decides.
  it('hash gate: same name + identical env → noop; different env → restart', async () => {
    const m = new McpProxyManager('alpha', recorder.factory);
    await m.applyDelta([server('A', { K: '1' })]);
    expect((await m.applyDelta([server('A', { K: '1' })])).type).toBe('noop');
    expect((await m.applyDelta([server('A', { K: '2' })])).type).toBe('changed');
  });
});

describe('McpProxyManager.applyDelta — concurrency', () => {
  it('serializes two concurrent calls — second waits for first', async () => {
    const m = new McpProxyManager('alpha', recorder.factory);

    recorder.setNextStartMode('manual');
    const p1 = m.applyDelta([server('A')]);
    // Yield the event loop so runDelta reaches the await on proxy.start().
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder.events).toContain('start:A');

    // Second call queues — its proxy must NOT start yet.
    const p2 = m.applyDelta([server('A'), server('B')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder.events).not.toContain('start:B');

    // Resolve A → first applyDelta finishes → second begins.
    recorder.proxies[0].resolveStart();
    await p1;

    // Allow second run to start B.
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder.events).toContain('start:B');

    const r2 = await p2;
    expect(r2.type).toBe('changed');
    if (r2.type === 'changed') {
      expect(r2.summary.added).toEqual(['B']);
    }
  });

  it('three concurrent calls collapse to two runs (current + final)', async () => {
    const m = new McpProxyManager('alpha', recorder.factory);

    recorder.setNextStartMode('manual');
    const p1 = m.applyDelta([server('A')]);
    await Promise.resolve();
    await Promise.resolve();

    // While [A] is in flight, queue [B] then [C]. The trailing slot stores
    // [C], collapsing [B] away. All three callers' promises resolve, but
    // only TWO runs execute — the in-flight [A] and the trailing [C].
    const p2 = m.applyDelta([server('B')]);
    const p3 = m.applyDelta([server('C')]);

    // Drain p1.
    recorder.proxies[0].resolveStart();
    await p1;

    // Allow trailing run to stop A and start C.
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder.events).toContain('stop:A');
    expect(recorder.events).toContain('start:C');
    // [B] was collapsed — no proxy was created for it.
    expect(recorder.events).not.toContain('start:B');

    const r2 = await p2;
    const r3 = await p3;
    expect(r2).toBe(r3); // Same coalesced promise.
    expect(r3.type).toBe('changed');
    if (r3.type === 'changed') {
      expect(r3.summary.added).toEqual(['C']);
      expect(r3.summary.removed).toEqual(['A']);
    }
  });
});

describe('McpProxyManager.applyDelta — partial failure', () => {
  it("a proxy whose start() throws is not added; subsequent applyDelta retries", async () => {
    const m = new McpProxyManager('alpha', recorder.factory);

    recorder.setNextStartMode('reject');
    const r1 = await m.applyDelta([server('A')]);
    // Diff was computed against pre-state, so A is reported as added.
    expect(r1.type).toBe('changed');
    expect(recorder.proxies[0].startCalls).toBe(1);
    expect(recorder.proxies[0].stopCalls).toBe(0);

    // The failing proxy was NOT registered, so a same-config follow-up still
    // sees A as "added" (not "noop") — operator gets a clean retry.
    const r2 = await m.applyDelta([server('A')]);
    expect(r2.type).toBe('changed');
    if (r2.type === 'changed') {
      expect(r2.summary.added).toEqual(['A']);
    }
    // Second proxy attempt was made (default mode was reset to 'resolve').
    expect(recorder.proxies).toHaveLength(2);
    expect(recorder.proxies[1].startCalls).toBe(1);
  });
});
