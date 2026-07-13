/**
 * Shared parser for slash-command approval responses typed in chat or the CLI:
 *
 *   /approve <id> [always] [reason...]
 *   /reject  <id> [always] [reason...]
 *
 * One home so the web and CLI transports cannot drift on tier handling — a
 * missing `tier` here was how every web-chat "always" silently became a
 * one-shot grant. The `always` keyword (immediately after the id) writes a
 * standing grant/tombstone; omit it for a one-shot. Email parses its own reply
 * shape (no slash, thread-bound id) but shares the same once/always semantics.
 */
export interface ApprovalCommand {
  decision: 'approved' | 'rejected';
  id: string;
  tier: 'once' | 'always';
  reason?: string;
}

const APPROVAL_COMMAND_RE = /^\/(approve|reject)\s+(\S+)(?:\s+(always))?(?:\s+([\s\S]+))?$/i;

/** Parse an approval slash-command, or `null` when the text is not one. */
export function parseApprovalCommand(text: string): ApprovalCommand | null {
  const m = APPROVAL_COMMAND_RE.exec(text.trim());
  if (!m) return null;
  return {
    decision: m[1]!.toLowerCase() === 'approve' ? 'approved' : 'rejected',
    id: m[2]!,
    tier: m[3] ? 'always' : 'once',
    reason: m[4]?.trim() || undefined,
  };
}
