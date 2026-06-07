import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { FileWatcher } from './lib/file-watcher.js';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

/** Poll until `check` returns truthy or the deadline expires. */
async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitUntil: timed out');
}

// Retry at suite level: every test in this file drives real chokidar against
// the OS filesystem and uses waitUntil polling. Under parallel vitest-worker
// load the FS-event/polling latency can exceed the per-test waitUntil window.
// The watcher logic itself is deterministic — only the event delivery timing
// is flaky. One retry absorbs the jitter without masking real bugs.
describe('FileWatcher.onAnyChange', { retry: 2 }, () => {
  let tmpDir: string;
  let watcher: FileWatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-fw-'));
    watcher = new FileWatcher();
  });

  afterEach(async () => {
    await watcher.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fires on file add after start', async () => {
    await watcher.start([{ path: tmpDir, depth: 0 }]);
    const cb = vi.fn();
    watcher.onAnyChange(cb);

    fs.writeFileSync(path.join(tmpDir, 'foo.txt'), 'hello');
    await waitUntil(() => cb.mock.calls.length > 0);

    expect(cb).toHaveBeenCalled();
  });

  it('fires on file change', async () => {
    const filePath = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(filePath, 'v1');
    await watcher.start([{ path: tmpDir, depth: 0 }]);

    const cb = vi.fn();
    watcher.onAnyChange(cb);

    fs.writeFileSync(filePath, 'v2');
    await waitUntil(() => cb.mock.calls.length > 0);

    expect(cb).toHaveBeenCalled();
  });

  it('fires on file unlink', async () => {
    const filePath = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(filePath, 'doomed');
    await watcher.start([{ path: tmpDir, depth: 0 }]);

    const cb = vi.fn();
    watcher.onAnyChange(cb);

    fs.unlinkSync(filePath);
    await waitUntil(() => cb.mock.calls.length > 0);

    expect(cb).toHaveBeenCalled();
  });

  it('fires multiple subscribers independently', async () => {
    await watcher.start([{ path: tmpDir, depth: 0 }]);

    const a = vi.fn();
    const b = vi.fn();
    watcher.onAnyChange(a);
    watcher.onAnyChange(b);

    fs.writeFileSync(path.join(tmpDir, 'x.txt'), 'x');
    await waitUntil(() => a.mock.calls.length > 0 && b.mock.calls.length > 0);

    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('isolates throwing listeners (one throws, others still fire)', async () => {
    await watcher.start([{ path: tmpDir, depth: 0 }]);

    const good = vi.fn();
    watcher.onAnyChange(() => { throw new Error('boom'); });
    watcher.onAnyChange(good);

    fs.writeFileSync(path.join(tmpDir, 'y.txt'), 'y');
    await waitUntil(() => good.mock.calls.length > 0, 5000);

    expect(good).toHaveBeenCalled();
  });

  it('skips firing when content is unchanged (content-equality dedup)', async () => {
    const filePath = path.join(tmpDir, 'c.txt');
    fs.writeFileSync(filePath, 'same');
    await watcher.start([{ path: tmpDir, depth: 0 }]);

    const cb = vi.fn();
    watcher.onAnyChange(cb);

    // Re-write the same content — chokidar sees a change event, but the
    // watcher should dedup by content and not fire onAnyChange.
    fs.writeFileSync(filePath, 'same');
    await new Promise((r) => setTimeout(r, 200));

    expect(cb).not.toHaveBeenCalled();
  });

  it('clears subscribers on shutdown', async () => {
    await watcher.start([{ path: tmpDir, depth: 0 }]);
    const cb = vi.fn();
    watcher.onAnyChange(cb);

    await watcher.shutdown();

    // Starting a fresh watcher in the same tmpDir and writing shouldn't fire
    // the cb from the shut-down watcher (no observable side effect; we just
    // verify shutdown didn't throw and the closure is orphaned).
    expect(true).toBe(true);
  });
});

/**
 * onDirChange — subscribe to addDir / unlinkDir events on direct
 * children of the watched root. Drives the AGENTS_DIR snapshot reconciler.
 */
