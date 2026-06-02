/**
 * Inbound email authentication verdict.
 *
 * Wraps mailauth.authenticate and reduces its verbose result to a single
 * pass/fail signal plus enough context for log fields when failed.
 *
 * Policy: pass when DMARC explicitly passes, when DKIM is aligned with the
 * From-domain, or when DMARC's alignment-check found a DKIM-aligned signature.
 * SPF alignment alone is not accepted — SPF aligns on the envelope sender,
 * which is independent of the visible From-header that we care about. DMARC's
 * SPF-alignment check folds into the explicit-pass case because mailauth
 * already returns DMARC pass when SPF aligns.
 *
 * `trustReceived: true` lets mailauth extract the connecting IP/HELO/Return-Path
 * from Received headers — required for SPF, since we're an IMAP client and
 * don't have envelope info from the SMTP delivery.
 */
import { authenticate } from 'mailauth';

export interface VerifyResult {
  /** Final verdict — true if any authenticated alignment with the From-domain held. */
  pass: boolean;
  /** Visible From-header domain (lowercased), null if no From header. */
  fromDomain: string | null;
  /** mailauth's overall DMARC verdict ('pass' | 'fail' | 'none' | …), undefined if not run. */
  dmarcStatus: string | undefined;
  /** True if any DKIM signature passes AND aligns with the From-domain. */
  dkimAligned: boolean;
  /** True if SPF passed AND aligns with the From-domain (per DMARC's relaxed alignment). */
  spfAligned: boolean;
  /** Short human-readable reason — useful as a log field when pass=false. */
  reason: string;
}

/**
 * Optional override hook for tests — replaces live DNS with a captured map.
 * Shape matches mailauth's DNSResolver.
 */
export type Resolver = (name: string, type: string) => Promise<unknown>;

export interface VerifyOptions {
  resolver?: Resolver;
}

export async function verifyMessage(raw: Buffer, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const result = await authenticate(raw, {
    trustReceived: true,
    ...(opts.resolver ? { resolver: opts.resolver as never } : {}),
  });

  // mailauth's runtime shapes diverge from its TS types — `aligned` is the alignment-domain
  // string at runtime (typed as boolean), and `alignment.{dkim,spf}.result` is a domain
  // string when aligned, false otherwise.
  const r = result as {
    headers?: { parsed?: Array<{ key: string; value: string }> };
    dkim?: { results?: Array<{ status: { result: string; aligned?: string | boolean; comment?: string } }>; headerFrom?: string[] };
    spf?: { status?: { result: string } };
    dmarc?: {
      status?: { result: string; comment?: string };
      alignment?: { dkim?: { result?: string | false }; spf?: { result?: string | false } };
    } | false;
  };

  const fromHeader = r.dkim?.headerFrom?.[0] ?? null;
  const fromDomain = fromHeader?.includes('@') ? fromHeader.split('@')[1].toLowerCase() : null;

  const dkimResults = r.dkim?.results ?? [];
  const dkimAligned = dkimResults.some((d) => d.status.result === 'pass' && !!d.status.aligned);

  const dmarc = r.dmarc && typeof r.dmarc === 'object' ? r.dmarc : undefined;
  const dmarcStatus = dmarc?.status?.result;
  const dmarcExplicitPass = dmarcStatus === 'pass';
  const dmarcDkimAligned = !!(dmarc?.alignment?.dkim?.result);
  const dmarcSpfAligned = !!(dmarc?.alignment?.spf?.result);

  const pass = dmarcExplicitPass || dkimAligned || dmarcDkimAligned;

  let reason = 'pass';
  if (!pass) {
    if (!fromDomain) reason = 'no From header';
    else if (dmarcStatus === 'fail') reason = `DMARC fail (${dmarc?.status?.comment ?? 'no comment'})`;
    else if (dkimResults.length === 0) reason = 'no DKIM signatures';
    else if (dkimResults.every((d) => d.status.result !== 'pass')) {
      const comments = dkimResults.map((d) => d.status.comment).filter(Boolean).join('; ');
      reason = `DKIM not passing${comments ? ` (${comments})` : ''}`;
    } else {
      reason = 'DKIM passed but not aligned with From';
    }
  }

  return {
    pass,
    fromDomain,
    dmarcStatus,
    dkimAligned: dkimAligned || dmarcDkimAligned,
    spfAligned: dmarcSpfAligned,
    reason,
  };
}
