/**
 * iCalendar parsing and building — pure string functions.
 *
 * When an IANA timezone is provided, builds emit
 * `DTSTART;TZID=<tz>:<wallclock>` and parses convert wall-clock + TZID
 * back to a UTC-Z ISO string. Without a timezone, falls back to canonical
 * UTC `YYYYMMDDTHHMMSSZ`. Naive replace-based stripping was the source
 * of a Google CalDAV "+6:40" misparse for negative offsets.
 */
import type { CalendarEvent, CreateEventInput } from './schemas.js';

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

interface WallClock { y: number; M: number; d: number; h: number; m: number; s: number }

/** Wall-clock components for an instant in a given IANA timezone. */
function wallClockInTZ(date: Date, tz: string): WallClock {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  let h = get('hour');
  if (h === 24) h = 0; // some locales emit 24 for midnight
  return { y: get('year'), M: get('month'), d: get('day'), h, m: get('minute'), s: get('second') };
}

/** TZ offset in ms at a given UTC instant: `wallclockUTC(instant) - instant`. */
function tzOffsetMs(instant: Date, tz: string): number {
  const w = wallClockInTZ(instant, tz);
  return Date.UTC(w.y, w.M - 1, w.d, w.h, w.m, w.s) - instant.getTime();
}

/** UTC instant for a wall clock in a given IANA timezone. Two-pass for DST. */
function wallClockToInstant(w: WallClock, tz: string): Date {
  const naive = Date.UTC(w.y, w.M - 1, w.d, w.h, w.m, w.s);
  const off1 = tzOffsetMs(new Date(naive), tz);
  let candidate = naive - off1;
  const off2 = tzOffsetMs(new Date(candidate), tz);
  if (off2 !== off1) candidate = naive - off2;
  return new Date(candidate);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function unfoldIcal(raw: string): string {
  return raw.replace(/\r?\n[ \t]/g, '');
}

interface IcalProp { params: Record<string, string>; value: string }

function getIcalPropFull(lines: string[], prop: string): IcalProp | undefined {
  const prefix = prop.toUpperCase();
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (!upper.startsWith(prefix + ':') && !upper.startsWith(prefix + ';')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) return undefined;
    const head = line.slice(0, colonIdx); // e.g. "DTSTART;TZID=America/New_York"
    const value = line.slice(colonIdx + 1);
    const params: Record<string, string> = {};
    const segs = head.split(';').slice(1); // skip property name
    for (const seg of segs) {
      const eqIdx = seg.indexOf('=');
      if (eqIdx > 0) params[seg.slice(0, eqIdx).toUpperCase()] = seg.slice(eqIdx + 1);
    }
    return { params, value };
  }
  return undefined;
}

function getIcalProp(lines: string[], prop: string): string | undefined {
  return getIcalPropFull(lines, prop)?.value;
}

function getAllIcalProps(lines: string[], prop: string): string[] {
  const prefix = prop.toUpperCase();
  const results: string[] = [];
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith(prefix + ':') || upper.startsWith(prefix + ';')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx >= 0) results.push(line.slice(colonIdx + 1));
    }
  }
  return results;
}

function isAllDay(lines: string[]): boolean {
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith('DTSTART') && upper.includes('VALUE=DATE') && !upper.includes('VALUE=DATE-TIME')) {
      return true;
    }
  }
  return false;
}

/**
 * Convert an iCal date/date-time property to an ISO string.
 *
 * - DATE form `YYYYMMDD` → `YYYY-MM-DD` (all-day).
 * - DATE-TIME with `Z` suffix → `YYYY-MM-DDTHH:MM:SSZ`.
 * - DATE-TIME with TZID param → wall-clock in that TZ → resolved to UTC `Z`.
 * - DATE-TIME floating + `defaultTz` → resolved as wall-clock in defaultTz → UTC `Z`.
 * - DATE-TIME floating without defaultTz → returned naked.
 * - Anything we can't parse → returned verbatim.
 */
