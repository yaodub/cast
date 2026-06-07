/**
 * Browser access for service admin pages.
 *
 * The /agents/{folder}/admin/* proxy authenticates API callers via the admin
 * Bearer header, but a browser navigation can't send headers. Instead, the
 * SPA calls `service.adminPageUrl` (authenticated tRPC); the response sets a
 * path-scoped, httpOnly cookie session directly, after which a plain
 * `window.open('/agents/{folder}/admin/')` is authorized. Same-origin
 * authenticated fetches process Set-Cookie, so no credential ever rides a URL.
 *
 * The store is in-memory — a server restart invalidates outstanding sessions,
 * which simply re-runs the (one-click) handoff.
 */
import { randomBytes } from 'crypto';

const SESSION_TTL_MS = 12 * 60 * 60_000;

/** Cookie holding the proxy session (path-scoped per agent by the setter). */
export const SESSION_COOKIE = 'cast_svc_admin';

const sessions = new Map<string, { folder: string; expires: number }>();

function prune(): void {
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if (entry.expires <= now) sessions.delete(key);
  }
}

/** Create a browser session for one agent's admin page; returns the cookie value. */
export function createSession(folder: string): string {
  prune();
  const value = randomBytes(24).toString('base64url');
  sessions.set(value, { folder, expires: Date.now() + SESSION_TTL_MS });
  return value;
}

/** True iff the cookie value names a live session for this folder. */
export function isValidSessionCookie(value: string | undefined, folder: string): boolean {
  if (!value) return false;
  prune();
  const entry = sessions.get(value);
  return entry !== undefined && entry.folder === folder;
}
