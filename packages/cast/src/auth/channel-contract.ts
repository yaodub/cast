/**
 * Channel contract — operational projection of ACL bits.
 *
 * ACL bits (`ioaqr`, see `acl.ts`) are the primitive. Several layers want to
 * tell the agent *what those bits mean for what it may emit and how it may be
 * addressed*: the system prompt assembler, the outbound-bounce site, the
 * `agent__list_peers` tool. Without a shared interpretation, each site would
 * re-grep the bit string in its own ad-hoc way — and they'd drift.
 *
 * This module is the chokepoint:
 *   1. `deriveChannelContract(bits)` — pure projection into a typed shape.
 *   2. Three renderers, each consuming the contract — `…ForPrompt`,
 *      `…ForRejection`, `…ForPeerListing`. Their prose differs by audience
 *      and length; their underlying semantics share one source.
 *
 * Adding a new bit (or a new envelope kind) updates `deriveChannelContract`
 * and the renderer switches. Sites that gate on a single bit (`hasBit(bits,
 * 'X')`) stay on `hasBit` — they're permission checks, not interpretations,
 * and the contract abstraction would add ceremony with no semantic gain.
 */
import { hasBit } from './acl.js';

/** The three envelope tags that can carry semantic payload between agents. */
export type EnvelopeKind = 'answer' | 'query' | 'request';

/**
 * What an agent may emit and accept on a given channel toward a given
 * addressee. Pure projection of the bit string returned by `checkAcl`.
 *
 * `send` describes outbound capability (what the agent can produce that will
 * actually reach the addressee). `receive` describes inbound capability
 * (what kinds of traffic the addressee may send into this agent's channel).
 *
 * Note `receive.structuredInbound` (the `a` bit) covers both `<cast:query>`
 * and `<cast:request>` — agents accepting structured inbound take either
 * kind. See `acl.ts` docstring on the q/r/a pairing.
 */
export interface ChannelContract {
  readonly send: {
    /** Free-form conversation messages (`o` bit). */
    readonly freeText: boolean;
    /** `<cast:query>` envelopes — expecting `<cast:answer>` back (`q` bit). */
    readonly query: boolean;
    /** `<cast:request>` envelopes — fire-and-forget (`r` bit). */
    readonly request: boolean;
  };
  readonly receive: {
    /** Inbound free-form conversation messages (`i` bit). Also the push-host
     *  capability: a pushed-in turn is an `i`-bit delivery (post-fold). */
    readonly freeText: boolean;
    /** Inbound `<cast:query>` or `<cast:request>`; agent answers with
     *  `<cast:answer>` for query, no envelope reply for request (`a` bit). */
    readonly structuredInbound: boolean;
  };
}

/** Pure derivation from bit string. Adding a bit means extending this and
 *  the renderers below — one place, no scattered `hasBit` interpretations. */
