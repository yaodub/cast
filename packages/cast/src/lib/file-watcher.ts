/**
 * FileWatcher — infrastructure-level filesystem watcher backed by chokidar.
 *
 * Watches directories, maintains a raw string content cache, and emits change
 * events. Knows nothing about JSON, Zod, dotenv, agents, or config semantics.
 *
 * Ignored patterns are applied to the **watched-root-relative** path via a
 * per-watcher closure (`makeIgnoreFn`). Applying them to the absolute path
 * would let an ancestor segment like `.test/` or `~/.cast/` silently exclude
 * every file under the watch root.
 */
import fs from 'fs';
import path from 'path';

import { watch as chokidarWatch } from 'chokidar';
import type { FSWatcher } from 'chokidar';

import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchDir {
  path: string;
  depth?: number;
}

// ---------------------------------------------------------------------------
// Ignore patterns — applied to the watched-root-relative path, not absolute
// ---------------------------------------------------------------------------

const PATTERNS = [
  // Dot-entries (.backups/, .stamps/, .composer/, .claude/, .DS_Store, .env,
  // .env.bak, etc.). Extension credentials live in `secrets.json`; no
  // dot-files in the watched config tree need to be cached.
  /(^|[/\\])\.[^/\\]*/,
  /node_modules/,
  /\.db(-wal|-shm)?$/, // SQLite files
  /\.tmp$/, // writeAtomic temp files
  // Extension auth directories — internal state only (creds, pre-keys, LID
  // mappings, sync state). Never config, never admin-UI-relevant. Excluded
  // because high-churn operations (e.g. WhatsApp unpair deleting ~900 files)
  // would otherwise fire hundreds of SSE events and overflow the admin
  // UI's batched tRPC refetch URL past Node's 16KB header limit.
  /[/\\]ext[/\\][^/\\]+[/\\]auth([/\\]|$)/,
];

/**
 * Build a chokidar `ignored` matcher that tests PATTERNS against the path
 * relative to the watched root. Each watcher gets its own closure so the
 * root is captured per instance — applying PATTERNS to the absolute path
 * would let dotted ancestors (e.g. `.test/`, `~/.cast/`) silently exclude
 * every file in the tree.
 */
function makeIgnoreFn(absDir: string): (filePath: string) => boolean {
  return (filePath) => {
    const rel = path.relative(absDir, filePath);
    // path.relative(absDir, absDir) returns ''; never ignore the root itself.
    if (rel === '') return false;
    return PATTERNS.some((rx) => rx.test(rel));
  };
}

// ---------------------------------------------------------------------------
// FileWatcher
// ---------------------------------------------------------------------------

export class FileWatcher {
  /** Raw file content keyed by absolute path. */
  private cache = new Map<string, string>();

  /** One chokidar FSWatcher per watched directory root. */
  private watchers = new Map<string, FSWatcher>();

  /** onChange subscribers keyed by watched directory root. */
  private listeners = new Map<string, Set<(filePath: string) => void>>();

  /** onDirChange subscribers keyed by watched directory root. Fires on
   *  addDir / unlinkDir events for direct children of the watched root.
   *  Used by the AGENTS_DIR snapshot reconciler — see index.ts. */
  private dirListeners = new Map<string, Set<(event: { kind: 'addDir' | 'unlinkDir'; path: string }) => void>>();

  /** Subscribers that fire on every content-changing event across all watched dirs. */
  private anyChangeListeners = new Set<() => void>();

  /** All watched directory roots — for the get() guard. */
  private watchedDirs = new Set<string>();

  /** Monotonic counter bumped on every content-changing event. */
  private versionCounter = 0;

  /** Current version — admin UI polls this. */
  get version(): number {
    return this.versionCounter;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Start watching. Resolves after all chokidar instances report ready (cache warm). */
  async start(dirs: WatchDir[]): Promise<void> {
    await Promise.all(dirs.map((d) => this.addWatcher(d)));
    logger.info(
      { dirs: dirs.map((d) => d.path), cacheSize: this.cache.size },
      'FileWatcher ready',
    );
  }

  /**
   * Watch an additional directory (e.g. newly discovered agent paths).
   * Resolves after chokidar reports ready — cache is warm on resolve.
   * Callers that need warm cache before reading must await this.
   */
  watch(dir: WatchDir): Promise<void> {
    if (this.watchers.has(dir.path)) return Promise.resolve();
    return this.addWatcher(dir).catch((err) => {
      logger.warn({ dir: dir.path, err }, 'FileWatcher: failed to watch directory');
    });
  }

  /** Stop watching a directory and remove all its listeners. Frees OS descriptors. */
  unwatch(dir: string): void {
    const watcher = this.watchers.get(dir);
    if (!watcher) return;
    watcher.close().catch((err) => {
      logger.warn({ dir, err }, 'FileWatcher: error closing watcher');
    });
    this.watchers.delete(dir);
    this.listeners.delete(dir);
    this.dirListeners.delete(dir);
    this.watchedDirs.delete(dir);

    // Remove cache entries under this directory
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix) || key === dir) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get cached content. Returns null if file doesn't exist or is not cached.
   * Throws if path is not under any watched directory — catches wiring bugs early.
   */
  get(filePath: string): string | null {
    const abs = path.resolve(filePath);
    if (!this.isUnderWatchedDir(abs)) {
      throw new Error(
        `FileWatcher.get() called for unwatched path: ${abs}`,
      );
    }
    return this.cache.get(abs) ?? null;
  }

  /** Subscribe to changes in a directory. Callback receives the changed file path. */
  onChange(dir: string, callback: (filePath: string) => void): void {
    let set = this.listeners.get(dir);
    if (!set) {
      set = new Set();
      this.listeners.set(dir, set);
    }
    set.add(callback);
  }

