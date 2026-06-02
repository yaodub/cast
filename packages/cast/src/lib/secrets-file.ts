/**
 * Per-extension `secrets.json` reader/writer.
 *
 * Holds extension credentials. Server-level `.env` for AUTH_MODE / API keys
 * uses `lib/env-file.ts` separately.
 *
 * Reads bypass the watcher cache. Activation reads via `lib/config-reader.ts`'s
 * `readParsed` so the registry hot-reload sees mtime-stamped content; this module
 * is for callers (migration script, admin routers) that need direct fs access
 * outside the watcher contract.
 */
import fs from 'fs';

import { writeAtomic } from './utils.js';

/** Parse a `secrets.json` file into a key-value record. Returns empty record on any failure. */
export function readSecretsJson(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Write a key-value record as `secrets.json`. Atomic via temp + rename. */
export function writeSecretsJson(filePath: string, secrets: Record<string, unknown>): void {
  writeAtomic(filePath, JSON.stringify(secrets, null, 2) + '\n');
}
