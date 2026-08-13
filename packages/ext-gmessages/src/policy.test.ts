import { describe, it, expect } from 'vitest';

import {
  readDecision,
  canRead,
  canDeliver,
  sendDecision,
  coldSendDecision,
  isPhoneNumber,
} from './policy.js';
import { GmessagesConfigSchema, type GmessagesConfig } from './schemas.js';

function config(overrides: Partial<GmessagesConfig>): GmessagesConfig {
  return GmessagesConfigSchema.parse(overrides);
}

describe('readDecision', () => {
  it('follows the global read_mode when no override exists', () => {
    expect(readDecision(config({ read_mode: 'disabled' }), 'c1')).toBe('block');
    expect(readDecision(config({ read_mode: 'approval' }), 'c1')).toBe('approve');
    expect(readDecision(config({ read_mode: 'open' }), 'c1')).toBe('skip');
  });

  it('lets a per-conversation override win over the global mode', () => {
    const denyOnOpen = config({ read_mode: 'open', chats: { c1: { read: 'deny' } } });
    expect(readDecision(denyOnOpen, 'c1')).toBe('block');
    expect(readDecision(denyOnOpen, 'c2')).toBe('skip'); // untouched threads still follow global

    const allowOnApproval = config({ read_mode: 'approval', chats: { c1: { read: 'allow' } } });
    expect(readDecision(allowOnApproval, 'c1')).toBe('skip');
    expect(readDecision(allowOnApproval, 'c2')).toBe('approve');
  });

  it('canRead is false only when blocked', () => {
    expect(canRead(config({ read_mode: 'disabled' }), 'c1')).toBe(false);
    expect(canRead(config({ read_mode: 'approval' }), 'c1')).toBe(true);
    expect(canRead(config({ read_mode: 'open', chats: { c1: { read: 'deny' } } }), 'c1')).toBe(false);
  });
});

describe('canDeliver (installed watches)', () => {
  it('treats approval mode as permissive — the watch was approved at install', () => {
    // readDecision would say 'approve' here; a fire must not re-prompt.
    expect(readDecision(config({ read_mode: 'approval' }), 'c1')).toBe('approve');
    expect(canDeliver(config({ read_mode: 'approval' }), 'c1')).toBe(true);
  });

  it('still respects an explicit deny and a globally disabled read', () => {
    expect(canDeliver(config({ read_mode: 'approval', chats: { c1: { read: 'deny' } } }), 'c1')).toBe(false);
    expect(canDeliver(config({ read_mode: 'disabled' }), 'c1')).toBe(false);
    // …but an explicit allow beats even a disabled global.
    expect(canDeliver(config({ read_mode: 'disabled', chats: { c1: { read: 'allow' } } }), 'c1')).toBe(true);
  });
});

describe('sendDecision (existing conversation)', () => {
  it('follows the global send_mode, which defaults to disabled', () => {
    expect(sendDecision(config({}), 'c1')).toBe('block');
    expect(sendDecision(config({ send_mode: 'approval' }), 'c1')).toBe('approve');
    expect(sendDecision(config({ send_mode: 'direct' }), 'c1')).toBe('skip');
  });

  it('lets a per-conversation override win within an enabled mode', () => {
    expect(sendDecision(config({ send_mode: 'approval', chats: { c1: { send: 'allow' } } }), 'c1')).toBe('skip');
    expect(sendDecision(config({ send_mode: 'direct', chats: { c1: { send: 'deny' } } }), 'c1')).toBe('block');
  });

  it('treats disabled as a master switch no allowlist can defeat', () => {
    // Asymmetric with reads on purpose: sending ships off, and turning it on is
    // an explicit change of mode — never something an allowlist entry implies.
    expect(sendDecision(config({ send_mode: 'disabled', chats: { c1: { send: 'allow' } } }), 'c1')).toBe('block');
    expect(canDeliver(config({ read_mode: 'disabled', chats: { c1: { read: 'allow' } } }), 'c1')).toBe(true);
  });
});

describe('coldSendDecision — no global mode may silence first contact', () => {
  it('ASKS even under send_mode: direct', () => {
    // The invariant: a typo'd number under 'direct' must not text a stranger
    // silently. Contrast with sendDecision, which skips for existing threads.
    expect(sendDecision(config({ send_mode: 'direct' }), 'c1')).toBe('skip');
    expect(coldSendDecision(config({ send_mode: 'direct' }), '+14155550000')).toBe('approve');
  });

  it('asks under approval, blocks under disabled', () => {
    expect(coldSendDecision(config({ send_mode: 'approval' }), '+14155550000')).toBe('approve');
    expect(coldSendDecision(config({ send_mode: 'disabled' }), '+14155550000')).toBe('block');
  });

  it('honours an explicit contacts entry in both directions', () => {
    const allow = config({ send_mode: 'approval', contacts: { '+14155550000': { send: 'allow' } } });
    expect(coldSendDecision(allow, '+14155550000')).toBe('skip');
    const deny = config({ send_mode: 'direct', contacts: { '+14155550000': { send: 'deny' } } });
    expect(coldSendDecision(deny, '+14155550000')).toBe('block');
  });

  it('a contacts allow does not defeat a disabled global', () => {
    const c = config({ send_mode: 'disabled', contacts: { '+14155550000': { send: 'allow' } } });
    expect(coldSendDecision(c, '+14155550000')).toBe('block');
  });
});

describe('isPhoneNumber', () => {
  it('recognises E.164 and rejects names', () => {
    expect(isPhoneNumber('+14155550000')).toBe(true);
    expect(isPhoneNumber(' +447700900000 ')).toBe(true);
    expect(isPhoneNumber('Alice Chen')).toBe(false);
    expect(isPhoneNumber('(650) 383-8503')).toBe(false); // not E.164 — no bare local forms
    expect(isPhoneNumber('c1')).toBe(false);
  });
});
