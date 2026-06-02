/**
 * Auto-responder detection — RFC 3834 + common vendor signals.
 *
 * Inbound chokepoint: `EmailWatcher.pollEntry()` consults this on every
 * fetched message and drops anything that self-identifies as auto-generated
 * (OOO replies, ticketing autoresponders, mailing-list traffic). Breaks the
 * classic loop where the agent replies to an OOO and the OOO replies back.
 *
 * Outbound counterpart: `sendEmail()` stamps cast-authored mail with
 * `Auto-Submitted: auto-replied|auto-generated (cast-agent)`. The two halves
 * compose: a second cast instance receiving cast's reply sees the stamp and
 * its inbound chokepoint catches it. Same defense holds against any
 * RFC-3834-compliant correspondent.
 *
 * Returns the matching reason string (suitable for logging) or `undefined`
 * for human-authored mail. The shape is "string-or-undefined" rather than
 * `{isAuto, reason?}` so the caller can pattern-match with `if (reason)`.
 */
import type { ParsedMail } from 'mailparser';

/** Precedence values that suppress replies. `bulk` and `junk` are the
 *  pre-RFC-3834 vintage; `list` covers mailing lists; `auto_reply` /
 *  `auto-reply` are vendor variants. */
const PRECEDENCE_AUTO = new Set(['bulk', 'junk', 'list', 'auto_reply', 'auto-reply']);

/** Vendor-specific headers that uniformly mean "I am an autoresponder."
 *  Presence alone is the signal — value is irrelevant. */
const VENDOR_AUTO_HEADERS = ['x-autoreply', 'x-autorespond', 'x-auto-response-suppress'] as const;

export function detectAutoResponder(headers: ParsedMail['headers']): string | undefined {
  // Auto-Submitted (RFC 3834). Any value other than 'no' indicates the
  // message was generated automatically. The header may carry a parenthesized
  // comment (e.g. `auto-replied (server.example.com)`); we strip that and
  // compare on the bare keyword.
  const autoSubmitted = readHeaderString(headers, 'auto-submitted');
  if (autoSubmitted) {
    const keyword = autoSubmitted.trim().toLowerCase().split(/[\s;(]/)[0];
    if (keyword && keyword !== 'no') {
      return `Auto-Submitted: ${autoSubmitted.trim()}`;
    }
  }

  // Precedence — pre-RFC-3834 convention still widely set by mailing-list
  // managers, ticket systems, and bulk senders.
  const precedence = readHeaderString(headers, 'precedence');
  if (precedence && PRECEDENCE_AUTO.has(precedence.trim().toLowerCase())) {
    return `Precedence: ${precedence.trim()}`;
  }

  for (const name of VENDOR_AUTO_HEADERS) {
    if (headers.has(name)) return `${name} header present`;
  }

  // Mailing-list signals — distinct from autoresponders but the rule is the
  // same: don't deliver to an agent that might reply. mailparser collapses
  // List-Id and List-Unsubscribe into a single `list` key whose value is a
  // structured object with optional `id` and `unsubscribe` sub-fields.
  const list = headers.get('list');
  if (list && typeof list === 'object' && !Array.isArray(list)) {
    if ('id' in list && list.id) return 'List-Id header present (mailing list)';
    if ('unsubscribe' in list && list.unsubscribe) return 'List-Unsubscribe header present (mailing list)';
  }

  return undefined;
}

/** Coerce a mailparser header value (string | string[] | object) into a
 *  plain string when possible. Returns undefined for non-string shapes
 *  (addresses, structured objects) — the headers we care about are all
 *  unstructured text. */
function readHeaderString(headers: ParsedMail['headers'], name: string): string | undefined {
  const v = headers.get(name);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const first = v.find((x): x is string => typeof x === 'string');
    return first;
  }
  return undefined;
}
