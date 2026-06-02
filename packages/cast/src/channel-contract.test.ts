/**
 * Truth-table coverage for channel-contract derivation and renderers.
 *
 * Pure module — no fs or bus mocking. We assert two things:
 *   1. `deriveChannelContract(bits)` produces the expected typed shape for
 *      every interesting bit combination.
 *   2. Each renderer produces consistent output across that truth table —
 *      stable snapshots are the chokepoint that catches drift if either
 *      the deriver or a renderer is edited without updating the other.
 *
 * Both-branches discipline: empty-bits, free-text-only, every
 * structured-only mode, every mixed-with-freetext mode, and full-bits all
 * exercised — not just the happy path.
 */
import { describe, it, expect } from 'vitest';

import {
  deriveChannelContract,
  renderContractForPrompt,
  renderContractForRejection,
  renderContractForPeerListing,
} from './auth/channel-contract.js';

// Every bit combination of practical interest. We don't enumerate the full
// 2^7 = 128 power set because most combinations are operationally
// nonsensical (e.g. `qhp` — agent can query but also accepts pushes?). The
// covered set is what an operator would plausibly write or what cast-org
// uses today, plus pathological edges (empty, no-outbound-but-structured,
// outbound + push, etc.).
const COVERED_BITS = [
  '',                     // no access
  'i', 'o', 'a', 'q', 'r', 'p', 'h',  // each bit alone
  'io',                   // typical user channel
  'a',                    // peer answerer (market-intelligence pattern)
  'q',                    // peer querier
  'r',                    // fire-and-forget sender (spec'd, no real users)
  'qa', 'qr', 'ra', 'qra', // mixed structured
  'oqra',                 // free-text + full structured
  'ph',                   // push pair
  'ioaqrph',              // all bits (owner/local equivalent)
] as const;

describe('deriveChannelContract', () => {
  it('reads each bit independently into the typed shape', () => {
    expect(deriveChannelContract('o').send.freeText).toBe(true);
    expect(deriveChannelContract('o').send.query).toBe(false);
    expect(deriveChannelContract('i').receive.freeText).toBe(true);
    expect(deriveChannelContract('a').receive.structuredInbound).toBe(true);
    expect(deriveChannelContract('q').send.query).toBe(true);
    expect(deriveChannelContract('r').send.request).toBe(true);
    expect(deriveChannelContract('p').send.push).toBe(true);
    expect(deriveChannelContract('h').receive.push).toBe(true);
  });

  it('handles empty bits as fully-denied contract', () => {
    const c = deriveChannelContract('');
    expect(c).toEqual({
      send: { freeText: false, query: false, request: false, push: false },
      receive: { freeText: false, structuredInbound: false, push: false },
    });
  });

  it('handles full-bits as fully-granted contract', () => {
    const c = deriveChannelContract('ioaqrph');
    expect(c).toEqual({
      send: { freeText: true, query: true, request: true, push: true },
      receive: { freeText: true, structuredInbound: true, push: true },
    });
  });

  it('ignores unknown characters in the bit string', () => {
    // Defensive: future bits or whitespace should not flip existing flags.
    const c = deriveChannelContract('o x z ');
    expect(c.send.freeText).toBe(true);
    expect(c.send.query).toBe(false);
  });
});

