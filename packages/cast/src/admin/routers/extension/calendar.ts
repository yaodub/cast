/**
 * Calendar extension admin — tRPC router + OAuth redirect routes.
 *
 * tRPC handles config/secrets/discovery. OAuth uses plain Express routes
 * because tRPC can't do HTTP redirects. Both are exported from this file
 * so the calendar admin is a single self-contained artifact.
 */
import crypto from 'crypto';
import fs from 'fs';
import { Router } from 'express';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { agentPath, CAST_PORT } from '../../../config.js';
import type { Bus } from '../../../gateway/bus.js';
import { readSecretsJson, writeSecretsJson } from '../../../lib/secrets-file.js';
import { logger } from '../../../logger.js';
import { adminProcedure, router } from '../../trpc.js';
import {
  aliasToFolder,
  readExtensionConfig,
  writeExtensionConfig,
  maskSecret,
  LockableFieldSchema,
  SecretFieldSchema,
} from './helpers.js';

import { discoverGoogleCalendars } from '@getcast/ext-calendar';
import { CalendarConfigSchema } from '@getcast/ext-calendar/schemas';

import type { Router as RouterType } from 'express';

const EXT_NAME = 'calendar';

/** OAuth state expires if the user doesn't return from Google's consent flow. */
const OAUTH_FLOW_TIMEOUT_MS = 10 * 60 * 1000;

/** All possible secret keys across both providers. */
const SECRET_KEYS = [
  'PROVIDER',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GOOGLE_EMAIL',
  'CALDAV_URL',
  'CALDAV_USERNAME',
  'CALDAV_PASSWORD',
] as const;

const aliasInput = z.object({ alias: z.string() });
const CalendarConfigPartial = CalendarConfigSchema.partial();

// getConfig response contract. Validated on return — a parse failure here
// is a server bug, not a runtime data issue.
const CalendarAdminResponseSchema = z.object({
  secrets: z.record(z.string(), SecretFieldSchema),
  config: z.record(z.string(), LockableFieldSchema(z.unknown())),
  provider: z.string().nullable(),
  oauthRedirectUri: z.string(),
});

// =========================================================================
// tRPC router
// =========================================================================

export const calendarRouter = router({
  getConfig: adminProcedure.input(aliasInput).query(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const secretsPath = agentPath(folder, 'config', 'ext', EXT_NAME, 'secrets.json');
    const rawSecrets = readSecretsJson(secretsPath);
    const secrets: Record<string, { value: string; set: boolean }> = {};
    // Keys that are not sensitive — show full value (public identifiers, URLs, emails)
    const UNMASKED_KEYS: ReadonlySet<string> = new Set([
      'PROVIDER', 'GOOGLE_CLIENT_ID', 'GOOGLE_EMAIL',
      'CALDAV_URL', 'CALDAV_USERNAME',
    ]);
    for (const key of SECRET_KEYS) {
      const raw = rawSecrets[key];
      const val = typeof raw === 'string' ? raw : '';
      if (!val) {
        secrets[key] = { value: '', set: false };
      } else if (UNMASKED_KEYS.has(key)) {
        secrets[key] = { value: val, set: true };
      } else {
        secrets[key] = { value: maskSecret(val), set: true };
      }
    }

    const config = readExtensionConfig(folder, EXT_NAME);
    const providerRaw = rawSecrets['PROVIDER'];
    const provider = typeof providerRaw === 'string' ? providerRaw : null;
    const oauthRedirectUri = `${baseUrl()}/api/oauth/google-calendar/callback`;

    return CalendarAdminResponseSchema.parse({ secrets, config, provider, oauthRedirectUri });
  }),

  setConfig: adminProcedure
    .input(
      z.object({
        alias: z.string(),
        config: CalendarConfigPartial.optional(),
        secrets: z.record(z.string(), z.string()).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      if (input.config) writeExtensionConfig(folder, EXT_NAME, input.config);
      if (input.secrets) {
        const secretsPath = agentPath(folder, 'config', 'ext', EXT_NAME, 'secrets.json');
        fs.mkdirSync(agentPath(folder, 'config', 'ext', EXT_NAME), { recursive: true });
        // Merge with existing keys so partial updates don't wipe out untouched fields
        // (matches the prior writeEnvFile semantics).
        const existing = readSecretsJson(secretsPath);
        writeSecretsJson(secretsPath, { ...existing, ...input.secrets });
      }
      return { ok: true };
    }),

  /**
   * Post-OAuth Google Calendar discovery.
   *
   * After OAuth completes, the refresh token is saved but the connect hook
   * uses it to get an access token. This procedure refreshes the token
   * and calls the Google Calendar REST API to list calendars.
   */
  discoverCalendars: adminProcedure
    .input(aliasInput)
    .mutation(async ({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      const secretsPath = agentPath(folder, 'config', 'ext', EXT_NAME, 'secrets.json');
      const secrets = readSecretsJson(secretsPath);

      if (secrets['PROVIDER'] !== 'google') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'discoverCalendars is only supported for Google provider. Use extension.shared.connect for CalDAV.',
        });
      }

      const clientId = typeof secrets['GOOGLE_CLIENT_ID'] === 'string' ? secrets['GOOGLE_CLIENT_ID'] : '';
      const clientSecret = typeof secrets['GOOGLE_CLIENT_SECRET'] === 'string' ? secrets['GOOGLE_CLIENT_SECRET'] : '';
      const refreshToken = typeof secrets['GOOGLE_REFRESH_TOKEN'] === 'string' ? secrets['GOOGLE_REFRESH_TOKEN'] : '';

      if (!clientId || !clientSecret || !refreshToken) {
        return { ok: false, message: 'Missing Google OAuth credentials. Complete the OAuth flow first.', calendars: [] };
      }

      // Refresh access token
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });

      if (!tokenRes.ok) {
        return { ok: false, message: `Token refresh failed (${tokenRes.status})`, calendars: [] };
      }

      const tokenData = z.object({ access_token: z.string() }).parse(await tokenRes.json());

      try {
        const calendars = await discoverGoogleCalendars(tokenData.access_token);
        return {
          ok: true,
          message: `Found ${calendars.length} calendar(s)`,
          calendars: calendars.map((c) => ({ id: c.id, name: c.name, primary: c.primary })),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        return { ok: false, message: msg, calendars: [] };
      }
    }),
});

