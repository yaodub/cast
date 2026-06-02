/**
 * Google-specific utilities — token refresh and calendar discovery.
 *
 * Token refresh is an inline fetch (no simple-oauth2 dependency).
 * Discovery uses the Google Calendar REST API because CalDAV PROPFIND
 * does not return shared calendars on Google.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import type { Logger } from '@getcast/extension-schema';

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REFRESH_MARGIN_MS = 60_000;

const CredentialsSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.number(),
});

export interface GoogleTokenRefresher {
  getAccessToken(): Promise<string>;
}

export function createGoogleTokenRefresher(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  privateDir: string;
  log: Logger;
}): GoogleTokenRefresher {
  const credPath = path.join(opts.privateDir, 'credentials.json');
  let cached: { accessToken: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  // Load cached credentials
  try {
    const raw = fs.readFileSync(credPath, 'utf-8');
    const parsed = CredentialsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) cached = parsed.data;
  } catch { /* no cached credentials */ }

  async function refresh(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      refresh_token: opts.refreshToken,
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google token refresh failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    cached = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    // Persist for next startup
    try {
      fs.mkdirSync(path.dirname(credPath), { recursive: true });
      fs.writeFileSync(credPath, JSON.stringify(cached));
    } catch (err) {
      opts.log.warn({ err }, 'Failed to persist Google credentials');
    }

    return cached.accessToken;
  }

  return {
    async getAccessToken(): Promise<string> {
      if (cached && cached.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
        return cached.accessToken;
      }
      // Single-flight: reuse in-flight refresh
      if (!inflight) {
        inflight = refresh().finally(() => { inflight = null; });
      }
      return inflight;
    },
  };
}

// ---------------------------------------------------------------------------
// Calendar discovery (REST API)
// ---------------------------------------------------------------------------

const CalendarListSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    summary: z.string().optional(),
    primary: z.boolean().optional(),
  })).optional(),
});

/** Discovered calendar entry from Google Calendar API. */
export interface GoogleCalendarEntry {
  id: string;
  name: string;
  primary: boolean;
}

/**
 * Discover all visible calendars via the Google Calendar REST API.
 *
 * Returns owned and shared calendars — unlike CalDAV PROPFIND which
 * only returns owned calendars on Google.
 */
export async function discoverGoogleCalendars(
  accessToken: string,
): Promise<GoogleCalendarEntry[]> {
  const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Calendar discovery failed (${res.status}): ${text}`);
  }

  const data = CalendarListSchema.parse(await res.json());
  const items = data.items ?? [];

  return items.map((item) => ({
    id: item.id,
    name: item.summary ?? item.id,
    primary: item.primary ?? false,
  }));
}