export function deriveChannelContract(bits: string): ChannelContract {
  return {
    send: {
      freeText: hasBit(bits, 'o'),
      query: hasBit(bits, 'q'),
      request: hasBit(bits, 'r'),
    },
    receive: {
      freeText: hasBit(bits, 'i'),
      structuredInbound: hasBit(bits, 'a'),
    },
  };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/**
 * System-prompt block describing the wire contract to the agent. Returns
 * `null` when the agent has free-text outbound (`o` bit) and no structured
 * envelopes — the default conversational mode, nothing extra to say.
 *
 * Non-null returns are channel-conditional teaching: only emitted when the
 * agent is on a channel where the default "emit prose freely" mental model
 * would cause bounces. The corresponding rejection renderer below produces
 * the matched feedback if the agent ignores the prompt and emits prose
 * anyway.
 */
export function renderContractForPrompt(c: ChannelContract): string | null {
  const send = c.send;
  const hasStructured = send.query || send.request || c.receive.structuredInbound;

  // Default-mode silence: free conversation works, no special prompt needed.
  if (send.freeText && !hasStructured) return null;

  // Pathological: no outbound rights and no inbound structured handling
  // either. Nothing useful to teach — prompt-layer can't fix a fully
  // locked-down channel. Caller may want to surface this differently.
  if (!send.freeText && !hasStructured) return null;

  const lines: string[] = [];

  if (send.freeText) {
    lines.push(
      'Free-form conversation messages on this channel are delivered to the addressee normally.',
    );
  } else {
    lines.push(
      'This channel does not deliver free-form conversation. Only the structured envelopes listed below reach the addressee; any other text is rejected as undeliverable.',
    );
  }

  const sendLines: string[] = [];
  if (c.receive.structuredInbound) {
    sendLines.push(
      '- `<cast:answer request="…">…</cast:answer>` in reply to an incoming `<cast:query>`.',
    );
  }
  if (send.query) {
    sendLines.push(
      '- `<cast:query target="…">…</cast:query>` to ask the addressee a question — expect a `<cast:answer>` back.',
    );
  }
  if (send.request) {
    sendLines.push(
      '- `<cast:request target="…">…</cast:request>` to fire-and-forget — no reply will be delivered.',
    );
  }
  if (sendLines.length > 0) {
    lines.push('You may emit:');
    lines.push(...sendLines);
  }

  if (c.receive.structuredInbound) {
    lines.push(
      'Incoming `<cast:request>` envelopes are fire-and-forget — handle them via tools; emitting `<cast:answer>` in reply is pointless because the sender opted out of the return path.',
    );
  }

  lines.push(
    '`<cast:internal>…</cast:internal>` is always available for private reasoning you want logged locally; it is never delivered.',
  );

  return lines.join('\n');
}

/**
 * Feedback message for a bounced outbound — agent emitted text outside an
 * envelope on a channel that does not carry free-form conversation. Mirrors
 * the prompt block's vocabulary so the agent reads consistent guidance from
 * two surfaces (prompt up-front, rejection if it ignores the prompt).
 *
 * Finality: "do not retry this text." The agent is asked to learn the
 * shape, not to wrap-and-resend the dropped content (which would be a lie —
 * the addressee never got it and the system's role is to surface that
 * fact, not to recover the message).
 */
export function renderContractForRejection(c: ChannelContract): string {
  const send = c.send;
  const inbound = c.receive.structuredInbound;
  const allowed: string[] = [];
  if (inbound) allowed.push('`<cast:answer request="…">`');
  if (send.query) allowed.push('`<cast:query target="…">`');
  if (send.request) allowed.push('`<cast:request target="…">`');

  if (allowed.length === 0) {
    return (
      'Output text was rejected — this channel delivers nothing addressed to this peer. Do not retry this text. ' +
      'If reasoning needs a local record, use `<cast:internal>…</cast:internal>` instead.'
    );
  }

  const list = allowed.join(', ');
  return (
    `Output text was rejected — this channel only delivers structured envelopes (${list}) to the addressee. ` +
    'Do not retry this text. ' +
    'For reasoning you want kept locally, wrap it in `<cast:internal>…</cast:internal>` — that is never delivered, never rejected.'
  );
}

/**
 * Render the bidirectional capability summary for the `agent__list_peers`
 * tool. Returns the indented sub-lines for one (peer, channel) row — the
 * caller composes the header (`- alias (canonical)`) and joins.
 *
 * Each bit gets one line, expressed in the agent's frame ("you can X" /
 * "they can X"). Bits that pair semantically (`a` accepts both inbound
 * query and request, but the surface vocabulary is "they can query you" —
 * `<cast:request>` is mentioned only when the *agent itself* has the `r`
 * bit, where the wire-format choice is the agent's to make).
 */
export function renderContractForPeerListing(c: ChannelContract): string[] {
  const lines: string[] = [];
  if (c.send.query) lines.push('you can query');
  if (c.send.request) lines.push('you can fire fire-and-forget requests');
  if (c.send.freeText) lines.push('you can message');
  if (c.receive.structuredInbound) lines.push('they can query you');
  if (c.receive.freeText) lines.push('they can message you');
  return lines;
}
