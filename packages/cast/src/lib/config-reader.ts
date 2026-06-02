/**
 * config-reader — typed config access layer over FileWatcher.
 *
 * Three functions: readText, readJson, readParsed.
 * All delegate to watcher.get() for the raw string, then parse.
 * Only this module and watcher subscription callbacks import the watcher directly.
 */
import type { z } from 'zod';

import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Watcher injection
// ---------------------------------------------------------------------------

/** Minimal interface — satisfied by FileWatcher and test mocks alike. */
export interface WatcherLike {
  get(path: string): string | null;
}

// SIDE EFFECT: Module-level watcher reference, set once at startup via setWatcher().
// Required because config reads are scattered across many modules that shouldn't
// thread a watcher parameter through every call chain.
let watcher: WatcherLike | null = null;

/** Set the watcher instance. Called once at startup after FileWatcher.start(). */
export function setWatcher(w: WatcherLike): void {
  watcher = w;
}

/** @internal — for tests only. Accepts any object with a get() method. */
export function _setMockWatcher(mock: WatcherLike | null): void {
  watcher = mock;
}

function getWatcher(): WatcherLike {
  if (!watcher) throw new Error('config-reader: watcher not initialized — call setWatcher() first');
  return watcher;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read raw text content. Returns null if file doesn't exist. */
export function readText(filePath: string): string | null {
  return getWatcher().get(filePath);
}

/** Read and JSON.parse. Returns null if file doesn't exist or is invalid JSON. */
export function readJson(filePath: string): unknown | null {
  const raw = readText(filePath);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read, JSON.parse, and Zod-validate. Returns fallback on any failure. Never throws.
 * Parse failures on non-empty files are logged at warn so a malformed file
 * surfaces in logs rather than silently presenting as empty state (e.g. a
 * wiped extension list).
 */
export function readParsed<T>(filePath: string, schema: z.ZodType<T>, fallback: T): T {
  const raw = readText(filePath);
  if (raw == null) return fallback;
  try {
    return schema.parse(JSON.parse(raw));
  } catch (err) {
    logger.warn(
      { filePath, err: err instanceof Error ? err.message : String(err) },
      'Failed to parse config file — using fallback',
    );
    return fallback;
  }
}

