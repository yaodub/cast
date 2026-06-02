/**
 * OAuth 2.0 authorization code flow — wraps simple-oauth2.
 *
 * Provider-agnostic: endpoints and scopes are config. Provider presets
 * (GOOGLE_ENDPOINTS) are convenience constants, not required.
 *
 * Same export surface as the previous hand-rolled implementation.
 */
import { AuthorizationCode } from 'simple-oauth2';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schemas (source of truth for types)
// ---------------------------------------------------------------------------

export const OAuthConfigSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  tokenEndpoint: z.string().url(),
  authEndpoint: z.string().url(),
  redirectUri: z.string().url(),
  scopes: z.array(z.string()),
});
export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;

export const OAuthTokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
  token_type: z.string(),
});
export type OAuthTokens = z.infer<typeof OAuthTokensSchema>;

// ---------------------------------------------------------------------------
// Provider presets
// ---------------------------------------------------------------------------

export const GOOGLE_ENDPOINTS = {
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
} as const;

// ---------------------------------------------------------------------------
// Internal: build simple-oauth2 client from our config
// ---------------------------------------------------------------------------

function createClient(config: OAuthConfig): AuthorizationCode {
  const tokenUrl = new URL(config.tokenEndpoint);
  const authUrl = new URL(config.authEndpoint);

  return new AuthorizationCode({
    client: {
      id: config.clientId,
      secret: config.clientSecret,
    },
    auth: {
      tokenHost: tokenUrl.origin,
      tokenPath: tokenUrl.pathname,
      authorizeHost: authUrl.origin,
      authorizePath: authUrl.pathname,
    },
    options: {
      authorizationMethod: 'body',
    },
  });
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/** Build the consent URL for the OAuth authorization code flow. */
export function buildConsentUrl(
  config: OAuthConfig,
  opts: { state: string },
): string {
  const client = createClient(config);
  return client.authorizeURL({
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    state: opts.state,
    access_type: 'offline',
    prompt: 'consent',
  } as Record<string, unknown>);
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode(
  config: OAuthConfig,
  code: string,
): Promise<OAuthTokens> {
  const client = createClient(config);
  const accessToken = await client.getToken({
    code,
    redirect_uri: config.redirectUri,
    scope: config.scopes,
  });

  return OAuthTokensSchema.parse(accessToken.token);
}

/** Refresh an access token using a refresh token. */
export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<OAuthTokens> {
  const client = createClient(config);
  const token = client.createToken({
    access_token: '',
    refresh_token: refreshToken,
    expires_in: 0,
    token_type: 'Bearer',
  });

  const refreshed = await token.refresh();
  return OAuthTokensSchema.parse(refreshed.token);
}
