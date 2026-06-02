/**
 * Tiny SSE helpers — shared by `admin/changes.ts` and `admin/chat.ts`.
 *
 * Two concerns: setting the standard SSE headers on first write, and
 * formatting individual events safely (catch broken-pipe errors so callers
 * can drop the connection without crashing the process).
 */
import type { Response } from 'express';

export function setSseHeaders(res: Response): void {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
}

/**
 * Write one SSE event. `data` is JSON-stringified unless it's already a string.
 * Returns false if the socket is dead (EPIPE etc.) so callers can prune.
 */
export function writeSseEvent(
  res: Response,
  event: string,
  data: unknown,
  id?: string | number,
): boolean {
  try {
    const lines = [`event: ${event}`];
    if (id !== undefined) lines.push(`id: ${id}`);
    lines.push(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    res.write(lines.join('\n') + '\n\n');
    return true;
  } catch {
    return false;
  }
}
