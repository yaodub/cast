import { describe, it, expect } from 'vitest';
import { buildVEvent, parseVEvent } from './ical.js';

describe('buildVEvent — UTC fallback (no agent timezone)', () => {
  it('emits canonical Z form for UTC inputs', () => {
    const ical = buildVEvent('uid-1', {
      title: 'Meeting',
      start: '2026-05-15T15:00:00Z',
      end: '2026-05-15T16:00:00Z',
    });
    expect(ical).toContain('DTSTART:20260515T150000Z');
    expect(ical).toContain('DTEND:20260515T160000Z');
  });

  it('canonicalizes negative-offset inputs to UTC (no string mangling)', () => {
    // Regression: pre-fix this produced `DTSTART:20260515T1500000400`,
    // which Google misparsed as 15:06:40.
    const ical = buildVEvent('uid-2', {
      title: 'Meeting',
      start: '2026-05-15T15:00:00-04:00',
      end: '2026-05-15T16:00:00-04:00',
    });
    expect(ical).toContain('DTSTART:20260515T190000Z');
    expect(ical).toContain('DTEND:20260515T200000Z');
    expect(ical).not.toContain('1500000400');
  });
});

describe('buildVEvent — TZID emission (agent timezone set)', () => {
  it('emits floating wall-clock + TZID for an offset that matches the TZ', () => {
    // 15:00 -04:00 == 15:00 wall-clock in NY (during EDT)
    const ical = buildVEvent(
      'uid-3',
      {
        title: 'Meeting',
        start: '2026-05-15T15:00:00-04:00',
        end: '2026-05-15T16:00:00-04:00',
      },
      'America/New_York',
    );
    expect(ical).toContain('DTSTART;TZID=America/New_York:20260515T150000');
    expect(ical).toContain('DTEND;TZID=America/New_York:20260515T160000');
  });

  it('converts UTC input to wall-clock in agent TZ', () => {
    // 19:00Z == 15:00 NY (EDT)
    const ical = buildVEvent(
      'uid-4',
      {
        title: 'Meeting',
        start: '2026-05-15T19:00:00Z',
        end: '2026-05-15T20:00:00Z',
      },
      'America/New_York',
    );
    expect(ical).toContain('DTSTART;TZID=America/New_York:20260515T150000');
    expect(ical).toContain('DTEND;TZID=America/New_York:20260515T160000');
  });

  it('converts a foreign-offset input to the agent TZ wall-clock', () => {
    // 23:30 IST = 18:00Z = 14:00 NY (EDT)
    const ical = buildVEvent(
      'uid-5',
      {
        title: 'Meeting',
        start: '2026-05-15T23:30:00+05:30',
        end: '2026-05-16T00:30:00+05:30',
      },
      'America/New_York',
    );
    expect(ical).toContain('DTSTART;TZID=America/New_York:20260515T140000');
    expect(ical).toContain('DTEND;TZID=America/New_York:20260515T150000');
  });

  it('all-day events ignore TZID', () => {
    const ical = buildVEvent(
      'uid-6',
      {
        title: 'Holiday',
        start: '2026-07-04',
        end: '2026-07-05',
        allDay: true,
      },
      'America/New_York',
    );
    expect(ical).toContain('DTSTART;VALUE=DATE:20260704');
    expect(ical).toContain('DTEND;VALUE=DATE:20260705');
    expect(ical).not.toContain('TZID=America/New_York');
  });
});

describe('parseVEvent — TZID consumption', () => {
  function veventOf(dtstart: string, dtend: string): string {
    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:test-uid',
      'SUMMARY:Test',
      dtstart,
      dtend,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
  }

  it('Z form round-trips to ISO with Z', () => {
    const e = parseVEvent(
      veventOf('DTSTART:20260515T150000Z', 'DTEND:20260515T160000Z'),
      'cal', 'etag', 'url',
    );
    expect(e?.start).toBe('2026-05-15T15:00:00Z');
    expect(e?.end).toBe('2026-05-15T16:00:00Z');
  });

  it('TZID + wall-clock resolves to UTC instant', () => {
    const e = parseVEvent(
      veventOf(
        'DTSTART;TZID=America/New_York:20260515T150000',
        'DTEND;TZID=America/New_York:20260515T160000',
      ),
      'cal', 'etag', 'url',
    );
    expect(e?.start).toBe('2026-05-15T19:00:00Z'); // EDT, UTC-4
    expect(e?.end).toBe('2026-05-15T20:00:00Z');
  });

  it('floating + defaultTz resolves as that TZ', () => {
    const e = parseVEvent(
      veventOf('DTSTART:20260515T150000', 'DTEND:20260515T160000'),
      'cal', 'etag', 'url',
      'America/New_York',
    );
    expect(e?.start).toBe('2026-05-15T19:00:00Z');
  });

  it('all-day stays as YYYY-MM-DD', () => {
    const e = parseVEvent(
      veventOf('DTSTART;VALUE=DATE:20260704', 'DTEND;VALUE=DATE:20260705'),
      'cal', 'etag', 'url',
      'America/New_York',
    );
    expect(e?.start).toBe('2026-07-04');
    expect(e?.allDay).toBe(true);
  });

  it('write→read round-trip preserves the instant (TZID path)', () => {
    const ical = buildVEvent(
      'uid-rt',
      {
        title: 'Meeting',
        start: '2026-05-15T15:00:00-04:00',
        end: '2026-05-15T16:00:00-04:00',
      },
      'America/New_York',
    );
    const e = parseVEvent(ical, 'cal', 'etag', 'url', 'America/New_York');
    expect(e?.start).toBe('2026-05-15T19:00:00Z');
    expect(e?.end).toBe('2026-05-15T20:00:00Z');
  });
});
