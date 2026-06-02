/**
 * Tests for verifyMessage's reduce logic.
 *
 * mailauth's TS types diverge from runtime shapes (`aligned` claims to be
 * boolean but is actually the alignment-domain string; `alignment.{dkim,spf}.result`
 * is similarly a domain string when aligned). These tests pin the reduce
 * behaviour against synthetic mailauth output so future refactors of the
 * shape-narrowing don't quietly regress.
 *
 * mailauth.authenticate is mocked — we don't exercise crypto here. End-to-end
 * verification against real signed mail was validated in the POC.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockAuthenticate: ReturnType<typeof vi.fn>;
vi.mock('mailauth', () => ({
  authenticate: (...args: unknown[]) => mockAuthenticate(...args),
}));

// Import AFTER vi.mock so the module under test sees the stub.
const { verifyMessage } = await import('./verify.js');

beforeEach(() => {
  mockAuthenticate = vi.fn();
});

const fakeMessage = Buffer.from('From: a@b.example\r\n\r\nbody');

describe('verifyMessage reduce', () => {
  it('passes when DMARC explicitly passes', async () => {
    mockAuthenticate.mockResolvedValue({
      dkim: { headerFrom: ['user@example.com'], results: [] },
      spf: { status: { result: 'pass' } },
      dmarc: {
        status: { result: 'pass', comment: 'p=REJECT' },
        alignment: { dkim: { result: 'example.com' }, spf: { result: 'example.com' } },
      },
    });

    const r = await verifyMessage(fakeMessage);
    expect(r.pass).toBe(true);
    expect(r.dmarcStatus).toBe('pass');
    expect(r.fromDomain).toBe('example.com');
    expect(r.reason).toBe('pass');
  });

  it("passes when DKIM is aligned, even though `aligned` field is a domain string", async () => {
    // Runtime shape: aligned holds the alignment-domain string, not a boolean.
    mockAuthenticate.mockResolvedValue({
      dkim: {
        headerFrom: ['user@example.com'],
        results: [{ status: { result: 'pass', aligned: 'example.com' } }],
      },
      spf: { status: { result: 'none' } },
      dmarc: false,
    });

    const r = await verifyMessage(fakeMessage);
    expect(r.pass).toBe(true);
    expect(r.dkimAligned).toBe(true);
  });

  it('fails when DKIM passes but does not align with From', async () => {
    mockAuthenticate.mockResolvedValue({
      dkim: {
        headerFrom: ['user@victim.example'],
        results: [{ status: { result: 'pass', aligned: false } }],
      },
      spf: { status: { result: 'pass' } },
      dmarc: {
        status: { result: 'fail', comment: 'no alignment' },
        alignment: { dkim: { result: false }, spf: { result: false } },
      },
    });

    const r = await verifyMessage(fakeMessage);
    expect(r.pass).toBe(false);
    expect(r.fromDomain).toBe('victim.example');
    expect(r.reason).toMatch(/DMARC fail/);
  });

  it('fails when DKIM signature is "bad signature" (typical From-tampering)', async () => {
    mockAuthenticate.mockResolvedValue({
      dkim: {
        headerFrom: ['attacker@spoofed.example'],
        results: [
          { status: { result: 'fail', aligned: false, comment: 'bad signature' } },
        ],
      },
      spf: { status: { result: 'pass' } },
      dmarc: { status: { result: 'none' }, alignment: undefined },
    });

    const r = await verifyMessage(fakeMessage);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/DKIM not passing.*bad signature/);
  });

  it('fails when there are no DKIM signatures and no DMARC', async () => {
    mockAuthenticate.mockResolvedValue({
      dkim: { headerFrom: ['user@nodkim.example'], results: [] },
      spf: { status: { result: 'none' } },
      dmarc: false,
    });

    const r = await verifyMessage(fakeMessage);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('no DKIM signatures');
  });

  it('passes when alignment.dkim.result is set even if individual DKIM result.aligned is missing', async () => {
    // mailauth populates dmarc.alignment.dkim.result with the aligned domain
    // when relaxed-mode alignment matches via subdomain matching.
    mockAuthenticate.mockResolvedValue({
      dkim: {
        headerFrom: ['user@sub.example.com'],
        results: [{ status: { result: 'pass' } }], // no aligned field
      },
      spf: { status: { result: 'none' } },
      dmarc: {
        status: { result: 'pass' },
        alignment: { dkim: { result: 'example.com' }, spf: { result: false } },
      },
    });

    const r = await verifyMessage(fakeMessage);
    expect(r.pass).toBe(true);
    expect(r.dkimAligned).toBe(true);
  });

  it('passes the resolver option through to mailauth', async () => {
    mockAuthenticate.mockResolvedValue({
      dkim: { headerFrom: [], results: [] },
      spf: { status: { result: 'none' } },
      dmarc: false,
    });
    const resolver = vi.fn();
    await verifyMessage(fakeMessage, { resolver });
    expect(mockAuthenticate).toHaveBeenCalledWith(
      fakeMessage,
      expect.objectContaining({ resolver, trustReceived: true }),
    );
  });
});