  /**
   * Subscribe to subdirectory create/remove events for a watched directory.
   * Fires only for direct children (chokidar `addDir` / `unlinkDir` at the
   * watch root). Distinct from `onChange` because subdirectory lifecycle is
   * its own concern (e.g. AGENTS_DIR adds/removes whole agents) and overloading
   * `onChange` would silently break callers expecting file paths.
   */
  onDirChange(
    dir: string,
    callback: (event: { kind: 'addDir' | 'unlinkDir'; path: string }) => void,
  ): void {
    let set = this.dirListeners.get(dir);
    if (!set) {
      set = new Set();
      this.dirListeners.set(dir, set);
    }
    set.add(callback);
  }

  /** Subscribe to every content-changing event across all watched dirs. Used by admin SSE. */
  onAnyChange(callback: () => void): void {
    this.anyChangeListeners.add(callback);
  }

  /** Stop all watchers, clear cache, remove listeners. */
  async shutdown(): Promise<void> {
    const closers = [...this.watchers.values()].map((w) =>
      w.close().catch((err) => {
        logger.warn({ err }, 'FileWatcher: error during shutdown');
      }),
    );
    await Promise.all(closers);
    this.watchers.clear();
    this.listeners.clear();
    this.dirListeners.clear();
    this.anyChangeListeners.clear();
    this.watchedDirs.clear();
    this.cache.clear();
    logger.info('FileWatcher shut down');
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async addWatcher(dir: WatchDir): Promise<void> {
    const absDir = path.resolve(dir.path);
    if (this.watchers.has(absDir)) return;
    this.watchedDirs.add(absDir);

    // Ensure directory exists — chokidar v4 errors on missing paths
    if (!fs.existsSync(absDir)) {
      fs.mkdirSync(absDir, { recursive: true });
    }

    const watcher = chokidarWatch(absDir, {
      depth: dir.depth,
      ignored: makeIgnoreFn(absDir),
      persistent: true,
      ignoreInitial: false, // populate cache on ready
      // Wait for file size/mtime to stabilize before firing — without this,
      // FSEvents on macOS can deliver the 'change' event before the kernel
      // flushes the write, causing handleFileEvent to read stale content and
      // silently suppress the event via content-equality dedup.
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
    });

    this.watchers.set(absDir, watcher);

    watcher.on('add', (filePath: string) => this.handleFileEvent(absDir, filePath));
    watcher.on('change', (filePath: string) => this.handleFileEvent(absDir, filePath));
    watcher.on('unlink', (filePath: string) => this.handleUnlink(absDir, filePath));
    watcher.on('addDir', (dirPath: string) => this.handleDirEvent(absDir, dirPath, 'addDir'));
    watcher.on('unlinkDir', (dirPath: string) => this.handleDirEvent(absDir, dirPath, 'unlinkDir'));
    watcher.on('error', (err) => {
      logger.warn({ dir: absDir, err }, 'FileWatcher: chokidar error');
    });

    await new Promise<void>((resolve) => {
      watcher.on('ready', resolve);
    });
  }

  /** Handle add/change events — read file, dedup by content, fire listeners. */
  private handleFileEvent(watchDir: string, filePath: string): void {
    const abs = path.resolve(filePath);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      // File disappeared between event and read — treat as unlink
      this.handleUnlink(watchDir, filePath);
      return;
    }

    const prev = this.cache.get(abs);
    if (prev === content) return; // content-equality dedup

    this.cache.set(abs, content);
    this.versionCounter++;
    this.fireListeners(watchDir, abs);
    this.fireAnyChangeListeners();
  }

  /**
   * Handle addDir / unlinkDir events. Fires only for direct children of the
   * watch root — chokidar emits an event for the watch root itself on ready,
   * which we filter out. The watch root's own lifecycle is the caller's
   * concern (we already mkdir-recursive on add at addWatcher boot).
   */
  private handleDirEvent(watchDir: string, dirPath: string, kind: 'addDir' | 'unlinkDir'): void {
    const abs = path.resolve(dirPath);
    if (abs === watchDir) return; // skip the root itself
    const set = this.dirListeners.get(watchDir);
    if (!set) return;
    for (const cb of set) {
      try {
        cb({ kind, path: abs });
      } catch (err) {
        logger.warn({ watchDir, dirPath: abs, kind, err }, 'FileWatcher: onDirChange listener threw');
      }
    }
  }

  /** Handle unlink events — remove from cache, fire listeners. */
  private handleUnlink(watchDir: string, filePath: string): void {
    const abs = path.resolve(filePath);
    if (!this.cache.has(abs)) return;
    this.cache.delete(abs);
    this.versionCounter++;
    this.fireListeners(watchDir, abs);
    this.fireAnyChangeListeners();
  }

  /** Fire all listeners registered for the directory that owns this file. */
  private fireListeners(watchDir: string, filePath: string): void {
    const set = this.listeners.get(watchDir);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(filePath);
      } catch (err) {
        logger.warn({ watchDir, filePath, err }, 'FileWatcher: listener threw');
      }
    }
  }

  /** Fire global (any-change) listeners. Called after per-dir listeners. */
  private fireAnyChangeListeners(): void {
    for (const cb of this.anyChangeListeners) {
      try {
        cb();
      } catch (err) {
        logger.warn({ err }, 'FileWatcher: onAnyChange listener threw');
      }
    }
  }

  /** Check if an absolute path falls under any watched directory. */
  private isUnderWatchedDir(abs: string): boolean {
    for (const dir of this.watchedDirs) {
      if (abs.startsWith(dir + path.sep) || abs === dir) return true;
    }
    return false;
  }
}
