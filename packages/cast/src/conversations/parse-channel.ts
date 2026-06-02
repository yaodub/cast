/**
 * Composite channel-string parsing — `name` or `name~qualifier`.
 *
 * The LLM-facing surface (MCP tool args, `<cast:query>` channel attribute)
 * accepts a single string. Internal routing types carry channel and qualifier
 * as separate fields. This module is the boundary parser that turns the
 * composite form into a `ParsedChannel`, validating both halves against the
 * trust-tier-appropriate channel-name shape.
 *
 * Two parsers — they share the `~qualifier` split but differ on which channel
 * names they accept:
 *
 *   `parseChannelString` (user-trust): rejects `__*` so a prompt-injected
 *   user-channel LLM cannot mint an infrastructure address.
 *
 *   `parseOperatorChannel` (operator-trust): accepts both `[a-z]...` and
 *   `__[a-z]...` so per-agent consoles (`__design`, `__configure`) and
 *   server-scope consoles (DM/CM/SM) can address `__*` channels they have
 *   legitimate need for. The trust gate is "who is calling," enforced at
 *   the MCP tool registration site by picking the right parser per actor;
 *   the regex here is the structural enforcement of that decision.
 *
 * Grammar: `~` separates qualifier from
 * the channel segment, and qualifiers cannot themselves contain `~` (so the
 * split is on a single `~`). Qualifiers are always user-shaped — there is
 * no operator-trust use case for `__*` qualifiers.
 */

export const CHANNEL_NAME_RE = /^[a-z][a-z0-9-]*$/;
export const OPERATOR_CHANNEL_NAME_RE = /^(?:__[a-z][a-z0-9-]*|[a-z][a-z0-9-]*)$/;

export interface ParsedChannel {
  channel: string;
  qualifier?: string;
}

export type ParseChannelResult =
  | { ok: true; parsed: ParsedChannel }
  | { ok: false; reason: string };

function parseWithRegex(input: string, channelRe: RegExp): ParseChannelResult {
  const tildeIdx = input.indexOf('~');
  if (tildeIdx === -1) {
    if (!channelRe.test(input)) {
      return { ok: false, reason: `Invalid channel name "${input}" — must match ${channelRe}.` };
    }
    return { ok: true, parsed: { channel: input } };
  }
  const channel = input.slice(0, tildeIdx);
  const qualifier = input.slice(tildeIdx + 1);
  if (!channelRe.test(channel)) {
    return { ok: false, reason: `Invalid channel name "${channel}" in "${input}" — must match ${channelRe}.` };
  }
  // Qualifiers stay user-shaped regardless of which parser is in use — no
  // legitimate use case for `__*` sub-conversation names.
  if (!CHANNEL_NAME_RE.test(qualifier)) {
    return { ok: false, reason: `Invalid qualifier "${qualifier}" in "${input}" — must match ${CHANNEL_NAME_RE} (and may not contain "~").` };
  }
  return { ok: true, parsed: { channel, qualifier } };
}

export function parseChannelString(input: string): ParseChannelResult {
  return parseWithRegex(input, CHANNEL_NAME_RE);
}

export function parseOperatorChannel(input: string): ParseChannelResult {
  return parseWithRegex(input, OPERATOR_CHANNEL_NAME_RE);
}