// =========================================================================
// OAuth redirect routes (plain Express — tRPC can't do redirects)
// =========================================================================

function baseUrl(): string {
  return process.env.CAST_WEB_BASE_URL || `http://127.0.0.1:${CAST_PORT}`;
}

// Pending flows: random state → { alias, folder, uiOrigin }. One-time use, CSRF protection.
const pendingOAuthFlows = new Map<string, { alias: string; folder: string; uiOrigin: string }>();

export function createCalendarOAuthRouter(deps: { bus: Bus }): RouterType {
  const oauthRouter = Router();

  // /start is a browser redirect — no Bearer token possible.
  oauthRouter.get('/google-calendar/start', (req, res) => {
    const alias = req.query['agent'] as string | undefined;
    if (!alias) {
      res.status(400).json({ error: 'Missing agent query parameter' });
      return;
    }

    let folder: string;
    try {
      folder = aliasToFolder(deps, alias);
    } catch {
      res.status(404).json({ error: `Agent "${alias}" not found` });
      return;
    }

    const secretsPath = agentPath(folder, 'config', 'ext', EXT_NAME, 'secrets.json');
    const secrets = readSecretsJson(secretsPath);
    const clientId = typeof secrets['GOOGLE_CLIENT_ID'] === 'string' ? secrets['GOOGLE_CLIENT_ID'] : '';

    if (!clientId) {
      res.status(400).json({ error: 'GOOGLE_CLIENT_ID not set — save client ID first' });
      return;
    }

    const state = crypto.randomUUID();
    const uiOrigin = req.headers.referer ? new URL(req.headers.referer).origin : '';
    pendingOAuthFlows.set(state, { alias, folder, uiOrigin });
    setTimeout(() => pendingOAuthFlows.delete(state), OAUTH_FLOW_TIMEOUT_MS).unref();

    const redirectUri = `${baseUrl()}/api/oauth/google-calendar/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  oauthRouter.get('/google-calendar/callback', async (req, res) => {
    const code = req.query['code'] as string | undefined;
    const state = req.query['state'] as string | undefined;
    const error = req.query['error'] as string | undefined;

    const flow = state ? pendingOAuthFlows.get(state) : undefined;
    if (state) pendingOAuthFlows.delete(state);
    const alias = flow?.alias;
    const folder = flow?.folder;
    const uiBase = flow?.uiOrigin ?? '';

    if (error) {
      res.redirect(`${uiBase}/admin/agents/${alias ?? ''}/extensions/calendar?oauth=error&message=${encodeURIComponent(error)}`);
      return;
    }

    if (!code || !alias || !folder) {
      res.status(400).json({ error: 'Missing code or state parameter' });
      return;
    }

    const secretsPath = agentPath(folder, 'config', 'ext', EXT_NAME, 'secrets.json');
    const secrets = readSecretsJson(secretsPath);
    const clientId = typeof secrets['GOOGLE_CLIENT_ID'] === 'string' ? secrets['GOOGLE_CLIENT_ID'] : '';
    const clientSecret = typeof secrets['GOOGLE_CLIENT_SECRET'] === 'string' ? secrets['GOOGLE_CLIENT_SECRET'] : '';
    const redirectUri = `${baseUrl()}/api/oauth/google-calendar/callback`;

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        logger.warn({ status: tokenRes.status, text }, 'Google OAuth token exchange failed');
        res.redirect(`${uiBase}/admin/agents/${alias}/extensions/calendar?oauth=error&message=${encodeURIComponent('Token exchange failed')}`);
        return;
      }

      const tokenData = z.object({
        access_token: z.string(),
        refresh_token: z.string().optional(),
        expires_in: z.number(),
      }).parse(await tokenRes.json());

      const updates: Record<string, string> = { PROVIDER: 'google' };
      if (tokenData.refresh_token) {
        updates['GOOGLE_REFRESH_TOKEN'] = tokenData.refresh_token;
      }

      try {
        const infoRes = await fetch(`https://www.googleapis.com/oauth2/v1/userinfo?access_token=${tokenData.access_token}`);
        if (infoRes.ok) {
          const info = z.object({ email: z.string().optional() }).parse(await infoRes.json());
          if (info.email) updates['GOOGLE_EMAIL'] = info.email;
        }
      } catch {
        // Non-fatal — email will need to be entered manually
      }

      fs.mkdirSync(agentPath(folder, 'config', 'ext', EXT_NAME), { recursive: true });
      // Merge with any existing secrets (e.g. an already-saved client_id/client_secret)
      // so the OAuth callback doesn't wipe them when persisting just the refresh token.
      const existing = readSecretsJson(secretsPath);
      writeSecretsJson(secretsPath, { ...existing, ...updates });

      res.redirect(`${uiBase}/admin/agents/${alias}/extensions/calendar?oauth=success`);
    } catch (err) {
      logger.error({ err }, 'Google OAuth callback error');
      res.redirect(`${uiBase}/admin/agents/${alias}/extensions/calendar?oauth=error&message=${encodeURIComponent('Unexpected error')}`);
    }
  });

  return oauthRouter;
}
