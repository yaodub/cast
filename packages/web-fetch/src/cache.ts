/**
 * SQLite cache for raw fetch results + request log.
 *
 * Caches raw HTML and response headers (not processed FetchResult),
 * so different pipeline combinations can re-process without re-fetching.
 *
 * Module-level singleton (same pattern as packages/cast/src/db.ts).
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { fetchPage } from './browser.js';
import type { FetchPageResult } from './browser.js';
import { validateFetchUrl } from './url-validation.js';

// SIDE EFFECT: Module-level singletons, initialized by initCache().
// Required for cache and config to persist across calls within a process lifetime.
// Pure alternative (passing db handle everywhere) adds parameter noise to every function.
let db: Database.Database;
let defaultMaxAge = 30;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      url TEXT PRIMARY KEY,
      html TEXT NOT NULL,
      content_type TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      final_url TEXT NOT NULL,
      response_headers TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      cache_hit INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_request_log_url ON request_log(url);
  `);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export type CacheConfig = {
  dbPath: string;
  defaultMaxAgeSeconds?: number;
};

export function initCache(config: CacheConfig): void {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  createSchema(db);
  defaultMaxAge = config.defaultMaxAgeSeconds ?? 30;
}

/** @internal — for tests only. Creates a fresh in-memory database. */
export function _initTestCache(): void {
  db = new Database(':memory:');
  createSchema(db);
  defaultMaxAge = 30;
}

export function closeCache(): void {
  if (db) {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Cache-Control parsing
// ---------------------------------------------------------------------------

/**
 * Extract max-age value from a Cache-Control header.
 * Returns 0 for no-cache/no-store directives.
 * Returns undefined if no max-age directive found.
 */
export function parseCacheControlMaxAge(header: string | undefined): number | undefined {
  if (!header) return undefined;

  const lower = header.toLowerCase();
  if (lower.includes('no-cache') || lower.includes('no-store')) return 0;

  const match = lower.match(/max-age=(\d+)/);
  if (match?.[1]) return Number(match[1]);

  return undefined;
}

// ---------------------------------------------------------------------------
// Core cache operations
// ---------------------------------------------------------------------------

const CachedRowSchema = z.object({
  url: z.string(),
  html: z.string(),
  content_type: z.string(),
  status_code: z.number(),
  final_url: z.string(),
  response_headers: z.string(),
  fetched_at: z.string(),
  expires_at: z.string(),
});

const ResponseHeadersSchema = z.record(z.string(), z.string());

function getCached(url: string): FetchPageResult | undefined {
  const raw = db
    .prepare('SELECT * FROM cache WHERE url = ? AND expires_at > ?')
    .get(url, new Date().toISOString());

  const row = CachedRowSchema.safeParse(raw);
  if (!row.success) return undefined;

  return {
    html: row.data.html,
    contentType: row.data.content_type,
    url: row.data.final_url,
    statusCode: row.data.status_code,
    headers: ResponseHeadersSchema.parse(JSON.parse(row.data.response_headers)),
  };
}

function storeInCache(url: string, result: FetchPageResult, maxAge: number): void {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + maxAge * 1000);

  db.prepare(
    `INSERT OR REPLACE INTO cache
       (url, html, content_type, status_code, final_url, response_headers, fetched_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    url,
    result.html,
    result.contentType,
    result.statusCode,
    result.url,
    JSON.stringify(result.headers),
    now.toISOString(),
    expiresAt.toISOString(),
  );
}

function logRequest(url: string, cacheHit: boolean): void {
  db.prepare('INSERT INTO request_log (url, requested_at, cache_hit) VALUES (?, ?, ?)').run(
    url,
    new Date().toISOString(),
    cacheHit ? 1 : 0,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type CachedFetchOptions = {
  timeout?: number;
};

/**
 * Fetch a URL with caching. Checks cache first, falls back to fetchPage().
 * Always logs the request (hit or miss).
 */
export async function cachedFetch(
  url: string,
  opts?: CachedFetchOptions,
): Promise<FetchPageResult & { cacheHit: boolean }> {
  validateFetchUrl(url);

  const cached = getCached(url);
  if (cached) {
    logRequest(url, true);
    return { ...cached, cacheHit: true };
  }

  const result = await fetchPage(url, { timeout: opts?.timeout });

  // Determine max-age: response header → config default
  const cacheControl = result.headers['cache-control'];
  const headerMaxAge = parseCacheControlMaxAge(cacheControl);
  const maxAge = headerMaxAge ?? defaultMaxAge;

  // max-age 0 means no-cache/no-store — skip caching but still log
  if (maxAge > 0) {
    storeInCache(url, result, maxAge);
  }

  logRequest(url, false);
  return { ...result, cacheHit: false };
}

// ---------------------------------------------------------------------------
// Request log
// ---------------------------------------------------------------------------

export type RequestLogEntry = {
  id: number;
  url: string;
  requested_at: string;
  cache_hit: boolean;
};

const RequestLogRowSchema = z.object({
  id: z.number(),
  url: z.string(),
  requested_at: z.string(),
  cache_hit: z.number(),
});

export function getRequestLog(limit = 100): RequestLogEntry[] {
  const rows = z.array(RequestLogRowSchema).parse(
    db.prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT ?').all(limit),
  );

  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    requested_at: r.requested_at,
    cache_hit: r.cache_hit === 1,
  }));
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

export function evictUrl(url: string): void {
  db.prepare('DELETE FROM cache WHERE url = ?').run(url);
}

export function evictExpired(): number {
  const result = db.prepare('DELETE FROM cache WHERE expires_at <= ?').run(new Date().toISOString());
  return result.changes;
}
