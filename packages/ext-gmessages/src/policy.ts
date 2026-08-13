/**
 * Access-control decisions — pure functions over config.
 *
 * A `Decision` is the three-way the approval framework speaks:
 * - `skip`    — allowed, no approval needed (a hard allow, or an open mode).
 * - `approve` — allowed, but a human must approve this call.
 * - `block`   — denied.
 *
 * Read policy is keyed on conversationId (`config.chats`), falling back to the
 * global `read_mode`. Send policy lands with the send tool; contacts (E.164,
 * cold send) belong there.
 */
import type { GmessagesConfig } from './schemas.js';

export type Decision = 'skip' | 'approve' | 'block';

/** Read decision for an existing conversation. */
export function readDecision(config: GmessagesConfig, conversationId: string): Decision {
  const override = config.chats[conversationId]?.read;
  if (override === 'allow') return 'skip';
  if (override === 'deny') return 'block';
  switch (config.read_mode) {
    case 'disabled':
      return 'block';
    case 'open':
      return 'skip';
    case 'approval':
      return 'approve';
  }
}

/** Convenience: is reading this conversation permitted at all (approval still possible)? */
export function canRead(config: GmessagesConfig, conversationId: string): boolean {
  return readDecision(config, conversationId) !== 'block';
}

/**
 * Delivery ACL for an installed watch — deliberately more permissive than
 * `readDecision`.
 *
 * A watch was approved when it was installed; re-prompting on every fire would
 * make it useless. So `approval` reads as permissive here, and only an explicit
 * deny or a globally disabled read blocks a delivery.
 */
export function canDeliver(config: GmessagesConfig, conversationId: string): boolean {
  const override = config.chats[conversationId]?.read;
  if (override === 'allow') return true;
  if (override === 'deny') return false;
  return config.read_mode !== 'disabled';
}

/**
 * Send decision for an EXISTING conversation.
 *
 * `send_mode: 'disabled'` is checked FIRST and cannot be overridden — the mode
 * is a master switch, not a default. This is deliberately ASYMMETRIC with the
 * read axis, where an explicit allow does beat a disabled global (a useful
 * "only this thread" pattern with no outward effect). Sending is irreversible
 * and ships disabled by design, so turning it on stays an explicit change of
 * mode rather than something an allowlist entry can imply.
 */
export function sendDecision(config: GmessagesConfig, conversationId: string): Decision {
  if (config.send_mode === 'disabled') return 'block';
  const override = config.chats[conversationId]?.send;
  if (override === 'allow') return 'skip';
  if (override === 'deny') return 'block';
  return config.send_mode === 'direct' ? 'skip' : 'approve';
}

/**
 * Send decision for a COLD target — an E.164 number with no existing thread.
 *
 * The invariant that makes this a separate function: **no global mode can make
 * first contact silent.** An explicit `contacts` allow skips approval; a deny
 * blocks; anything else asks a human, INCLUDING under `send_mode: 'direct'`.
 * A typo'd number under `direct` would otherwise text a stranger irreversibly,
 * which is categorically riskier than replying into a thread a human started.
 * `disabled` still blocks outright.
 */
export function coldSendDecision(config: GmessagesConfig, phone: string): Decision {
  // Same master-switch rule as `sendDecision`.
  if (config.send_mode === 'disabled') return 'block';
  const override = config.contacts[phone]?.send;
  if (override === 'allow') return 'skip';
  if (override === 'deny') return 'block';
  return 'approve';
}

/** Does this look like an E.164 number (a cold-send target) rather than a name? */
export function isPhoneNumber(query: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(query.trim());
}
