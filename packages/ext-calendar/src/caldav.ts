/**
 * CalDAV client — wraps tsdav for calendar CRUD operations.
 *
 * Ported from cast-stdlib/capabilities/calendar/functions.ts.
 * Key difference: auth supports a getAccessToken() closure for
 * lazy OAuth token refresh (Google provider).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DAVClient } from 'tsdav';
import type { DAVCalendar, DAVCalendarObject } from 'tsdav';

import type { Logger } from '@getcast/extension-schema';
import type { CalendarEvent, CreateEventInput, ChangeRecord, CalendarConfig } from './schemas.js';
import { parseVEvent, buildVEvent } from './ical.js';

// ---------------------------------------------------------------------------
// Auth types
// ---------------------------------------------------------------------------

export type CalendarAuth =
  | { method: 'basic'; username: string; password: string }
  | { method: 'bearer'; username: string; getAccessToken: () => Promise<string> };

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

export interface CalendarClientOpts {
  serverUrl: string;
  auth: CalendarAuth;
  config: CalendarConfig;
  changelogPath: string;
  log: Logger;
  /** Agent IANA timezone (e.g. "America/New_York"). Empty/undefined → emit UTC. */
  timezone?: string;
}

// ---------------------------------------------------------------------------
// CalendarClient
// ---------------------------------------------------------------------------

export class CalendarClient {
  private opts: CalendarClientOpts;
  private resolvedCalendars: DAVCalendar[] | null = null;

  constructor(opts: CalendarClientOpts) {
    this.opts = opts;
  }

  // -------------------------------------------------------------------------
  // Internal — DAV connection
  // -------------------------------------------------------------------------

  private async connect(): Promise<DAVClient> {
    const { auth, serverUrl } = this.opts;

    const client = auth.method === 'basic'
      ? new DAVClient({
          serverUrl,
          credentials: { username: auth.username, password: auth.password },
          authMethod: 'Basic',
          defaultAccountType: 'caldav',
        })
      : new DAVClient({
          serverUrl,
          credentials: { username: auth.username, accessToken: await auth.getAccessToken() },
          authMethod: 'Bearer',
          defaultAccountType: 'caldav',
        });

    await client.login();
    return client;
  }

  // -------------------------------------------------------------------------
  // Internal — calendar resolution (cached)
  // -------------------------------------------------------------------------

  private async resolveCalendars(client: DAVClient): Promise<DAVCalendar[]> {
    if (this.resolvedCalendars) return this.resolvedCalendars;

    const { config } = this.opts;

    // Pre-resolved URLs bypass PROPFIND
    if (config.calendar_urls.length > 0) {
      this.resolvedCalendars = config.calendar_urls.map((url) => ({ url }) as DAVCalendar);
      return this.resolvedCalendars;
    }

    if (config.calendars.length === 0) {
      this.resolvedCalendars = [];
      return this.resolvedCalendars;
    }

    const all = await client.fetchCalendars();
    const wanted = new Set(config.calendars);
    this.resolvedCalendars = all.filter((c) => {
      const name = typeof c.displayName === 'string' ? c.displayName : '';
      return wanted.has(name) || wanted.has(c.url);
    });

    return this.resolvedCalendars;
  }

  // -------------------------------------------------------------------------
  // Internal — view window
  // -------------------------------------------------------------------------

  private resolveViewWindow(): { start: string; end: string } {
    const now = Date.now();
    return {
      start: new Date(now - parseDuration(this.opts.config.view_past)).toISOString(),
      end: new Date(now + parseDuration(this.opts.config.view_future)).toISOString(),
    };
  }

  private clampTimeRange(opts?: { after?: string; before?: string }): { start: string; end: string } {
    const window = this.resolveViewWindow();
    const start = opts?.after && opts.after > window.start ? opts.after : window.start;
    const end = opts?.before && opts.before < window.end ? opts.before : window.end;
    return { start, end };
  }

  // -------------------------------------------------------------------------
  // Internal — policy enforcement
  // -------------------------------------------------------------------------

