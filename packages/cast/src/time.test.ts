import { describe, it, expect } from 'vitest';

import { toZonedIso, attachZoneOffset } from './lib/utils.js';

describe('toZonedIso', () => {
  it('renders UTC as +00:00', () => {
    const d = new Date('2026-04-17T03:26:33Z');
    expect(toZonedIso(d, 'UTC')).toBe('2026-04-17T03:26:33+00:00');
  });

  it('renders America/New_York with DST offset in summer', () => {
    const d = new Date('2026-07-15T03:26:33Z');
    expect(toZonedIso(d, 'America/New_York')).toBe('2026-07-14T23:26:33-04:00');
  });

  it('renders America/New_York with standard offset in winter', () => {
    const d = new Date('2026-01-15T03:26:33Z');
    expect(toZonedIso(d, 'America/New_York')).toBe('2026-01-14T22:26:33-05:00');
  });

  it('renders Asia/Tokyo with +09:00', () => {
    const d = new Date('2026-04-17T03:26:33Z');
    expect(toZonedIso(d, 'Asia/Tokyo')).toBe('2026-04-17T12:26:33+09:00');
  });

  it('prefixes weekday when requested', () => {
    const d = new Date('2026-04-17T03:26:33Z');
    expect(toZonedIso(d, 'America/New_York', { weekday: true })).toBe(
      'Thursday, 2026-04-16T23:26:33-04:00',
    );
  });
});

describe('attachZoneOffset', () => {
  it('attaches NYC DST offset in summer', () => {
    expect(attachZoneOffset('2026-07-15T10:00:00', 'America/New_York')).toBe(
      '2026-07-15T10:00:00-04:00',
    );
  });

  it('attaches NYC standard offset in winter', () => {
    expect(attachZoneOffset('2026-01-15T10:00:00', 'America/New_York')).toBe(
      '2026-01-15T10:00:00-05:00',
    );
  });

  it('resolves DST spring-forward correctly', () => {
    // US DST begins 2026-03-08 at 02:00 local (skips to 03:00)
    // 2026-03-08T10:00:00 local in NYC = 14:00 UTC — offset is -04:00 (EDT)
    const result = attachZoneOffset('2026-03-08T10:00:00', 'America/New_York');
    expect(result).toBe('2026-03-08T10:00:00-04:00');
    // Verify: parsing back gives the right UTC moment
    expect(new Date(result!).toISOString()).toBe('2026-03-08T14:00:00.000Z');
  });

  it('attaches UTC offset as +00:00', () => {
    expect(attachZoneOffset('2026-04-17T10:00:00', 'UTC')).toBe(
      '2026-04-17T10:00:00+00:00',
    );
  });

  it('returns null for malformed input', () => {
    expect(attachZoneOffset('not a date', 'America/New_York')).toBeNull();
  });

  it('round-trips with toZonedIso', () => {
    const attached = attachZoneOffset('2026-06-15T14:30:00', 'Europe/London');
    expect(attached).toBe('2026-06-15T14:30:00+01:00');
    expect(toZonedIso(new Date(attached!), 'Europe/London')).toBe(
      '2026-06-15T14:30:00+01:00',
    );
  });
});
