import { describe, it, expect } from 'vitest';

import { parseApprovalCommand } from './approval-command.js';

describe('parseApprovalCommand', () => {
  it('parses /approve <id> as a once decision', () => {
    expect(parseApprovalCommand('/approve req-123')).toEqual({
      decision: 'approved', id: 'req-123', tier: 'once', reason: undefined,
    });
  });

  it('parses the always keyword into tier (the bit web/CLI used to drop)', () => {
    expect(parseApprovalCommand('/approve req-123 always')).toEqual({
      decision: 'approved', id: 'req-123', tier: 'always', reason: undefined,
    });
  });

  it('parses /reject with a trailing reason', () => {
    expect(parseApprovalCommand('/reject req-9 too risky to run')).toEqual({
      decision: 'rejected', id: 'req-9', tier: 'once', reason: 'too risky to run',
    });
  });

  it('parses /reject <id> always <reason>', () => {
    expect(parseApprovalCommand('/reject req-9 always not this peer')).toEqual({
      decision: 'rejected', id: 'req-9', tier: 'always', reason: 'not this peer',
    });
  });

  it('does not treat a reason merely starting with "always…" as the tier', () => {
    expect(parseApprovalCommand('/reject req-9 alwaysish concern')).toEqual({
      decision: 'rejected', id: 'req-9', tier: 'once', reason: 'alwaysish concern',
    });
  });

  it('is case-insensitive on the verb and keyword', () => {
    expect(parseApprovalCommand('/APPROVE req-1 ALWAYS')).toEqual({
      decision: 'approved', id: 'req-1', tier: 'always', reason: undefined,
    });
  });

  it('returns null for non-approval text', () => {
    expect(parseApprovalCommand('hello there')).toBeNull();
    expect(parseApprovalCommand('/approve')).toBeNull();      // no id
    expect(parseApprovalCommand('approve req-1')).toBeNull(); // no slash
  });
});