  private assertWritable(): void {
    if (this.opts.config.write_mode === 'disabled') {
      throw new Error('Calendar writes are disabled (write_mode: disabled)');
    }
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  async listEvents(opts?: { after?: string; before?: string; calendarId?: string }): Promise<CalendarEvent[]> {
    const client = await this.connect();
    const calendars = await this.resolveCalendars(client);
    const timeRange = this.clampTimeRange(opts);
    const events: CalendarEvent[] = [];

    for (const cal of calendars) {
      if (opts?.calendarId && cal.url !== opts.calendarId) continue;

      const objects = await client.fetchCalendarObjects({ calendar: cal, timeRange });
      const calName = typeof cal.displayName === 'string' ? cal.displayName : cal.url;

      for (const obj of objects) {
        if (!obj.data) continue;
        const parsed = parseVEvent(obj.data, calName, obj.etag ?? '', obj.url, this.opts.timezone);
        if (parsed) events.push(parsed);
      }
    }

    events.sort((a, b) => a.start.localeCompare(b.start));
    return events;
  }

  async getEvent(uid: string): Promise<CalendarEvent | null> {
    const all = await this.listEvents();
    return all.find((e) => e.uid === uid) ?? null;
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  async createEvent(event: CreateEventInput): Promise<{ event: CalendarEvent; change: ChangeRecord }> {
    this.assertWritable();

    const client = await this.connect();
    const calendars = await this.resolveCalendars(client);
    if (calendars.length === 0) throw new Error('No matching calendars found');

    const calendar = calendars[0]!;
    const uid = crypto.randomUUID();
    const filename = `${uid}.ics`;
    const ical = buildVEvent(uid, event, this.opts.timezone);

    await client.createCalendarObject({ calendar, iCalString: ical, filename });

    const calName = typeof calendar.displayName === 'string' ? calendar.displayName : calendar.url;
    const created: CalendarEvent = {
      uid,
      etag: '',
      url: `${calendar.url}${filename}`,
      calendarId: calName,
      title: event.title,
      start: event.start,
      end: event.end,
      allDay: event.allDay ?? false,
      location: event.location,
      description: event.description,
      attendees: event.attendees,
      status: 'confirmed',
    };

    try {
      const fetched = await client.fetchCalendarObjects({
        calendar,
        objectUrls: [created.url],
      });
      if (fetched[0]?.etag) created.etag = fetched[0].etag;
    } catch { /* best-effort etag fetch */ }

    const change: ChangeRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      op: 'create',
      eventUid: uid,
      after: created,
    };

    return { event: created, change };
  }

  async updateEvent(uid: string, fields: Partial<CreateEventInput>): Promise<{ event: CalendarEvent; change: ChangeRecord }> {
    this.assertWritable();

    const before = await this.getEvent(uid);
    if (!before) throw new Error(`Event not found: ${uid}`);

    const merged: CreateEventInput = {
      title: fields.title ?? before.title,
      start: fields.start ?? before.start,
      end: fields.end ?? before.end,
      allDay: fields.allDay ?? before.allDay,
      location: fields.location ?? before.location,
      description: fields.description ?? before.description,
      attendees: fields.attendees ?? before.attendees,
    };

    const ical = buildVEvent(uid, merged, this.opts.timezone);
    const calObject: DAVCalendarObject = { url: before.url, etag: before.etag, data: ical };

    const client = await this.connect();
    await client.updateCalendarObject({ calendarObject: calObject });

    const after: CalendarEvent = { ...before, ...merged, allDay: merged.allDay ?? false };
    const change: ChangeRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      op: 'update',
      eventUid: uid,
      before,
      after,
    };

    return { event: after, change };
  }

  async deleteEvent(uid: string): Promise<{ change: ChangeRecord }> {
    this.assertWritable();

    const before = await this.getEvent(uid);
    if (!before) throw new Error(`Event not found: ${uid}`);

    const calObject: DAVCalendarObject = { url: before.url, etag: before.etag };
    const client = await this.connect();
    await client.deleteCalendarObject({ calendarObject: calObject });

    const change: ChangeRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      op: 'delete',
      eventUid: uid,
      before,
    };

    return { change };
  }
}

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

export function appendChange(changelogPath: string, change: ChangeRecord): void {
  const dir = path.dirname(changelogPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(changelogPath, JSON.stringify(change) + '\n');
}

export function listChanges(changelogPath: string, limit?: number): ChangeRecord[] {
  if (!fs.existsSync(changelogPath)) return [];
  const content = fs.readFileSync(changelogPath, 'utf-8').trim();
  if (!content) return [];

  const lines = content.split('\n');
  const max = limit ?? 50;
  const recent = lines.slice(-max);

  const results: ChangeRecord[] = [];
  for (const line of recent) {
    try { results.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatEvents(events: CalendarEvent[]): string {
  if (events.length === 0) return 'No events found.';
  return events
    .map((e) => {
      const time = e.allDay ? `${e.start} (all day)` : `${e.start} — ${e.end}`;
      const parts = [`UID: ${e.uid}`, `Title: ${e.title}`, `Time: ${time}`];
      if (e.location) parts.push(`Location: ${e.location}`);
      if (e.description) parts.push(`Description: ${e.description}`);
      if (e.attendees && e.attendees.length > 0) parts.push(`Attendees: ${e.attendees.join(', ')}`);
      if (e.recurrence) parts.push(`Recurrence: ${e.recurrence}`);
      if (e.status !== 'confirmed') parts.push(`Status: ${e.status}`);
      return parts.join('\n');
    })
    .join('\n\n');
}

export function formatChanges(changes: ChangeRecord[]): string {
  if (changes.length === 0) return 'No changes recorded.';
  return changes
    .map((c) => {
      const parts = [`[${c.timestamp}] ${c.op.toUpperCase()} — ${c.eventUid}`];
      if (c.before) parts.push(`  Before: ${c.before.title} (${c.before.start})`);
      if (c.after) parts.push(`  After: ${c.after.title} (${c.after.start})`);
      return parts.join('\n');
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDuration(d: string): number {
  const m = d.match(/^(\d+)(d|w|m|y)$/);
  if (!m?.[1] || !m[2]) throw new Error(`Invalid duration: ${d}`);
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 'd': return n * 86400000;
    case 'w': return n * 7 * 86400000;
    case 'm': return n * 30 * 86400000;
    case 'y': return n * 365 * 86400000;
    default: throw new Error(`Invalid duration unit: ${m[2]}`);
  }
}
