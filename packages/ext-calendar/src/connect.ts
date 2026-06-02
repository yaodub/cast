/**
 * Calendar extension — admin connect hook.
 *
 * Authenticates and discovers available calendars for the configured provider.
 * Receives parsed `CalendarSecrets` from the cast admin layer; storage format
 * (`secrets.json`) is the server's concern, not this extension's.
 */
import { CalendarAdminState, type CalendarSecrets, type GoogleSecrets, type CaldavSecrets } from './schemas.js';
import { discoverGoogleCalendars } from './google.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

type ConnectResult = {
  ok: boolean;
  message: string;
  state?: unknown;
};

export async function connect(ctx: { secrets: CalendarSecrets; privateDir: string }): Promise<ConnectResult> {
  try {
    if (ctx.secrets.PROVIDER === 'google') return connectGoogle(ctx.secrets);
    return connectCaldav(ctx.secrets);
  } catch (err) {
    return { ok: false, message: `Connection failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function connectGoogle(secrets: GoogleSecrets): Promise<ConnectResult> {
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: secrets.GOOGLE_CLIENT_ID,
      client_secret: secrets.GOOGLE_CLIENT_SECRET,
      refresh_token: secrets.GOOGLE_REFRESH_TOKEN,
    }),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    return { ok: false, message: `Google token refresh failed (${tokenRes.status}): ${text}` };
  }
  const tokenData = (await tokenRes.json()) as { access_token: string };
  const calendars = await discoverGoogleCalendars(tokenData.access_token);
  const state = CalendarAdminState.parse({
    provider: 'google',
    calendars: calendars.map((c) => ({ id: c.id, name: c.name, primary: c.primary })),
  });
  return { ok: true, message: `Connected. Found ${calendars.length} calendar(s).`, state };
}

async function connectCaldav(secrets: CaldavSecrets): Promise<ConnectResult> {
  const { DAVClient } = await import('tsdav');
  const client = new DAVClient({
    serverUrl: secrets.CALDAV_URL,
    credentials: { username: secrets.CALDAV_USERNAME, password: secrets.CALDAV_PASSWORD },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
  await client.login();
  const calendars = await client.fetchCalendars();
  const state = CalendarAdminState.parse({
    provider: 'caldav',
    calendars: calendars.map((cal) => ({
      id: cal.url,
      name: typeof cal.displayName === 'string' ? cal.displayName : cal.url,
    })),
  });
  return { ok: true, message: `Connected. Found ${calendars.length} calendar(s).`, state };
}