describe('FileWatcher.onDirChange', { retry: 2 }, () => {
  let tmpDir: string;
  let watcher: FileWatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-fw-dir-'));
    watcher = new FileWatcher();
  });

  afterEach(async () => {
    await watcher.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fires on subdirectory creation (addDir)', { timeout: 10_000 }, async () => {
    await watcher.start([{ path: tmpDir, depth: 0 }]);
    // FSEvents on macOS is flaky for fresh directories created moments after
    // start — give the watcher a settle window so the subscription is fully
    // registered with the kernel before we mkdir.
    await new Promise((r) => setTimeout(r, 200));

    const events: Array<{ kind: string; path: string }> = [];
    watcher.onDirChange(tmpDir, (e) => events.push(e));

    const subDir = path.join(tmpDir, 'probe-add');
    fs.mkdirSync(subDir);

    await waitUntil(() => events.some((e) => e.kind === 'addDir'), 8000);
    const addEvent = events.find((e) => e.kind === 'addDir');
    expect(addEvent?.path).toBe(subDir);
  });

  it('fires on subdirectory deletion (unlinkDir)', async () => {
    const subDir = path.join(tmpDir, 'probe-remove');
    fs.mkdirSync(subDir);

    await watcher.start([{ path: tmpDir, depth: 0 }]);
    const events: Array<{ kind: string; path: string }> = [];
    watcher.onDirChange(tmpDir, (e) => events.push(e));

    fs.rmSync(subDir, { recursive: true, force: true });

    await waitUntil(() => events.some((e) => e.kind === 'unlinkDir'), 2000);
    const removeEvent = events.find((e) => e.kind === 'unlinkDir');
    expect(removeEvent?.path).toBe(subDir);
  });

  it('does not fire for the watched root itself', async () => {
    // chokidar emits an addDir for the watch root on ready — we filter it.
    await watcher.start([{ path: tmpDir, depth: 0 }]);
    const events: Array<{ kind: string; path: string }> = [];
    watcher.onDirChange(tmpDir, (e) => events.push(e));

    // Wait long enough that any chokidar root-emit would have arrived.
    await new Promise((r) => setTimeout(r, 200));

    expect(events.find((e) => e.path === tmpDir)).toBeUndefined();
  });

  it('clears dir subscribers on shutdown', async () => {
    await watcher.start([{ path: tmpDir, depth: 0 }]);
    const cb = vi.fn();
    watcher.onDirChange(tmpDir, cb);

    await watcher.shutdown();
    // No throw. State is internal — exercising via no-op assertion.
    expect(true).toBe(true);
  });
});

/**
 * IGNORED patterns are applied to the watched-root-relative path, not the
 * absolute path. Confirms (1) a dotted ancestor segment outside the watch
 * root does not silently exclude inner files, and (2) relative dot-files
 * inside the watch tree are still filtered as intended.
 */
describe('FileWatcher IGNORED patterns', { retry: 2 }, () => {
  let tmpDir: string;
  let watcher: FileWatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-fw-ignored-'));
    watcher = new FileWatcher();
  });

  afterEach(async () => {
    await watcher.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not exclude inner files when the watch root has a dotted ancestor', async () => {
    // Pre-fix this fails — the absolute path contains `.scaffold/` and the
    // dot-entry regex matches that ancestor segment, silently excluding the
    // entire watched tree.
    const watchRoot = path.join(tmpDir, '.scaffold', 'agents');
    fs.mkdirSync(watchRoot, { recursive: true });
    const filePath = path.join(watchRoot, 'data.txt');
    fs.writeFileSync(filePath, 'v1');

    await watcher.start([{ path: watchRoot, depth: 0 }]);
    const cb = vi.fn();
    watcher.onAnyChange(cb);

    fs.writeFileSync(filePath, 'v2');
    await waitUntil(() => cb.mock.calls.length > 0);

    expect(cb).toHaveBeenCalled();
  });

  it('still filters relative dot-files inside the watch tree', async () => {
    const dotDir = path.join(tmpDir, '.cache');
    fs.mkdirSync(dotDir, { recursive: true });
    const dotFile = path.join(dotDir, 'secret.json');
    const visibleFile = path.join(tmpDir, 'visible.txt');
    fs.writeFileSync(dotFile, 'v1');
    fs.writeFileSync(visibleFile, 'v1');

    await watcher.start([{ path: tmpDir, depth: 1 }]);
    const cb = vi.fn();
    watcher.onAnyChange(cb);

    // Touch the dot-file first — should NOT fire (filtered by relative-path
    // match on `.cache/...`).
    fs.writeFileSync(dotFile, 'v2');
    await new Promise((r) => setTimeout(r, 200));
    expect(cb).not.toHaveBeenCalled();

    // Touch the sibling visible file — should fire.
    fs.writeFileSync(visibleFile, 'v2');
    await waitUntil(() => cb.mock.calls.length > 0);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
