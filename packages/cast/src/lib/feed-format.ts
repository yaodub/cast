/**
 * Standard JSONL feed format for `file__append_feed` and `file__watch_feed`.
 *
 * A *feed* is an ordered, append-only JSONL stream that peers observe via
 * `file__watch_feed`. Each row is `{id, data, meta?}` — `id` is framework-assigned
 * monotonic int (starts at 1); `data` and `meta` are nested opaque values the
 * agent provides. Framework owns only `id`.
 *
 * This is a coordination primitive, NOT a journal/audit-log format. For
 * journaling (replay, retrospect, diary), use Edit/Write to append plain JSONL.
 *
 * Append semantics — best-effort, not transactional:
 * - No host-side per-path lock. Two concurrent appends can both observe `last id = N` and
 *   both write `id = N+1`, breaking monotonicity. Caught by the corruption check on next read.
 * - `fs.appendFileSync` is OS-atomic for writes under PIPE_BUF (~4KB on Darwin/Linux); larger
 *   rows could interleave. Acceptable for typical coordination rows.
 *
 * Corruption rule (fail closed for both append and read):
 * - Each non-empty trimmed line must JSON.parse to an object with `id: number` >= 1.
 * - Ids must be strictly monotonically increasing across the file.
 * - Empty file is valid (next append starts at id=1).
 * - Blank lines (whitespace only) are skipped, not treated as corruption.
 *
 * Self-write suppression hook: after a successful append, `feedAppendEvents` emits an
 * `'append'` event with `{hostPath, convKey, id}`. The watch service subscribes
 * to advance the per-conv-key cursor in the registry so the writer's own conv-key
 * doesn't re-deliver its own row.
 */
import fs from 'fs';
import { EventEmitter } from 'events';

export type ValidateResult =
  | { ok: true; lastId: number }
  | { ok: false; kind: 'corrupt'; rowOffset: number; reason: string };

export type AppendResult =
  | { ok: true; id: number }
  | { ok: false; kind: 'corrupt'; rowOffset: number; reason: string };

export interface FeedRow {
  id: number;
  data: unknown;
  meta?: unknown;
}

export type ReadRowsResult =
  | { ok: true; rows: FeedRow[] }
  | { ok: false; kind: 'corrupt'; rowOffset: number; reason: string };

export interface FeedAppendEvent {
  hostPath: string;
  convKey: string;
  id: number;
}

/**
 * Singleton event emitter for `file__append_feed` events. The watch service
 * subscribes to advance per-conv-key cursors so writers don't re-deliver
 * their own rows.
 */
class FeedAppendEventEmitter extends EventEmitter {
  emit(event: 'append', payload: FeedAppendEvent): boolean {
    return super.emit(event, payload);
  }
  on(event: 'append', listener: (payload: FeedAppendEvent) => void): this {
    return super.on(event, listener);
  }
  off(event: 'append', listener: (payload: FeedAppendEvent) => void): this {
    return super.off(event, listener);
  }
}

export const feedAppendEvents = new FeedAppendEventEmitter();

/**
 * Parse a feed file into typed rows, validating integrity along the way. ENOENT
 * is treated as an empty feed (no rows). Shared core for `validateFeedIntegrity`
 * (which only needs `lastId`) and `readFeedRows` (fire-assembly consumer).
 */
function parseFeedFile(hostPath: string): ReadRowsResult {
  let raw: string;
  try {
    raw = fs.readFileSync(hostPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, rows: [] };
    }
    throw err;
  }

  const lines = raw.split('\n');
  const rows: FeedRow[] = [];
  let lastId = 0;
  for (let offset = 0; offset < lines.length; offset++) {
    const line = lines[offset]!.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, kind: 'corrupt', rowOffset: offset, reason: 'JSON parse failed' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, kind: 'corrupt', rowOffset: offset, reason: 'Row is not an object' };
    }
    const obj = parsed as Record<string, unknown>;
    const id = obj.id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
      return { ok: false, kind: 'corrupt', rowOffset: offset, reason: 'Missing or invalid id (must be integer >= 1)' };
    }
    if (id <= lastId) {
      return { ok: false, kind: 'corrupt', rowOffset: offset, reason: `Non-monotonic id: ${id} <= ${lastId}` };
    }
    lastId = id;
    const row: FeedRow = { id, data: obj.data };
    if (obj.meta !== undefined) row.meta = obj.meta;
    rows.push(row);
  }
  return { ok: true, rows };
}

/**
 * Read a feed file and validate its integrity. Returns the highest `id` on success
 * or the first row offset that fails validation. ENOENT is treated as a valid
 * empty feed (lastId: 0) — first append starts at id=1.
 */
export function validateFeedIntegrity(hostPath: string): ValidateResult {
  const result = parseFeedFile(hostPath);
  if (!result.ok) return result;
  return { ok: true, lastId: result.rows.at(-1)?.id ?? 0 };
}

/**
 * Read all rows from a feed file with corruption detection. Returns the parsed
 * rows on success or fail-closed reason if any row is malformed (same invariant
 * as `validateFeedIntegrity`). Used by the watch service for fire assembly.
 */
export function readFeedRows(hostPath: string): ReadRowsResult {
  return parseFeedFile(hostPath);
}

/**
 * Append a row to a feed file. Validates the existing file for corruption first;
 * fails closed if any row is malformed. Assigns `id = lastId + 1`. Creates the
 * file if it doesn't exist (the first append starts at id=1).
 *
 * Side effect on success: emits `feedAppendEvents.emit('append', {hostPath, convKey, id})`.
 * `convKey` is required so the cursor-advance subscriber in the watch service can
 * scope to the writing conv-key.
 */
export function appendFeedRow(
  hostPath: string,
  convKey: string,
  data: unknown,
  meta?: unknown,
): AppendResult {
  const validation = validateFeedIntegrity(hostPath);
  if (!validation.ok) return validation;

  const id = validation.lastId + 1;
  const row: Record<string, unknown> = { id, data };
  if (meta !== undefined) row.meta = meta;
  const line = JSON.stringify(row) + '\n';

  fs.appendFileSync(hostPath, line);
  feedAppendEvents.emit('append', { hostPath, convKey, id });
  return { ok: true, id };
}
