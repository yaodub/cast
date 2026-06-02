/**
 * Auth router — auth mode status and credential management.
 *
 * `updateCredentials` writes the server's `.env`, re-resolves auth, verifies
 * with a 1-token Claude ping, and hot-reloads the running server. Failures
 * roll the `.env` back to its previous state and return a typed reason so
 * the UI can surface "Claude rejected the API key" / "out of usage" / etc.
 * inline next to the form.
 */
import path from 'path';

import { TRPCError } from '@trpc/server';

import { resolveAuth, type AuthResolution } from '../../auth/auth.js';
import { reloadSecrets } from '../../env.js';
import { readEnvFile, writeEnvFile } from '../../lib/env-file.js';
import { errorMessage } from '../../lib/utils.js';
import { logger } from '../../logger.js';
import { updateCredentialsInput } from '../schemas.js';
import { adminProcedure, router } from '../trpc.js';

function serverEnvPath(): string {
  return path.join(process.cwd(), '.env');
}

const CREDENTIAL_KEYS = ['AUTH_MODE', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

/** Snapshot the credential-relevant subset of the current .env so we can
 *  restore it after a failed verify. We don't snapshot the whole file —
 *  unrelated keys are left untouched, so restoring only the credential keys
 *  keeps the rollback minimal and lossless for everything else. */
function snapshotCredentialEnv(envPath: string): Record<string, string> {
  const current = readEnvFile(envPath);
  const snapshot: Record<string, string> = {};
  for (const key of CREDENTIAL_KEYS) {
    // Preserve "key not set" as empty string so writeEnvFile clears it on
    // rollback (writeEnvFile updates in place; empty string is the explicit
    // "no value" form for dotenv consumers).
    snapshot[key] = current[key] ?? '';
  }
  return snapshot;
}

type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'invalid-credentials' | 'quota-exhausted' | 'claude-unavailable'; message: string };

/** Ping Claude with a 1-token request to verify the credentials work.
 *  Used by `updateCredentials` after a save so the operator finds out at
 *  save time (not at first chat) when a key is wrong. Costs ~1 token. */
async function verifyCredentials(auth: AuthResolution): Promise<VerifyResult> {
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  if (auth.mode === 'api-key') {
    headers['x-api-key'] = auth.secrets.ANTHROPIC_API_KEY;
  } else {
    headers['authorization'] = `Bearer ${auth.secrets.CLAUDE_CODE_OAUTH_TOKEN}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  }

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
  } catch (err) {
    logger.warn({ err: errorMessage(err) }, 'verifyCredentials: network error');
    return { ok: false, reason: 'claude-unavailable', message: 'Could not reach Claude. Check your network and try again.' };
  }

  if (res.ok) return { ok: true };

  if (res.status === 401) {
    return { ok: false, reason: 'invalid-credentials', message: 'Claude rejected the credentials.' };
  }
  if (res.status === 429) {
    return { ok: false, reason: 'quota-exhausted', message: 'Your Claude account is out of usage.' };
  }
  if (res.status >= 500) {
    return { ok: false, reason: 'claude-unavailable', message: 'Claude is currently unavailable. Try again in a few minutes.' };
  }
  return { ok: false, reason: 'invalid-credentials', message: `Claude API returned ${res.status}.` };
}

export const authRouter = router({
  /** Get current auth mode and token status. `mode` is null when Claude is
   *  not configured (UI uses this signal to render the setup modal). */
  getStatus: adminProcedure.query(({ ctx }) => {
    const auth = ctx.deps.getAuth();
    const envVars = readEnvFile(serverEnvPath());
    return {
      mode: auth?.mode ?? null,
      source: auth?.meta.source ?? null,
      expiresAt: auth && 'expiresAt' in auth.meta ? auth.meta.expiresAt : null,
      authMode: envVars['AUTH_MODE'] ?? null,
      hasApiKey: !!envVars['ANTHROPIC_API_KEY'],
      hasOAuthToken: !!envVars['CLAUDE_CODE_OAUTH_TOKEN'],
    };
  }),

  /** Update auth credentials: write .env, re-resolve, ping Claude to verify,
   *  hot-reload the server. On verify failure, rolls back .env and returns a
   *  typed reason for the UI to surface inline. No restart required. */
  updateCredentials: adminProcedure
    .input(updateCredentialsInput)
    .mutation(async ({ input, ctx }) => {
      const envPath = serverEnvPath();
      const previousEnv = snapshotCredentialEnv(envPath);

      const updates: Record<string, string> = { AUTH_MODE: input.authMode };
      if (input.apiKey !== undefined) updates['ANTHROPIC_API_KEY'] = input.apiKey;
      if (input.oauthToken !== undefined) updates['CLAUDE_CODE_OAUTH_TOKEN'] = input.oauthToken;

      const rollback = (): void => {
        writeEnvFile(envPath, previousEnv);
        reloadSecrets();
      };

      writeEnvFile(envPath, updates);
      reloadSecrets();

      let auth: AuthResolution | null;
      try {
        auth = resolveAuth();
      } catch (err) {
        rollback();
        throw new TRPCError({ code: 'BAD_REQUEST', message: errorMessage(err) });
      }

      if (!auth) {
        rollback();
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Credentials are missing or incomplete for the selected auth mode.',
        });
      }

      const verify = await verifyCredentials(auth);
      if (!verify.ok) {
        rollback();
        throw new TRPCError({ code: 'BAD_REQUEST', message: verify.message });
      }

      await ctx.deps.applyAuthChange(auth);
      logger.info({ mode: auth.mode }, 'Credentials updated and hot-reloaded');
      return { ok: true as const };
    }),
});
