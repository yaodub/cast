/**
 * Calendar extension schemas — config, secrets, and event types.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Config (operator policy — same for both providers)
// ---------------------------------------------------------------------------

/**
 * Per-agent calendar policy (props/capabilities.json → extensions.calendar).
 *
 * `write_mode` is a ladder — each tier auto-approves a wider class of operations:
 *   - `disabled`: write tools not registered
 *   - `approval`: any write prompts the user
 *   - `personal`: personal writes (no attendees) skip; attendee writes prompt
 *   - `full`: all writes skip
 */
export const CalendarConfigSchema = z.object({
  write_mode: z.enum(['disabled', 'approval', 'personal', 'full']).default('disabled'),
  /** Calendar display names — resolved via PROPFIND at runtime. */
  calendars: z.array(z.string()).default([]),
  /** Pre-resolved CalDAV URLs — bypass PROPFIND (required for Google shared calendars). */
  calendar_urls: z.array(z.string()).default([]),
  view_past: z.string().default('30d'),
  view_future: z.string().default('365d'),
});
export type CalendarConfig = z.infer<typeof CalendarConfigSchema>;

/**
 * Decide approval outcome for a write tool call.
 *
 * Returns 'skip' (execute without prompt), 'approve' (prompt user), or
 * 'block' (hard reject — agent cannot proceed).
 */
export function writeDecision(
  mode: CalendarConfig['write_mode'],
  hasAttendees: boolean,
): 'skip' | 'approve' | 'block' {
  if (mode === 'disabled') return 'block';
  if (mode === 'full') return 'skip';
  if (mode === 'personal') return hasAttendees ? 'approve' : 'skip';
  return 'approve';
}

// ---------------------------------------------------------------------------
// Secrets (discriminated on PROVIDER)
// ---------------------------------------------------------------------------

const GoogleSecretsSchema = z.object({
  PROVIDER: z.literal('google'),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_TOKEN: z.string().min(1),
  GOOGLE_EMAIL: z.string().email(),
});

const CaldavSecretsSchema = z.object({
  PROVIDER: z.literal('caldav'),
  CALDAV_URL: z.string().min(1),
  CALDAV_USERNAME: z.string().min(1),
  CALDAV_PASSWORD: z.string().min(1),
});

export const CalendarSecretsSchema = z.discriminatedUnion('PROVIDER', [
  GoogleSecretsSchema,
  CaldavSecretsSchema,
]);
export type CalendarSecrets = z.infer<typeof CalendarSecretsSchema>;
export type GoogleSecrets = z.infer<typeof GoogleSecretsSchema>;
export type CaldavSecrets = z.infer<typeof CaldavSecretsSchema>;

// ---------------------------------------------------------------------------
// Admin connect state (returned by connect hook for admin UI)
// ---------------------------------------------------------------------------

export const CalendarAdminState = z.object({
  provider: z.enum(['google', 'caldav']),
  calendars: z.array(z.object({
    id: z.string(),
    name: z.string(),
    primary: z.boolean().optional(),
  })),
});
export type CalendarAdminState = z.infer<typeof CalendarAdminState>;

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  uid: string;
  etag: string;
  url: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
  recurrence?: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
}

export interface CreateEventInput {
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
}

export interface ChangeRecord {
  id: string;
  timestamp: string;
  op: 'create' | 'update' | 'delete';
  eventUid: string;
  before?: CalendarEvent;
  after?: CalendarEvent;
}