function parseIcalDate(prop: IcalProp, defaultTz?: string): string {
  const value = prop.value;
  if (!value) return '';
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return value;

  const w: WallClock = {
    y: Number(m[1]), M: Number(m[2]), d: Number(m[3]),
    h: Number(m[4]), m: Number(m[5]), s: Number(m[6]),
  };
  const isUtc = m[7] === 'Z';

  if (isUtc) {
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  }

  const tz = prop.params.TZID ?? defaultTz;
  if (tz) {
    return wallClockToInstant(w, tz).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  // Floating, no context — preserve as naked ISO so callers see it's offset-less.
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

function parseAttendee(raw: string): string | null {
  const m = raw.match(/mailto:([^\s;]+)/i);
  return m?.[1] ? m[1].toLowerCase() : null;
}

function parseStatus(raw: string | undefined): CalendarEvent['status'] {
  if (!raw) return 'confirmed';
  const upper = raw.toUpperCase().trim();
  if (upper === 'TENTATIVE') return 'tentative';
  if (upper === 'CANCELLED') return 'cancelled';
  return 'confirmed';
}

/** Parse a single VEVENT from raw iCalendar data. */
export function parseVEvent(
  ical: string,
  calendarId: string,
  etag: string,
  url: string,
  defaultTz?: string,
): CalendarEvent | null {
  const unfolded = unfoldIcal(ical);
  const lines = unfolded.split(/\r?\n/);

  const startIdx = lines.findIndex((l) => l.toUpperCase().startsWith('BEGIN:VEVENT'));
  const endIdx = lines.findIndex((l) => l.toUpperCase().startsWith('END:VEVENT'));
  if (startIdx < 0 || endIdx < 0) return null;

  const veventLines = lines.slice(startIdx, endIdx + 1);

  const uid = getIcalProp(veventLines, 'UID');
  if (!uid) return null;

  const summary = getIcalProp(veventLines, 'SUMMARY') ?? '';
  const dtstartProp = getIcalPropFull(veventLines, 'DTSTART');
  const dtendProp = getIcalPropFull(veventLines, 'DTEND') ?? dtstartProp;
  const location = getIcalProp(veventLines, 'LOCATION');
  const description = getIcalProp(veventLines, 'DESCRIPTION')?.replace(/\\n/g, '\n').replace(/\\,/g, ',');
  const rrule = getIcalProp(veventLines, 'RRULE');
  const status = parseStatus(getIcalProp(veventLines, 'STATUS'));

  const attendeeRaws = getAllIcalProps(veventLines, 'ATTENDEE');
  const attendees = attendeeRaws
    .map(parseAttendee)
    .filter((a): a is string => a !== null);

  const empty: IcalProp = { params: {}, value: '' };
  return {
    uid,
    etag,
    url,
    calendarId,
    title: summary.replace(/\\,/g, ',').replace(/\\;/g, ';'),
    start: parseIcalDate(dtstartProp ?? empty, defaultTz),
    end: parseIcalDate(dtendProp ?? empty, defaultTz),
    allDay: isAllDay(veventLines),
    location: location?.replace(/\\,/g, ',').replace(/\\n/g, '\n'),
    description,
    attendees: attendees.length > 0 ? attendees : undefined,
    recurrence: rrule,
    status,
  };
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

function escapeIcalText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function pad2(n: number): string { return n < 10 ? `0${n}` : `${n}`; }

/** Format an ISO date as iCal all-day basic form (`YYYYMMDD`). */
function formatIcalAllDay(iso: string): string {
  return iso.replace(/-/g, '').slice(0, 8);
}

/**
 * Format an ISO date-time as iCal basic form.
 *
 * - With `tz`: wall-clock in `tz`, no Z suffix (caller pairs with `;TZID=`).
 * - Without `tz`: canonical UTC, with Z suffix.
 *
 * Crucially, never naively strips characters from the input — that's
 * what produced the malformed `…1500000400` strings that Google misparsed.
 */
function formatIcalDateTime(iso: string, tz?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO date-time: ${iso}`);
  }
  if (tz) {
    const w = wallClockInTZ(date, tz);
    return `${w.y}${pad2(w.M)}${pad2(w.d)}T${pad2(w.h)}${pad2(w.m)}${pad2(w.s)}`;
  }
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

/** Build an iCalendar VCALENDAR string for a single event. */
export function buildVEvent(uid: string, event: CreateEventInput, tz?: string): string {
  const allDay = event.allDay ?? false;
  const dtstart = allDay
    ? `DTSTART;VALUE=DATE:${formatIcalAllDay(event.start)}`
    : tz
      ? `DTSTART;TZID=${tz}:${formatIcalDateTime(event.start, tz)}`
      : `DTSTART:${formatIcalDateTime(event.start)}`;
  const dtend = allDay
    ? `DTEND;VALUE=DATE:${formatIcalAllDay(event.end)}`
    : tz
      ? `DTEND;TZID=${tz}:${formatIcalDateTime(event.end, tz)}`
      : `DTEND:${formatIcalDateTime(event.end)}`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//cast//calendar//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    dtstart,
    dtend,
    `SUMMARY:${escapeIcalText(event.title)}`,
  ];

  if (event.location) lines.push(`LOCATION:${escapeIcalText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcalText(event.description)}`);
  if (event.attendees) {
    for (const email of event.attendees) {
      lines.push(`ATTENDEE;RSVP=TRUE:mailto:${email}`);
    }
  }

  lines.push('STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}
