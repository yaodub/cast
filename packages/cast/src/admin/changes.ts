/**
 * Server-Sent Events stream at GET /api/changes — signals the admin UI
 * that server-side state (config files) may be stale so cached tRPC
 * query results should be refetched.
 *
 * Payload is intentionally minimal (the revision as both `id` and `data`).
 * The client's reaction is a blanket `queryClient.invalidateQueries()`
 * on every event, so no per-dir or per-file granularity is carried.
 */
import type { Express, Response } from 'express';

import type { FileWatcher } from '../lib/file-watcher.js';
import { logger } from '../logger.js';

import { setSseHeaders, writeSseEvent } from './sse.js';
import { extractToken, isValidSession } from './trpc.js';

/** Mount the SSE handler and subscribe to watcher events. */
export function mountChangesStream(app: Express, watcher: FileWatcher): void {
  const clients = new Set<Response>();

  app.get('/api/changes', (req, res) => {
    const token = extractToken(req.headers.authorization);
    if (!isValidSession(token)) {
      res.status(401).end();
      return;
    }

    setSseHeaders(res);

    // Always-invalidates-on-client ready event. Handles reconnect-after-
    // server-restart correctly without relying on revision comparison.
    if (!writeSseEvent(res, 'ready', watcher.version, watcher.version)) return;

    // Standard SSE catchup: client sends Last-Event-ID on reconnect.
    // If we've moved past it, emit one change event so the client refetches.
    const lastIdHeader = req.headers['last-event-id'];
    const lastId = typeof lastIdHeader === 'string' ? Number(lastIdHeader) : NaN;
    if (!Number.isNaN(lastId) && watcher.version > lastId) {
      if (!writeSseEvent(res, 'change', watcher.version, watcher.version)) return;
    }

    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  // One global subscription — fans out to all connected clients.
  watcher.onAnyChange(() => {
    const rev = watcher.version;
    for (const res of clients) {
      if (!writeSseEvent(res, 'change', rev, rev)) {
        clients.delete(res);
      }
    }
  });

  logger.info('Admin changes stream mounted at /api/changes');
}
