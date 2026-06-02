/**
 * Shared utility functions for the cast server.
 *
 * Small, pure helpers that are used across multiple modules.
 * Keep this file focused — complex domain logic belongs in its own module.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import { z } from 'zod';

import type { AttachmentMeta } from '../types.js';

/** Extract a human-readable message from an unknown error value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run an async step with timing telemetry. Used by the shutdown sequence so
 * supervisor logs reveal which stage is slow when force-kill kicks in.
 *
 * The optional `onStart` runs synchronously before `fn()` so the caller can
 * track which step is in progress for periodic progress logging.
 */
export async function timed<T>(
  label: string,
  fn: () => Promise<T>,
  log: (info: { step: string; elapsedMs: number; ok: boolean }) => void,
  onStart?: (label: string) => void,
): Promise<T> {
  onStart?.(label);
  const t0 = Date.now();
  try {
    const result = await fn();
    log({ step: label, elapsedMs: Date.now() - t0, ok: true });
    return result;
  } catch (err) {
    log({ step: label, elapsedMs: Date.now() - t0, ok: false });
    throw err;
  }
}

/**
 * Format an instant as ISO-8601 with the offset for `tz` (e.g. `2026-04-16T19:30:00-04:00`).
 * Agent-facing timestamps should use this — never raw `toISOString()` which is always UTC.
 * Falls back to the system timezone if `tz` is omitted.
 * Pass `weekday: true` to prefix the weekday name (use only for prominent one-shot surfaces).
 */
export function toZonedIso(
  date: Date,
  tz?: string,
  opts: { weekday?: boolean } = {},
): string {
  const timeZone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'longOffset',
    ...(opts.weekday ? { weekday: 'long' } : {}),
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const hh = get('hour') === '24' ? '00' : get('hour');
  const raw = get('timeZoneName');
  const offset = raw === 'GMT' ? '+00:00' : raw.replace(/^GMT/, '');
  const iso = `${get('year')}-${get('month')}-${get('day')}T${hh}:${get('minute')}:${get('second')}${offset}`;
  return opts.weekday ? `${get('weekday')}, ${iso}` : iso;
}

/**
 * Treat a bare ISO datetime (no `Z`, no offset) as local time in `tz` and return it
 * with the correct offset appended. Iterates to resolve DST edges.
 * Returns null if the string isn't a bare ISO datetime.
 */
export function attachZoneOffset(bareIso: string, tz: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(bareIso)) return null;
  // Initial guess: interpret bare as if it were UTC.
  let guess = new Date(bareIso + 'Z').getTime();
  if (isNaN(guess)) return null;
  for (let i = 0; i < 2; i++) {
    const offset = toZonedIso(new Date(guess), tz).slice(-6);
    const corrected = new Date(bareIso + offset).getTime();
    if (corrected === guess) break;
    guess = corrected;
  }
  return bareIso + toZonedIso(new Date(guess), tz).slice(-6);
}

/** Human-friendly relative time label with day names for recent timestamps. */
export function roughTimeAgo(timestampMs: number): string {
  const delta = Date.now() - timestampMs;
  if (delta < 30 * 60_000) return 'just now';
  if (delta < 2 * 3600_000) return 'about an hour ago';
  if (delta < 12 * 3600_000) return 'a few hours ago';
  if (delta < 24 * 3600_000) return 'earlier today';

  const dayName = new Date(timestampMs).toLocaleDateString('en-US', { weekday: 'long' });
  const daysAgo = Math.floor(delta / 86_400_000);
  if (daysAgo === 1) return `yesterday (${dayName})`;
  if (daysAgo <= 6) return `${daysAgo} days ago (${dayName})`;
  if (daysAgo <= 13) return 'about a week ago';
  return 'a few weeks ago';
}

/** Atomically write a file via temp + rename. Prevents corrupt files on crash. */
export function writeAtomic(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/** Reserved chars in addresses / conversation keys that are unsafe in filesystem paths. */
const PATH_RESERVED_RE = /[%/:@~|]/g;

/**
 * Encode a serialized conversation key for use as a filesystem directory name.
 * Percent-encodes all reserved address characters so the result is a safe path segment.
 */
export function conversationKeyToPath(serializedKey: string): string {
  return serializedKey.replace(PATH_RESERVED_RE, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/** Generate a unique ID with the given prefix (e.g. "task", "cli", "bot"). */
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

const AttachmentMetaSchema = z.array(z.object({
  label: z.string(),
  hash: z.string(),
  mimeType: z.string(),
  size: z.number(),
}));

/** Parse a JSON-encoded attachment metadata array (from DB columns). Returns [] on invalid input. */
export function parseAttachmentMetas(json: string | null): AttachmentMeta[] {
  if (!json) return [];
  try {
    return AttachmentMetaSchema.parse(JSON.parse(json));
  } catch {
    return [];
  }
}

/**
 * Parse + Zod-validate. Returns null on bad JSON or schema mismatch.
 *
 * Use for boundary reads where failure is recoverable (silent skip, fallback,
 * log-and-continue). For trusted inputs that should crash-loud on corruption,
 * inline `schema.parse(JSON.parse(raw))` instead.
 */
export function parseJsonSafe<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
