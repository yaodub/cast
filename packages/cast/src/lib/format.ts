/**
 * Message formatting utilities — escaping, XML envelope, output validation.
 */
import { parseChannelString } from '../conversations/parse-channel.js';
import type { NewMessage } from '../types.js';
import { toZonedIso } from './utils.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format an attribute map into the ` k1="v1" k2="v2"` substring used inside
 * a `<cast:kind>` opener. Empty / undefined input returns the empty string.
 * Values are XML-escaped so quote chars don't break tag parsing.
 */
export function formatTagAttrs(attrs?: Record<string, string>): string {
  if (!attrs) return '';
  const keys = Object.keys(attrs);
  if (keys.length === 0) return '';
  return keys.map((k) => ` ${k}="${escapeXml(attrs[k]!)}"`).join('');
}

export function formatMessages(messages: NewMessage[], timezone?: string): string {
  const lines = messages.map((m) => {
    const time = toZonedIso(new Date(m.timestamp), timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${time}">${escapeXml(m.content)}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

/** Strip the framework `<cast:*>` tag family from inbound participant text —
 *  defense against a participant injecting fake framework stimulus
 *  (`<cast:watch>`, `<cast:schedule>`, etc.) or fake private reasoning
 *  (`<cast:internal>`). Strips balanced pairs first, then drops any orphan
 *  openers/closers in the family so a truncated injection can't pass through
 *  as literal text the agent might trust.
 *
 *  Applied at the untrusted-ingest boundary by `formatParticipantMessage`
 *  (strip → escape → wrap), so the stripped body is what reaches the agent AND
 *  what the message log records — not just the log copy. */
const FRAMEWORK_TAG_NAMES = 'internal|watch|schedule|service|lifecycle|push|rejection|pending';
const FRAMEWORK_PAIR_RE = new RegExp(
  `<cast:(${FRAMEWORK_TAG_NAMES})\\b[^>]*>[\\s\\S]*?<\\/cast:\\1>`,
  'g',
);
const FRAMEWORK_ORPHAN_RE = new RegExp(
  `<\\/?cast:(${FRAMEWORK_TAG_NAMES})\\b[^>]*>`,
  'g',
);

export function stripFrameworkTags(text: string): string {
  return text.replace(FRAMEWORK_PAIR_RE, '').replace(FRAMEWORK_ORPHAN_RE, '').trim();
}

/**
 * Single chokepoint for turning UNTRUSTED participant text into the message
 * envelope delivered to the agent. Strips the forge-able framework `<cast:*>`
 * stimulus family FIRST (so a participant can never inject fake framework
 * stimulus the agent would trust), THEN escapes + wraps via `formatMessages`.
 * The only formatter permitted to touch participant-supplied text — the shared
 * formatters (`formatMessages`, the request/response tag builders) also serve
 * trusted paths that legitimately construct `<cast:*>` tags, so the strip lives
 * here, never in them.
 *
 * Pure. Returns the sanitized body alongside the rendered envelope so the caller
 * can log a body that matches what the agent saw and detect an injection attempt
 * via `sanitized !== rawText.trim()` (stripFrameworkTags trims, so an unchanged
 * body is byte-identical to the trimmed input).
 */
export function formatParticipantMessage(
  rawText: string,
  opts: { sender: string; declaredName?: string; timezone?: string; timestamp: string },
): { formatted: string; sanitized: string } {
  const sanitized = stripFrameworkTags(rawText);
  const formatted = formatMessages(
    [
      {
        id: '',
        address: '',
        sender: opts.sender,
        sender_name: opts.declaredName ?? opts.sender,
        content: sanitized,
        timestamp: opts.timestamp,
      },
    ],
    opts.timezone,
  );
  return { formatted, sanitized };
}

// ---------------------------------------------------------------------------
// Agent-output validation gate
//
// `validateAgentOutput` is the single chokepoint for agent output. It enforces
// three rules over `<cast:*>` tags:
//
//   1. Balanced — every `<cast:tag>` opener has a matching closer in order.
//   2. No nesting — cast tags can't contain other cast tags.
//   3. Size — user-visible bytes (everything outside cast:* blocks) must not
//      exceed `maxBytes`.
//
// Known semantic tags (`internal`, `query`, `answer`) are extracted into the
// parsed result. ALL `<cast:*>` blocks — known or unknown — are stripped from
// user-visible text before delivery. Agents that quote framework tags (e.g.
// `<cast:watch>`) won't see a rejection; the tag is silently dropped from what
// the participant receives. The system prompt teaches this contract so agents
// don't try to use cast tags as user-visible markup.
//
// Two phases: structural pass (balance/nesting) gates a semantic pass
// (attribute extraction + size cap). Within each phase reasons accumulate so
// the agent gets every problem in a single feedback round.
// ---------------------------------------------------------------------------

export interface ParsedQuery {
  /** Wire-format kind chosen by the sender. `<cast:query>` expects a
   *  `<cast:answer>` reply; `<cast:request>` is fire-and-forget. ACL is
   *  gated on the matching bit (`q` for query, `r` for request) at the
   *  outbound site. */
  kind: 'query' | 'request';
  target: string;
  channel: string;
  qualifier?: string;
  text: string;
}

export interface ParsedAnswer {
  requestId: string;
  text: string;
}

export interface ParsedOutput {
  /** User-visible text — raw with cast:internal/query/request/answer blocks removed and trimmed. */
  text: string | null;
  /** Concatenated content of all <cast:internal> blocks (newline-joined), or null. */
  internal: string | null;
  /** Both `<cast:query>` (q/a pair) and `<cast:request>` (r, fire-and-forget) — discriminated by `kind`. */
  queries: ParsedQuery[];
  answers: ParsedAnswer[];
}

export type ValidationResult =
  | { ok: true; parsed: ParsedOutput }
  | { ok: false; reasons: string[] };

const CAST_TAG_RE = /<(\/?)cast:([a-z]+)((?:\s[^>]*)?)>/g;

interface StackEntry {
  name: string;
  /** Position in `raw` where the opening `<` of the opener tag begins. */
  openStart: number;
  /** Position in `raw` immediately after the opener's `>` — start of the content. */
  contentStart: number;
  attrs: string;
}

interface CompletedTag {
  name: string;
  attrs: string;
  /** Inner content (between opener `>` and closer `<`). */
  content: string;
  /** Slice [openStart, closeEnd) in `raw` — used to remove the entire tag block. */
  openStart: number;
  closeEnd: number;
}

const QUERY_ATTR_RE = /target="([^"]+)"(?:\s+channel="([^"]*)")?/;
const ANSWER_ATTR_RE = /request="([^"]+)"/;

/**
 * Byte ranges in `raw` that are markdown code — fenced blocks and inline code
 * spans. A `<cast:…>` sequence inside one of these is literal text the agent is
 * quoting, not framework markup: the validation scan skips it (opener and
 * closer alike). This is the escape hatch that lets an agent display cast-tag
 * syntax — quoting it in a reply, or editing docs that mention it — without
 * tripping the balance / no-nesting rules.
 *
 * Outbound only. Inbound `stripFrameworkTags` does NOT honor code spans: there
 * the sender may be hostile and a fake-stimulus injection slipping through
 * outweighs a participant not being able to quote a tag verbatim. The asymmetry
 * is deliberate and matches the asymmetric trust in the two directions.
 *
 * Not a full CommonMark tokenizer — it covers the two forms agents actually use
 * (single/multi backtick inline spans, ``` / ~~~ fences) with CommonMark's
 * matching rules: a run of N backticks closes on the next run of exactly N; an
 * unclosed run is not a span. Any case the detector misses fails safe — the tag
 * is validated as real (clean rejection or inert text), never silently routed.
 */
function computeCodeRanges(raw: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  // Line offsets, for the line-oriented fence pass.
  const lineStarts: number[] = [0];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\n') lineStarts.push(i + 1);
  }
  const lineSlice = (idx: number): string => {
    const start = lineStarts[idx]!;
    const end = idx + 1 < lineStarts.length ? lineStarts[idx + 1]! - 1 : raw.length;
    return raw.slice(start, end);
  };

  // Pass 1: fenced blocks. An opener line begins (after optional indent) with a
  // run of >= 3 backticks or tildes; the block runs to the next line that is a
  // closing fence of the same char and >= length (trailing whitespace only), or
  // to EOF if never closed.
  const fenced: Array<[number, number]> = [];
  const fenceOpen = /^[ \t]*(`{3,}|~{3,})/;
  let li = 0;
  while (li < lineStarts.length) {
    const m = fenceOpen.exec(lineSlice(li));
    if (!m) { li++; continue; }
    const marker = m[1]![0]!;
    const len = m[1]!.length;
    const closeRe = new RegExp(`^[ \\t]*\\${marker}{${len},}[ \\t]*$`);
    const start = lineStarts[li]!;
    let blockEnd = raw.length;
    let lj = li + 1;
    for (; lj < lineStarts.length; lj++) {
      if (closeRe.test(lineSlice(lj))) {
        blockEnd = lj + 1 < lineStarts.length ? lineStarts[lj + 1]! - 1 : raw.length;
        break;
      }
    }
    fenced.push([start, blockEnd]);
    ranges.push([start, blockEnd]);
    li = lj + 1;
  }

  // Pass 2: inline spans, over backtick runs not already inside a fence. Pair
  // each opening run with the next run of equal length; runs of other lengths
  // between them are span content. An unpaired run is literal.
  const inFence = (idx: number): boolean => fenced.some(([s, e]) => idx >= s && idx < e);
  const runs: Array<{ index: number; len: number }> = [];
  for (const m of raw.matchAll(/`+/g)) {
    if (!inFence(m.index)) runs.push({ index: m.index, len: m[0].length });
  }
  for (let r = 0; r < runs.length; r++) {
    const open = runs[r]!;
    for (let k = r + 1; k < runs.length; k++) {
      if (runs[k]!.len === open.len) {
        ranges.push([open.index, runs[k]!.index + runs[k]!.len]);
        r = k; // outer loop's r++ advances past the closer
        break;
      }
    }
  }

  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}

