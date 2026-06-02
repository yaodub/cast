/**
 * Token manager — lifecycle management for OAuth access tokens.
 *
 * Handles lazy refresh, single-flight concurrency, and state transitions.
 * Tree-shakeable: only imported by services that need OAuth.
 */
// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type TokenState =
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; refreshToken: string; cached: null }
  | { status: 'authenticated'; refreshToken: string; cached: { accessToken: string; expiresAt: number } };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TokenManagerOpts {
  /** Initial refresh token (from credentials.json). Undefined → unauthenticated. */
  refreshToken: string | undefined;
  /** Function to refresh the access token using a refresh token. */
  refreshFn: (refreshToken: string) => Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
  /** Called after a successful refresh — persist the new tokens. */
  onTokenUpdate: (entry: { refreshToken: string; accessToken: string; expiresAt: number }) => void;
}

export interface TokenManager {
  /** Get a valid access token. Lazy-refreshes if expired. Throws if unauthenticated. */
  getAccessToken(): Promise<string>;
  /** Whether the manager has a refresh token. */
  isAuthenticated(): boolean;
  /** Set the refresh token (from OAuth callback). Transitions unauthenticated → authenticated. */
  setCredentials(refreshToken: string): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Buffer before expiry to avoid using a token that's about to expire. */
const EXPIRY_BUFFER_MS = 60_000;

export function createTokenManager(opts: TokenManagerOpts): TokenManager {
  let state: TokenState = opts.refreshToken
    ? { status: 'authenticated', refreshToken: opts.refreshToken, cached: null }
    : { status: 'unauthenticated' };

  /** Single-flight: if a refresh is in progress, reuse the same promise. */
  let inflightRefresh: Promise<string> | null = null;

  async function doRefresh(refreshToken: string): Promise<string> {
    const tokens = await opts.refreshFn(refreshToken);
    const expiresAt = Date.now() + tokens.expires_in * 1000;
    const effectiveRefreshToken = tokens.refresh_token ?? refreshToken;

    state = {
      status: 'authenticated',
      refreshToken: effectiveRefreshToken,
      cached: { accessToken: tokens.access_token, expiresAt },
    };

    opts.onTokenUpdate({
      refreshToken: effectiveRefreshToken,
      accessToken: tokens.access_token,
      expiresAt,
    });

    return tokens.access_token;
  }

  return {
    async getAccessToken(): Promise<string> {
      if (state.status === 'unauthenticated') {
        throw new Error('Not authenticated — complete OAuth flow first');
      }

      // Return cached token if still valid
      if (state.cached && state.cached.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
        return state.cached.accessToken;
      }

      // Single-flight refresh
      if (inflightRefresh) return inflightRefresh;

      inflightRefresh = doRefresh(state.refreshToken).finally(() => {
        inflightRefresh = null;
      });

      return inflightRefresh;
    },

    isAuthenticated(): boolean {
      return state.status === 'authenticated';
    },

    setCredentials(refreshToken: string): void {
      state = { status: 'authenticated', refreshToken, cached: null };
    },
  };
}
