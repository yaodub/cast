/**
 * Session auth routes — plain Express, not tRPC.
 *
 * Localhost-only: no password required. GET auto-issues a token if none present.
 * Bearer tokens keep the API contract stable for when remote auth is added later.
 * Sessions persist to `CONFIG_DIR/admin-sessions.json` and survive restart;
 * DELETE invalidates a token. See `admin/trpc.ts` for storage details.
 */
import { Router } from 'express';
import type { Router as RouterType } from 'express';

import { createSession, deleteSession, isValidSession, extractToken } from './trpc.js';

export const sessionRouter: RouterType = Router(); // Annotation required — TS can't infer portable Router type

/** Check auth status — auto-issue token for localhost callers. */
sessionRouter.get('/', (req, res) => {
  const token = extractToken(req.headers.authorization);
  if (isValidSession(token)) {
    res.json({ authenticated: true });
    return;
  }

  // Auto-issue a session (localhost only, no password gate)
  const newToken = createSession();
  res.json({ authenticated: true, token: newToken });
});

/** Logout — invalidate token. */
sessionRouter.delete('/', (req, res) => {
  const token = extractToken(req.headers.authorization);
  if (token) deleteSession(token);
  res.json({ authenticated: false });
});
