/**
 * Service admin page browser access — path-scoped cookie sessions.
 *
 * Both-branches discipline: sessions validate for their bound folder AND
 * reject for other folders, missing values, and unknown values.
 */
import { describe, it, expect } from 'vitest';

import { createSession, isValidSessionCookie } from './service-page-access.js';

describe('cookie sessions', () => {
  it('validates for the bound folder only', () => {
    const value = createSession('agent-a');
    expect(isValidSessionCookie(value, 'agent-a')).toBe(true);
    expect(isValidSessionCookie(value, 'agent-b')).toBe(false);
  });

  it('issues independent sessions per folder', () => {
    const a = createSession('agent-a');
    const b = createSession('agent-b');
    expect(isValidSessionCookie(a, 'agent-a')).toBe(true);
    expect(isValidSessionCookie(b, 'agent-b')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('rejects missing and unknown values', () => {
    expect(isValidSessionCookie(undefined, 'agent-a')).toBe(false);
    expect(isValidSessionCookie('bogus', 'agent-a')).toBe(false);
  });
});
