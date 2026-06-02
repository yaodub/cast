import { z } from 'zod';

import { readCredentials } from '../lib/claude-credentials.js';
import { secrets } from '../env.js';
import { logger } from '../logger.js';

// --- Types ---

const AuthModeSchema = z.enum(['api-key', 'setup-token']);
export type AuthMode = z.infer<typeof AuthModeSchema>;

type ApiKeyAuth = {
  mode: 'api-key';
  secrets: { ANTHROPIC_API_KEY: string };
  meta: { source: '.env' };
};

type SetupTokenAuth = {
  mode: 'setup-token';
  secrets: { CLAUDE_CODE_OAUTH_TOKEN: string };
  meta: { source: '.env' | 'credentials-file'; expiresAt?: number };
};

export type AuthResolution = ApiKeyAuth | SetupTokenAuth;

// --- Constants ---

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// --- Validation helpers ---

function resolveApiKey(env: Record<string, string | undefined>): ApiKeyAuth | null {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (key.startsWith('sk-ant-oat01-')) {
    throw new Error('AUTH_MODE=api-key but ANTHROPIC_API_KEY looks like an OAuth token (sk-ant-oat01- prefix). Use setup-token mode instead.');
  }
  return { mode: 'api-key', secrets: { ANTHROPIC_API_KEY: key }, meta: { source: '.env' } };
}

function resolveSetupToken(env: Record<string, string | undefined>): SetupTokenAuth | null {
  // Prefer .env token
  const envToken = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) {
    return { mode: 'setup-token', secrets: { CLAUDE_CODE_OAUTH_TOKEN: envToken }, meta: { source: '.env' } };
  }

  // Fall back to credentials file (single read for atomicity)
  const creds = readCredentials();
  if (!creds) return null;

  const remaining = creds.expiresAt - Date.now();
  if (remaining < SEVEN_DAYS_MS) {
    throw new Error(
      `AUTH_MODE=setup-token but token expires in ${Math.round(remaining / 86_400_000)}d — generate a new one with \`claude setup-token\``,
    );
  }
  if (remaining < THIRTY_DAYS_MS) {
    logger.warn(
      { expiresIn: `${Math.round(remaining / 86_400_000)}d` },
      'Setup token expires soon — consider regenerating with `claude setup-token`',
    );
  }

  return {
    mode: 'setup-token',
    secrets: { CLAUDE_CODE_OAUTH_TOKEN: creds.token },
    meta: { source: 'credentials-file', expiresAt: creds.expiresAt },
  };
}

// --- Public API ---

/** Resolve auth mode. Returns `null` when AUTH_MODE is unset or its required
 *  secret is missing (fresh install or partial config — server boots into a
 *  "Claude not configured" state, operator finishes setup via the dashboard).
 *  Throws on validation errors (malformed values, expired tokens) — callers
 *  can catch and surface the specific problem (boot wraps in try/catch and
 *  degrades to null; the save path surfaces the message inline). */
export function resolveAuth(): AuthResolution | null {
  const declaredMode = secrets.AUTH_MODE;
  if (!declaredMode) return null;

  const parsed = AuthModeSchema.safeParse(declaredMode);
  if (!parsed.success) {
    throw new Error(`Invalid AUTH_MODE="${declaredMode}". Must be one of: api-key, setup-token`);
  }

  switch (parsed.data) {
    case 'api-key': return resolveApiKey(secrets);
    case 'setup-token': return resolveSetupToken(secrets);
  }
}

/** Return the secrets needed to spawn an agent for the given auth resolution.
 *  Today both supported modes are static (key or token come straight from
 *  resolution); this indirection exists so credential rotation can grow
 *  without touching call sites. */
export async function refreshSecrets(auth: AuthResolution): Promise<Record<string, string>> {
  return auth.secrets;
}

/** Log auth resolution at startup. Null means Claude is not configured. */
export function logAuthResolution(auth: AuthResolution | null): void {
  if (!auth) {
    logger.warn('Claude is not configured — server is running without Claude credentials. Set them up in the server dashboard (Settings > Model Access) or by setting AUTH_MODE and the matching secret in .env.');
    return;
  }
  switch (auth.mode) {
    case 'api-key':
      logger.info('Auth mode: api-key — using ANTHROPIC_API_KEY from .env');
      break;
    case 'setup-token': {
      const expiry = auth.meta.expiresAt
        ? `, expires ${new Date(auth.meta.expiresAt).toISOString().slice(0, 10)}`
        : '';
      logger.info(`Auth mode: setup-token — source: ${auth.meta.source}${expiry}`);
      break;
    }
  }
}
