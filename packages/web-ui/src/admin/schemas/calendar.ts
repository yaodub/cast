/**
 * Calendar extension form schema + transformer.
 *
 * Provider-conditional (google | caldav). Google uses calendar_urls (CalDAV
 * URLs with embedded IDs); CalDAV uses calendars (display names). Transformer
 * writes only the active provider's secrets.
 */
import type { inferRouterOutputs } from '@trpc/server';
import { z } from 'zod';

import type { AppRouter } from '@getcast/server/admin';

export const CalendarFormSchema = z.object({
  provider: z.enum(['google', 'caldav']),
  googleClientId: z.string(),
  googleClientSecret: z.string(),
  googleEmail: z.string(),
  caldavUrl: z.string(),
  caldavUsername: z.string(),
  caldavPassword: z.string(),
  writeMode: z.enum(['disabled', 'approval', 'personal', 'full']),
  calendars: z.array(z.string()),
  viewPast: z.string(),
  viewFuture: z.string(),
});

export type CalendarFormValues = z.infer<typeof CalendarFormSchema>;

export type CalendarServerData = inferRouterOutputs<AppRouter>['extension']['calendar']['getConfig'];

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function calendarFormInitialValues(data: CalendarServerData): CalendarFormValues {
  const { config, secrets, provider } = data;

  // Google uses calendar_urls; extract IDs back out.
  let calendars: string[] = [];
  const calUrls = asStringArray(config['calendar_urls']?.value);
  if (calUrls.length > 0) {
    calendars = calUrls.map((url) => {
      const m = url.match(/caldav\/v2\/([^/]+)\/events/);
      return m?.[1] ? decodeURIComponent(m[1]) : url;
    });
  } else {
    calendars = asStringArray(config['calendars']?.value);
  }

  const writeModeRaw = String(config['write_mode']?.value ?? 'disabled');
  const writeMode: CalendarFormValues['writeMode'] =
    writeModeRaw === 'approval' || writeModeRaw === 'personal' || writeModeRaw === 'full'
      ? writeModeRaw
      : 'disabled';

  const providerNarrowed: CalendarFormValues['provider'] = provider === 'caldav' ? 'caldav' : 'google';

  return {
    provider: providerNarrowed,
    googleClientId: secrets['GOOGLE_CLIENT_ID']?.set ? secrets['GOOGLE_CLIENT_ID'].value : '',
    googleClientSecret: '',
    googleEmail: secrets['GOOGLE_EMAIL']?.set ? secrets['GOOGLE_EMAIL'].value : '',
    caldavUrl: secrets['CALDAV_URL']?.set ? secrets['CALDAV_URL'].value : '',
    caldavUsername: secrets['CALDAV_USERNAME']?.set ? secrets['CALDAV_USERNAME'].value : '',
    caldavPassword: '',
    writeMode,
    calendars,
    viewPast: String(config['view_past']?.value ?? '30d'),
    viewFuture: String(config['view_future']?.value ?? '365d'),
  };
}

export function calendarFormToPayload(
  alias: string,
  v: CalendarFormValues,
  data: CalendarServerData,
): { alias: string; config?: Record<string, unknown>; secrets?: Record<string, string> } {
  const config = data.config;
  const secretUpdates: Record<string, string> = {};

  if (v.provider === 'google') {
    secretUpdates['PROVIDER'] = 'google';
    if (v.googleClientId) secretUpdates['GOOGLE_CLIENT_ID'] = v.googleClientId;
    if (v.googleClientSecret) secretUpdates['GOOGLE_CLIENT_SECRET'] = v.googleClientSecret;
    if (v.googleEmail) secretUpdates['GOOGLE_EMAIL'] = v.googleEmail;
  } else {
    secretUpdates['PROVIDER'] = 'caldav';
    if (v.caldavUrl) secretUpdates['CALDAV_URL'] = v.caldavUrl;
    if (v.caldavUsername) secretUpdates['CALDAV_USERNAME'] = v.caldavUsername;
    if (v.caldavPassword) secretUpdates['CALDAV_PASSWORD'] = v.caldavPassword;
  }

  const configUpdates: Record<string, unknown> = {};
  if (!config['write_mode']?.locked) configUpdates['write_mode'] = v.writeMode;
  if (!config['view_past']?.locked) configUpdates['view_past'] = v.viewPast;
  if (!config['view_future']?.locked) configUpdates['view_future'] = v.viewFuture;

  if (v.provider === 'google' && v.calendars.length > 0) {
    if (!config['calendar_urls']?.locked) {
      configUpdates['calendar_urls'] = v.calendars.map((id) =>
        `https://apidata.googleusercontent.com/caldav/v2/${encodeURIComponent(id)}/events/`
      );
    }
    if (!config['calendars']?.locked) configUpdates['calendars'] = [];
  } else {
    if (!config['calendars']?.locked) configUpdates['calendars'] = v.calendars;
    if (!config['calendar_urls']?.locked) configUpdates['calendar_urls'] = [];
  }

  return {
    alias,
    config: Object.keys(configUpdates).length > 0 ? configUpdates : undefined,
    secrets: Object.keys(secretUpdates).length > 0 ? secretUpdates : undefined,
  };
}
