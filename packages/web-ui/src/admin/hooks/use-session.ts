import { useState, useEffect } from 'preact/hooks';
import { z } from 'zod';
import { API_BASE } from '../trpc';
import { worker } from '../../lib/worker-client';

const TOKEN_KEY = 'cast_admin_token';

const SessionResponseSchema = z.object({
  authenticated: z.boolean(),
  token: z.string().optional(),
});

/** Get the stored session token. */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** Build Authorization header for fetch calls. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function useSessionCheck() {
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  const check = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/session`, {
        headers: authHeaders(),
      });
      const data = SessionResponseSchema.parse(await res.json());
      // Server auto-issues a token if none present
      if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
      setAuthenticated(data.authenticated);
    } catch {
      setAuthenticated(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { check(); }, []);

  return { authenticated, loading, refresh: check };
}

export async function logout(): Promise<void> {
  // Force-close the admin WS in the worker: the bearer we cached there is
  // about to be invalidated server-side, and we don't want the worker's
  // reconnect loop hammering with a stale token. Chat WS lifetime is
  // refcounted (per-identity); it closes naturally when chat tabs navigate.
  void worker.send({ kind: 'disconnect-admin' }).catch(() => { /* best-effort */ });
  await fetch(`${API_BASE}/api/auth/session`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Force-fetch a fresh session token (no auth header — server auto-issues a new one
 * on localhost). Used to recover from server restart: the cached token is gone
 * from the server's in-memory Map, so every authenticated call returns 401 until
 * we swap in a fresh one.
 */
export async function refreshToken(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/session`);
    const data = SessionResponseSchema.parse(await res.json());
    if (data.token) {
      localStorage.setItem(TOKEN_KEY, data.token);
      return data.token;
    }
  } catch {
    // Network error or schema mismatch — caller handles retry
  }
  return null;
}
