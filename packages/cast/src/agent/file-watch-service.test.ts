/**
 * Tests for FileWatchService.
 *
 * Most tests drive `onChokidarFire` directly (via the public-for-test bracket
 * access pattern) so timing is deterministic. One smoke test exercises real
 * chokidar end-to-end with a polling waitUntil to guard against future regressions
 * in the event-emit → cursor-advance → fan-out chain.
 *
 * `vi.mock('../config.js')` redirects `agentPath` and `resolveCapabilities`
 * to the tmpdir layout, mirroring the agent-paths.test.ts pattern.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { TMP_ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require('fs') as typeof import('fs');
  const osH = require('os') as typeof import('os');
  const pathH = require('path') as typeof import('path');
  return { TMP_ROOT: fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'cast-fws-test-')) };
});

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    AGENTS_DIR: TMP_ROOT,
    agentPath: (folder: string, ...segments: string[]) =>
      path.join(TMP_ROOT, folder, ...segments),
    sessionClaudePath: (folder: string, _k: string) =>
      path.join(TMP_ROOT, folder, 'sessions', 'testhash', '.claude'),
    sessionCastSocketPath: (folder: string, _k: string) =>
      path.join(TMP_ROOT, folder, 'mcp', 'socket', 'testhash.sock'),
    mcpDir: (folder: string) => path.join(TMP_ROOT, folder, 'mcp', 'socket'),
    resolveCapabilities: (_folder: string) => ({
      resources: {},
      pip: undefined,
      disabledTools: [],
    }),
  };
});

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { FileWatchService } from './file-watch-service.js';
import { mountTable } from '../container/container-mounts.js';
import { appendFeedRow, feedAppendEvents } from '../lib/feed-format.js';
import { _setMockWatcher } from '../lib/config-reader.js';
import type { Host, RouteResult } from '../types.js';

// Mock watcher for readAgentConfig() — reads directly from disk without caching.
_setMockWatcher({
  get: (p: string) => {
    try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
  },
});

const HOST: Host = { name: 'fws-agent', folder: 'fws-agent' };
const AGENT_ID = 'agent:fws-agent';

interface RouteCall {
  address: string;
  senderId: string;
  text: string;
  routing: unknown;
  kind: string | undefined;
  attrs: Record<string, string> | undefined;
}

function setupAgentLayout(): { memoryDir: string } {
  const folder = HOST.folder;
  fs.mkdirSync(path.join(TMP_ROOT, folder, 'blueprint', 'identity'), { recursive: true });
  fs.mkdirSync(path.join(TMP_ROOT, folder, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(TMP_ROOT, folder, 'home'), { recursive: true });
  fs.mkdirSync(path.join(TMP_ROOT, folder, 'blueprint', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(TMP_ROOT, folder, 'shared', 'ext'), { recursive: true });
  fs.mkdirSync(path.join(TMP_ROOT, folder, 'sessions', 'testhash', '.claude'), { recursive: true });
  fs.mkdirSync(path.join(TMP_ROOT, folder, 'state', 'attachments'), { recursive: true });
  fs.mkdirSync(path.join(TMP_ROOT, folder, 'state'), { recursive: true });

  const mt = mountTable(HOST, 'cv|test');
  const stagingMount = mt.find((m) => m.containerPath === '/staging');
  if (stagingMount) {
    fs.mkdirSync(path.join(stagingMount.hostPath, 'in'), { recursive: true });
    fs.mkdirSync(path.join(stagingMount.hostPath, 'out'), { recursive: true });
  }
  // The resolver realpaths (e.g. /var → /private/var on macOS); appendFeedRow
  // and the WatchEntry must agree on the same canonical path.
  return { memoryDir: fs.realpathSync(path.join(TMP_ROOT, folder, 'memory')) };
}

function makeService(routeCalls: RouteCall[] = []): FileWatchService {
  const route = vi.fn(
    async (
      address: string,
      senderId: string,
      text: string,
      routing?: unknown,
      _rawText?: string,
      _declaredName?: string,
      _attachments?: unknown,
      kind?: string,
      attrs?: Record<string, string>,
    ): Promise<RouteResult> => {
      routeCalls.push({ address, senderId, text, routing, kind, attrs });
      return { ok: true, result: null };
    },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new FileWatchService({ folder: HOST.folder, host: HOST, agentId: AGENT_ID, route: route as any });
}

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitUntil: timed out');
}

beforeEach(() => {
  for (const entry of fs.readdirSync(TMP_ROOT)) {
    fs.rmSync(path.join(TMP_ROOT, entry), { recursive: true, force: true });
  }
  feedAppendEvents.removeAllListeners('append');
});

afterEach(() => {
  feedAppendEvents.removeAllListeners('append');
});

describe('FileWatchService — registration', () => {
  it('rejects ENOENT (path-must-exist contract)', async () => {
    setupAgentLayout();
    const svc = makeService();
    await svc.start();
    const result = await svc.register('cv|alice', {
      path: '/memory/missing.jsonl',
      channel: 'cv',
      participant: 'alice',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('does not exist');
    }
    await svc.shutdown();
  });

  it('rejects no-mount paths', async () => {
    setupAgentLayout();
    const svc = makeService();
    await svc.start();
    const result = await svc.register('cv|alice', {
      path: '/random/foo.jsonl',
      channel: 'cv',
      participant: 'alice',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('No watchable mount');
    }
    await svc.shutdown();
  });

  it('registers a watch anchored at current log end (no flood on first fire)', async () => {
    const { memoryDir } = setupAgentLayout();
    const logPath = path.join(memoryDir, 'log.jsonl');
    appendFeedRow(logPath, 'cv|alice', { row: 1 });
    appendFeedRow(logPath, 'cv|alice', { row: 2 });

    const svc = makeService();
    await svc.start();
    const result = await svc.register('cv|alice', {
      path: '/memory/log.jsonl',
      channel: 'cv',
      participant: 'alice',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.lastSeenId).toBe(2); // anchored at current end

    await svc.shutdown();
  });

  it('list returns watches scoped to a single conv-key', async () => {
    const { memoryDir } = setupAgentLayout();
    appendFeedRow(path.join(memoryDir, 'a.jsonl'), 'k1', {});
    appendFeedRow(path.join(memoryDir, 'b.jsonl'), 'k1', {});

    const svc = makeService();
    await svc.start();
    await svc.register('cv|alice', { path: '/memory/a.jsonl', channel: 'cv', participant: 'alice' });
    await svc.register('cv|alice', { path: '/memory/b.jsonl', channel: 'cv', participant: 'alice' });
    await svc.register('cv|bob', { path: '/memory/a.jsonl', channel: 'cv', participant: 'bob' });

    expect(svc.list('cv|alice').map((e) => e.path)).toEqual(['/memory/a.jsonl', '/memory/b.jsonl']);
    expect(svc.list('cv|bob').map((e) => e.path)).toEqual(['/memory/a.jsonl']);
    expect(svc.list('cv|carol')).toEqual([]);

    await svc.shutdown();
  });

  it('rejects duplicate watch on the same path under the same conv-key', async () => {
    const { memoryDir } = setupAgentLayout();
    appendFeedRow(path.join(memoryDir, 'log.jsonl'), 'cv|alice', {});

    const svc = makeService();
    await svc.start();
    await svc.register('cv|alice', { path: '/memory/log.jsonl', channel: 'cv', participant: 'alice' });
    const dup = await svc.register('cv|alice', { path: '/memory/log.jsonl', channel: 'cv', participant: 'alice' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toContain('already exists');

    await svc.shutdown();
  });

  it('unregister removes the entry and persists', async () => {
    const { memoryDir } = setupAgentLayout();
    appendFeedRow(path.join(memoryDir, 'log.jsonl'), 'cv|alice', {});

    const svc = makeService();
    await svc.start();
    await svc.register('cv|alice', { path: '/memory/log.jsonl', channel: 'cv', participant: 'alice' });
    svc.unregister('cv|alice', '/memory/log.jsonl');
    expect(svc.list('cv|alice')).toEqual([]);

    await svc.shutdown();
  });
});

describe('FileWatchService — fire delivery', () => {
  it('happy path: chokidar fire produces a <cast:watch> route call with rows', async () => {
    const { memoryDir } = setupAgentLayout();
    const logPath = path.join(memoryDir, 'log.jsonl');
    fs.writeFileSync(logPath, ''); // anchor existence

    const calls: RouteCall[] = [];
    const svc = makeService(calls);
    await svc.start();
    await svc.register('cv|alice', { path: '/memory/log.jsonl', channel: 'cv', participant: 'alice' });

    // Append from a DIFFERENT convKey so cursor-advance doesn't suppress.
    appendFeedRow(logPath, 'cv|bob', { row: 1 });
    appendFeedRow(logPath, 'cv|bob', { row: 2 });

    // Drive the chokidar fire deterministically.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).deliverFire('cv|alice', svc.list('cv|alice')[0]);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.kind).toBe('watch');
    expect(call.attrs).toEqual({ path: '/memory/log.jsonl', since: '0', through: '2' });
    // Body is XML-escaped — `"` becomes `&quot;`. Look for escaped form.
    expect(call.text).toContain('&quot;id&quot;:1');
    expect(call.text).toContain('&quot;id&quot;:2');
    expect(call.routing).toMatchObject({ channel: 'cv', targetParticipant: 'alice' });
    expect(call.address).toBe(AGENT_ID);
    expect(call.senderId).toBe(AGENT_ID);

    await svc.shutdown();
  });

  it('self-write suppression: writer conv-key gets no fire', async () => {
    const { memoryDir } = setupAgentLayout();
    const logPath = path.join(memoryDir, 'log.jsonl');
    fs.writeFileSync(logPath, '');

    const calls: RouteCall[] = [];
    const svc = makeService(calls);
    await svc.start();
    await svc.register('cv|alice', { path: '/memory/log.jsonl', channel: 'cv', participant: 'alice' });

    // Alice appends — cursor-advance should fire BEFORE chokidar would.
    appendFeedRow(logPath, 'cv|alice', { row: 1 });
    appendFeedRow(logPath, 'cv|alice', { row: 2 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).deliverFire('cv|alice', svc.list('cv|alice')[0]);

    expect(calls).toHaveLength(0); // suppressed
    await svc.shutdown();
  });

  it('peer fan-out: peer conv-key sees rows that writer conv-key suppresses', async () => {
    const { memoryDir } = setupAgentLayout();
    const logPath = path.join(memoryDir, 'log.jsonl');
    fs.writeFileSync(logPath, '');

    const calls: RouteCall[] = [];
    const svc = makeService(calls);
    await svc.start();
    await svc.register('cv|alice', { path: '/memory/log.jsonl', channel: 'cv', participant: 'alice' });
    await svc.register('cv|bob', { path: '/memory/log.jsonl', channel: 'cv', participant: 'bob' });

    appendFeedRow(logPath, 'cv|alice', { row: 1 });

    // Both watch entries try to assemble a fire; alice's should be suppressed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).deliverFire('cv|alice', svc.list('cv|alice')[0]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).deliverFire('cv|bob', svc.list('cv|bob')[0]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.routing).toMatchObject({ targetParticipant: 'bob' });

    await svc.shutdown();
  });

  it('XML-escapes embedded </cast:watch> in row body', async () => {
    const { memoryDir } = setupAgentLayout();
    const logPath = path.join(memoryDir, 'log.jsonl');
    fs.writeFileSync(logPath, '');

    const calls: RouteCall[] = [];
    const svc = makeService(calls);
    await svc.start();
    await svc.register('cv|alice', { path: '/memory/log.jsonl', channel: 'cv', participant: 'alice' });

    appendFeedRow(logPath, 'cv|bob', { evil: '</cast:watch>' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).deliverFire('cv|alice', svc.list('cv|alice')[0]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).not.toContain('</cast:watch>');
    expect(calls[0]!.text).toContain('&lt;/cast:watch&gt;');

    await svc.shutdown();
  });

  it('omits body when token estimate exceeds maxPreviewTokens', async () => {
    const { memoryDir } = setupAgentLayout();
    const logPath = path.join(memoryDir, 'log.jsonl');
    fs.writeFileSync(logPath, '');

    // Set fileWatch.maxPreviewTokens: 0 to force omission.
    const cfgPath = path.join(TMP_ROOT, HOST.folder, 'config');
    fs.mkdirSync(cfgPath, { recursive: true });
    fs.writeFileSync(path.join(cfgPath, 'agent.json'), JSON.stringify({
      fileWatch: { maxPreviewTokens: 0, maxWatchesPerChannel: 3 },
    }));

    const calls: RouteCall[] = [];
    const svc = makeService(calls);
    await svc.start();
    await svc.register('cv|alice', { path: '/memory/log.jsonl', channel: 'cv', participant: 'alice' });

    appendFeedRow(logPath, 'cv|bob', { msg: 'x' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).deliverFire('cv|alice', svc.list('cv|alice')[0]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(''); // body omitted
    expect(calls[0]!.attrs).toMatchObject({ since: '0', through: '1' });

    await svc.shutdown();
  });

  it('corruption-on-read produces error fire with no body and does not advance cursor', async () => {
    const { memoryDir } = setupAgentLayout();
    const logPath = path.join(memoryDir, 'log.jsonl');
    fs.writeFileSync(logPath, '{"id":1,"data":1}\nnot json\n');

    const calls: RouteCall[] = [];
    const svc = makeService(calls);
    await svc.start();
    await svc.register('cv|alice', { path: '/memory/log.jsonl', channel: 'cv', participant: 'alice' });

    // After register, cursor is anchored at validateFeedIntegrity result.
    // Corrupt feed → validateFeedIntegrity fails → register sets lastSeenId to 0.
    const before = svc.list('cv|alice')[0]!.lastSeenId;
    expect(before).toBe(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).deliverFire('cv|alice', svc.list('cv|alice')[0]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe('');
    expect(calls[0]!.attrs).toMatchObject({ path: '/memory/log.jsonl' });
    expect(calls[0]!.attrs!.error).toContain('feed-corrupt-at-row-');
    // Cursor unchanged on corruption
    expect(svc.list('cv|alice')[0]!.lastSeenId).toBe(0);

    await svc.shutdown();
  });

  it('cursor advances after successful fire and persists', async () => {
    const { memoryDir } = setupAgentLayout();
    const logPath = path.join(memoryDir, 'log.jsonl');
    fs.writeFileSync(logPath, '');

    const calls: RouteCall[] = [];
    const svc = makeService(calls);
    await svc.start();
    await svc.register('cv|alice', { path: '/memory/log.jsonl', channel: 'cv', participant: 'alice' });

    appendFeedRow(logPath, 'cv|bob', { row: 1 });
    appendFeedRow(logPath, 'cv|bob', { row: 2 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).deliverFire('cv|alice', svc.list('cv|alice')[0]);
    expect(svc.list('cv|alice')[0]!.lastSeenId).toBe(2);

    // Persistence on disk reflects the advance
    const registry = JSON.parse(
      fs.readFileSync(path.join(TMP_ROOT, HOST.folder, 'state', 'file-watches.json'), 'utf-8'),
    );
    expect(registry['cv|alice'][0].lastSeenId).toBe(2);

    await svc.shutdown();
  });
});

describe('FileWatchService — boot persistence', () => {
  it('persists registry to state/file-watches.json on register', async () => {
    const { memoryDir } = setupAgentLayout();
    appendFeedRow(path.join(memoryDir, 'log.jsonl'), 'k', {});

    const svc = makeService();
    await svc.start();
    await svc.register('cv|alice', {
      path: '/memory/log.jsonl',
      channel: 'cv',
      participant: 'alice',
      qualifier: 'shard-1',
    });

    const raw = fs.readFileSync(path.join(TMP_ROOT, HOST.folder, 'state', 'file-watches.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed['cv|alice']).toHaveLength(1);
    expect(parsed['cv|alice'][0]).toMatchObject({
      path: '/memory/log.jsonl',
      channel: 'cv',
      participant: 'alice',
      qualifier: 'shard-1',
    });
    // hostPath must NOT be serialized (derived state)
    expect(parsed['cv|alice'][0].hostPath).toBeUndefined();

    await svc.shutdown();
  });

  it('re-arms watches at boot with restored cursors', async () => {
    const { memoryDir } = setupAgentLayout();
    const logPath = path.join(memoryDir, 'log.jsonl');
    appendFeedRow(logPath, 'k', { r: 1 });

    const svc1 = makeService();
    await svc1.start();
    await svc1.register('cv|alice', { path: '/memory/log.jsonl', channel: 'cv', participant: 'alice' });
    appendFeedRow(logPath, 'cv|bob', { r: 2 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc1 as any).deliverFire('cv|alice', svc1.list('cv|alice')[0]);
    expect(svc1.list('cv|alice')[0]!.lastSeenId).toBe(2);
    await svc1.shutdown();

    // New service instance — should restore cursor from disk
    const svc2 = makeService();
    await svc2.start();
    expect(svc2.list('cv|alice')).toHaveLength(1);
    expect(svc2.list('cv|alice')[0]!.lastSeenId).toBe(2);
    await svc2.shutdown();
  });

  it('drops dead-path entries at boot and re-persists', async () => {
    const { memoryDir } = setupAgentLayout();
    const logPath = path.join(memoryDir, 'log.jsonl');
    appendFeedRow(logPath, 'k', {});

    const svc1 = makeService();
    await svc1.start();
    await svc1.register('cv|alice', { path: '/memory/log.jsonl', channel: 'cv', participant: 'alice' });
    await svc1.shutdown();

    // Delete the file out from under the registry.
    fs.unlinkSync(logPath);

    const svc2 = makeService();
    await svc2.start();
    expect(svc2.list('cv|alice')).toEqual([]);
    // Registry on disk should be empty (or convKey absent)
    const raw = fs.readFileSync(path.join(TMP_ROOT, HOST.folder, 'state', 'file-watches.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed['cv|alice']).toBeUndefined();
    await svc2.shutdown();
  });

  it('handles missing registry file as empty (first-boot)', async () => {
    setupAgentLayout();
    const svc = makeService();
    await svc.start();
    expect(svc.list('cv|alice')).toEqual([]);
    await svc.shutdown();
  });
});

describe('FileWatchService — TTL prune + restore re-anchor', () => {
  it('prunes expired entries at boot and re-persists registry', async () => {
    const { memoryDir } = setupAgentLayout();
    appendFeedRow(path.join(memoryDir, 'live.jsonl'), 'k', {});
    appendFeedRow(path.join(memoryDir, 'gone.jsonl'), 'k', {});

    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    fs.writeFileSync(
      path.join(TMP_ROOT, HOST.folder, 'state', 'file-watches.json'),
      JSON.stringify({
        'cv|alice': [
          { path: '/memory/gone.jsonl', lastSeenId: 0, channel: 'cv', participant: 'alice', registered: past, expiresAt: past },
          { path: '/memory/live.jsonl', lastSeenId: 0, channel: 'cv', participant: 'alice', registered: past, expiresAt: future },
        ],
      }),
    );

    const svc = makeService();
    await svc.start();

    const entries = svc.list('cv|alice');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe('/memory/live.jsonl');

    const persisted = JSON.parse(
      fs.readFileSync(path.join(TMP_ROOT, HOST.folder, 'state', 'file-watches.json'), 'utf-8'),
    );
    expect(persisted['cv|alice']).toHaveLength(1);
    expect(persisted['cv|alice'][0].path).toBe('/memory/live.jsonl');

    await svc.shutdown();
  });

  it('prunes expired entry at fire-tick — silent (no route call) and unregisters', async () => {
    const { memoryDir } = setupAgentLayout();
    const logPath = path.join(memoryDir, 'log.jsonl');
    appendFeedRow(logPath, 'k', {});

    const calls: RouteCall[] = [];
    const svc = makeService(calls);
    await svc.start();
    await svc.register('cv|alice', {
      path: '/memory/log.jsonl',
      channel: 'cv',
      participant: 'alice',
      // Already-expired at registration time — service stores it; the next
      // fire-tick should prune.
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    expect(svc.list('cv|alice')).toHaveLength(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).deliverFire('cv|alice', svc.list('cv|alice')[0]);

    expect(calls).toHaveLength(0);
    expect(svc.list('cv|alice')).toEqual([]);

    await svc.shutdown();
  });

  it('re-anchors stale cursor after restore: emits no-body fire with note attr and resets', async () => {
    const { memoryDir } = setupAgentLayout();
    const logPath = path.join(memoryDir, 'log.jsonl');
    // Log has rows up to id=10 only.
    for (let i = 0; i < 10; i++) appendFeedRow(logPath, 'k', { i });

    const past = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(
      path.join(TMP_ROOT, HOST.folder, 'state', 'file-watches.json'),
      JSON.stringify({
        // Stale cursor — registry says we'd seen up to id=50.
        'cv|alice': [
          { path: '/memory/log.jsonl', lastSeenId: 50, channel: 'cv', participant: 'alice', registered: past },
        ],
      }),
    );

    const calls: RouteCall[] = [];
    const svc = makeService(calls);
    await svc.start();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).deliverFire('cv|alice', svc.list('cv|alice')[0]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe('');
    expect(calls[0]!.attrs).toEqual({
      path: '/memory/log.jsonl',
      note: 'cursor-reanchored-after-restore',
    });

    // Cursor reset to log end (10).
    expect(svc.list('cv|alice')[0]!.lastSeenId).toBe(10);

    // Subsequent fires don't re-trigger the re-anchor (lastSeenId === highestId).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).deliverFire('cv|alice', svc.list('cv|alice')[0]);
    expect(calls).toHaveLength(1);

    await svc.shutdown();
  });
});

describe('FileWatchService — chokidar smoke', () => {
  // Retries: chokidar polling jitter under parallel test-worker load. The
  // fire→cursor→fan-out chain is covered deterministically by the other
  // tests in this file (via direct `onChokidarFire` invocation); this smoke
  // test only guards the chokidar→handler hookup, so a transient miss isn't
  // hiding a real bug.
  it('drives a fire end-to-end via real chokidar (writer = different conv-key, no suppression)', { timeout: 10_000, retry: 2 }, async () => {
    const { memoryDir } = setupAgentLayout();
    const logPath = path.join(memoryDir, 'log.jsonl');
    fs.writeFileSync(logPath, '');

    const calls: RouteCall[] = [];
    const svc = makeService(calls);
    await svc.start();
    await svc.register('cv|alice', { path: '/memory/log.jsonl', channel: 'cv', participant: 'alice' });

    appendFeedRow(logPath, 'cv|bob', { hello: 'world' });

    await waitUntil(() => calls.length > 0, 6000);
    expect(calls[0]!.kind).toBe('watch');
    expect(calls[0]!.attrs!.path).toBe('/memory/log.jsonl');

    await svc.shutdown();
  });
});