describe('renderContractForPrompt', () => {
  it('returns null on default-mode `io` channel (no structured, free-text on)', () => {
    expect(renderContractForPrompt(deriveChannelContract('io'))).toBeNull();
  });

  it('returns null on `o`-only (free-text, no inbound, no structured)', () => {
    expect(renderContractForPrompt(deriveChannelContract('o'))).toBeNull();
  });

  it('returns null on empty bits (locked-out channel — prompt cannot help)', () => {
    expect(renderContractForPrompt(deriveChannelContract(''))).toBeNull();
  });

  it('teaches envelope-only mode on `a`-only (peer answerer — MI pattern)', () => {
    const out = renderContractForPrompt(deriveChannelContract('a'));
    expect(out).not.toBeNull();
    expect(out).toContain('does not deliver free-form');
    expect(out).toContain('<cast:answer');
    expect(out).toContain('<cast:internal>');
    expect(out).toContain('fire-and-forget');
  });

  it('teaches outbound query on `q`-only', () => {
    const out = renderContractForPrompt(deriveChannelContract('q'));
    expect(out).not.toBeNull();
    // Mentions cast:query as the emit envelope (and may reference cast:answer
    // as the expected reply — that's context, not an emit instruction).
    expect(out).toContain('cast:query target=');
    expect(out).not.toContain('cast:request');
    expect(out).not.toContain('answer request=');
  });

  it('teaches outbound request on `r`-only', () => {
    const out = renderContractForPrompt(deriveChannelContract('r'));
    expect(out).not.toBeNull();
    expect(out).toContain('cast:request target=');
    expect(out).toContain('fire-and-forget');
    expect(out).not.toContain('cast:query target=');
    expect(out).not.toContain('answer request=');
  });

  it('teaches all three envelopes on `qra`', () => {
    const out = renderContractForPrompt(deriveChannelContract('qra'));
    expect(out).not.toBeNull();
    expect(out).toContain('<cast:answer');
    expect(out).toContain('<cast:query');
    expect(out).toContain('<cast:request');
  });

  it('mentions free-text + envelopes when `o` is combined with structured', () => {
    const out = renderContractForPrompt(deriveChannelContract('oqra'));
    expect(out).not.toBeNull();
    expect(out).toContain('Free-form conversation');
    expect(out).toContain('<cast:query');
  });
});

describe('renderContractForRejection', () => {
  it('names the addressee-deliverable envelopes when some exist', () => {
    const out = renderContractForRejection(deriveChannelContract('a'));
    expect(out).toContain('<cast:answer');
    expect(out).toContain('Do not retry');
    expect(out).toContain('<cast:internal>');
  });

  it('special-cases fully-denied channels', () => {
    const out = renderContractForRejection(deriveChannelContract(''));
    expect(out).toContain('delivers nothing');
    expect(out).toContain('Do not retry');
  });

  it('lists multiple envelopes when several are permitted', () => {
    const out = renderContractForRejection(deriveChannelContract('qra'));
    expect(out).toContain('<cast:answer');
    expect(out).toContain('<cast:query');
    expect(out).toContain('<cast:request');
  });
});

describe('renderContractForPeerListing', () => {
  it('returns an empty list for fully-denied channel', () => {
    expect(renderContractForPeerListing(deriveChannelContract(''))).toEqual([]);
  });

  it('describes both directions when bidirectional', () => {
    const lines = renderContractForPeerListing(deriveChannelContract('io'));
    expect(lines).toContain('you can message');
    expect(lines).toContain('they can message you');
  });

  it('separates query / request / answer roles', () => {
    const lines = renderContractForPeerListing(deriveChannelContract('qra'));
    expect(lines).toContain('you can query');
    expect(lines).toContain('you can fire fire-and-forget requests');
    expect(lines).toContain('they can query you');
  });

  it('renders push pair', () => {
    const lines = renderContractForPeerListing(deriveChannelContract('ph'));
    expect(lines).toContain('you can push');
    expect(lines).toContain('they can push to you');
  });
});

describe('truth-table snapshots', () => {
  // Snapshot every (bits, renderer) cell. Any wording change surfaces in
  // review; any derivation/rendering drift becomes visible at once.
  for (const bits of COVERED_BITS) {
    it(`bits="${bits}" produces stable output`, () => {
      const c = deriveChannelContract(bits);
      expect({
        contract: c,
        prompt: renderContractForPrompt(c),
        rejection: renderContractForRejection(c),
        peerListing: renderContractForPeerListing(c),
      }).toMatchSnapshot();
    });
  }
});