export function validateAgentOutput(raw: string, maxBytes: number): ValidationResult {
  const reasons: string[] = [];
  const stack: StackEntry[] = [];
  const completed: CompletedTag[] = [];

  // Tags inside markdown code spans are literal text the agent is quoting, not
  // framework markup — skip them so they neither route nor trip the structural
  // rules. They stay in `userVisible` and are delivered as-is. See
  // `computeCodeRanges`.
  const codeRanges = computeCodeRanges(raw);
  const inCode = (idx: number): boolean => codeRanges.some(([s, e]) => idx >= s && idx < e);

  for (const m of raw.matchAll(CAST_TAG_RE)) {
    const matchIndex = m.index ?? 0;
    if (inCode(matchIndex)) continue;
    const isClose = m[1] === '/';
    const name = m[2]!;
    const attrs = m[3] ?? '';
    const tagEnd = matchIndex + m[0].length;

    if (isClose) {
      if (stack.length === 0) {
        reasons.push(
          `Orphan </cast:${name}> at byte ${matchIndex} (no matching opener). ` +
          `If you meant to show this tag as text, wrap it in backticks or a code fence.`,
        );
        continue;
      }
      const top = stack[stack.length - 1]!;
      if (top.name !== name) {
        reasons.push(`Mismatched </cast:${name}> at byte ${matchIndex} — expected </cast:${top.name}>.`);
        // Pop the unmatched opener so the loop can keep collecting reasons instead
        // of derailing every subsequent tag against a stale stack.
        stack.pop();
        continue;
      }
      stack.pop();
      completed.push({
        name,
        attrs: top.attrs,
        content: raw.slice(top.contentStart, matchIndex),
        openStart: top.openStart,
        closeEnd: tagEnd,
      });
    } else {
      if (stack.length > 0) {
        reasons.push(
          `Nested <cast:${name}> at byte ${matchIndex} inside <cast:${stack[stack.length - 1]!.name}> — cast tags are structural and can't be nested. ` +
          `To show a cast tag as text, wrap it in backticks or a code fence — code-span content is delivered literally, not parsed. ` +
          `To send a real tag, close the current envelope first; routing tags must be top-level.`,
        );
        // Don't push: the inner's closer will fall into the mismatch branch
        // against the outer (or pop the outer harmlessly if names match).
        continue;
      }
      stack.push({
        name,
        openStart: matchIndex,
        contentStart: tagEnd,
        attrs,
      });
    }
  }

  for (const orphan of stack) {
    reasons.push(`Unclosed <cast:${orphan.name}> opened at byte ${orphan.openStart}.`);
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  // Structural pass clean — extract values. Semantic reasons (missing attrs,
  // unknown tags, size cap) accumulate into `reasons` so the agent gets every
  // problem in one feedback round, not whack-a-mole.
  const internalContents: string[] = [];
  const queries: ParsedQuery[] = [];
  const answers: ParsedAnswer[] = [];

  let userVisible = '';
  let cursor = 0;
  for (const tag of completed) {
    userVisible += raw.slice(cursor, tag.openStart);
    cursor = tag.closeEnd;
    if (tag.name === 'internal') {
      internalContents.push(tag.content.trim());
    } else if (tag.name === 'query' || tag.name === 'request') {
      // `<cast:query>` and `<cast:request>` share attribute shape and routing
      // path — the kind discriminator is preserved through the parsed output
      // so the outbound ACL gate can match `q` to query and `r` to request
      // (see acl.ts docstring on q/r pairing), and the receiver-side tag
      // rendering can echo back the same wire format the sender chose.
      const am = QUERY_ATTR_RE.exec(tag.attrs);
      if (!am) {
        reasons.push(`<cast:${tag.name}> at byte ${tag.openStart} missing required target= attribute.`);
        continue;
      }
      const channelInput = am[2] || 'default';
      const parsed = parseChannelString(channelInput);
      if (!parsed.ok) {
        reasons.push(`<cast:${tag.name}> at byte ${tag.openStart}: ${parsed.reason}`);
        continue;
      }
      queries.push({
        kind: tag.name,
        target: am[1]!,
        channel: parsed.parsed.channel,
        ...(parsed.parsed.qualifier ? { qualifier: parsed.parsed.qualifier } : {}),
        text: tag.content.trim(),
      });
    } else if (tag.name === 'answer') {
      const am = ANSWER_ATTR_RE.exec(tag.attrs);
      if (!am) {
        reasons.push(`<cast:answer> at byte ${tag.openStart} missing required request= attribute.`);
        continue;
      }
      answers.push({ requestId: am[1]!, text: tag.content.trim() });
    }
    // Unknown tags fall through: cursor has already advanced past their close,
    // so their body is excluded from userVisible. They are silently dropped
    // from delivered text rather than rejected — see the doc-block above.
  }
  userVisible += raw.slice(cursor);
  const userVisibleTrimmed = userVisible.trim();

  if (userVisibleTrimmed.length > maxBytes) {
    reasons.push(`Output exceeded ${maxBytes} bytes of user-visible content (was ${userVisibleTrimmed.length}). Use /staging/out/ for long content.`);
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  return {
    ok: true,
    parsed: {
      text: userVisibleTrimmed.length > 0 ? userVisibleTrimmed : null,
      internal: internalContents.length > 0 ? internalContents.join('\n').trim() || null : null,
      queries,
      answers,
    },
  };
}
