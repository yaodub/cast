import { describe, it, expect } from 'vitest';

import { parseChannelString, CHANNEL_NAME_RE } from './conversations/parse-channel.js';

describe('parseChannelString', () => {
  describe('bare channel name', () => {
    it('accepts a valid lowercase-letter-start name', () => {
      const r = parseChannelString('finance');
      expect(r).toEqual({ ok: true, parsed: { channel: 'finance' } });
    });

    it('accepts hyphens and digits after the first letter', () => {
      const r = parseChannelString('peer-1-review');
      expect(r).toEqual({ ok: true, parsed: { channel: 'peer-1-review' } });
    });

    it('rejects uppercase', () => {
      const r = parseChannelString('Finance');
      expect(r.ok).toBe(false);
    });

    it('rejects leading digit', () => {
      const r = parseChannelString('1finance');
      expect(r.ok).toBe(false);
    });

    it('rejects empty string', () => {
      const r = parseChannelString('');
      expect(r.ok).toBe(false);
    });

    it('rejects leading hyphen', () => {
      const r = parseChannelString('-finance');
      expect(r.ok).toBe(false);
    });
  });

  describe('composite name~qualifier', () => {
    it('accepts a valid composite', () => {
      const r = parseChannelString('finance~daily');
      expect(r).toEqual({ ok: true, parsed: { channel: 'finance', qualifier: 'daily' } });
    });

    it('accepts hyphenated qualifier', () => {
      const r = parseChannelString('finance~daily-standup');
      expect(r).toEqual({ ok: true, parsed: { channel: 'finance', qualifier: 'daily-standup' } });
    });

    it('rejects invalid base', () => {
      const r = parseChannelString('Finance~daily');
      expect(r.ok).toBe(false);
    });

    it('rejects invalid qualifier (uppercase)', () => {
      const r = parseChannelString('finance~Daily');
      expect(r.ok).toBe(false);
    });

    it('rejects invalid qualifier (leading digit)', () => {
      const r = parseChannelString('finance~1daily');
      expect(r.ok).toBe(false);
    });

    it('rejects multiple `~` (qualifier cannot contain `~`)', () => {
      const r = parseChannelString('finance~daily~draft');
      expect(r.ok).toBe(false);
    });

    it('rejects empty qualifier (trailing `~`)', () => {
      const r = parseChannelString('finance~');
      expect(r.ok).toBe(false);
    });

    it('rejects empty channel (leading `~`)', () => {
      const r = parseChannelString('~daily');
      expect(r.ok).toBe(false);
    });
  });

  it('exports the channel-name regex for downstream re-use', () => {
    expect(CHANNEL_NAME_RE.test('valid')).toBe(true);
    expect(CHANNEL_NAME_RE.test('Invalid')).toBe(false);
  });
});
