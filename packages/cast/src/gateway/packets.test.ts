import { describe, it, expect } from 'vitest';

import { approvalAckPkt } from './packets.js';

// The ack carries the effective tier so the rendered label reads as the action
// taken — "Always approved" / "Always rejected" when a standing grant/tombstone
// was written, plain "Approved" / "Rejected" for a one-shot.
describe('approvalAckPkt — tier-aware label', () => {
  const base = ['a:agent@srv', 'u:owner@srv', 'appr-1'] as const;

  it('prefixes "Always" on an always-approved decision', () => {
    const pkt = approvalAckPkt(...base, 'approved', 'reach secrets-holder', undefined, 'always');
    expect(pkt.tier).toBe('always');
    expect(pkt.text).toBe('Always approved: reach secrets-holder');
  });

  it('prefixes "Always" on an always-rejected decision', () => {
    const pkt = approvalAckPkt(...base, 'rejected', 'reach secrets-holder', undefined, 'always');
    expect(pkt.text).toBe('Always rejected: reach secrets-holder');
  });

  it('plain "Approved" for a once tier', () => {
    const pkt = approvalAckPkt(...base, 'approved', 'reach secrets-holder', undefined, 'once');
    expect(pkt.tier).toBe('once');
    expect(pkt.text).toBe('Approved: reach secrets-holder');
  });

  it('plain "Approved" when tier is absent (non-tiered approval)', () => {
    const pkt = approvalAckPkt(...base, 'approved', 'reach secrets-holder');
    expect(pkt.tier).toBeUndefined();
    expect(pkt.text).toBe('Approved: reach secrets-holder');
  });

  it('never prefixes "Always" on an expired ack', () => {
    const pkt = approvalAckPkt(...base, 'expired', 'reach secrets-holder', undefined, 'always');
    expect(pkt.text).toBe('Expired: reach secrets-holder');
  });
});
