/**
 * Packet factories and hashing.
 *
 * Type definitions (Packet, ConversationPkt, DelegatePkt, AnyPacket) live in
 * types.ts — this module provides construction and hashing utilities.
 *
 * sessionHash is an opaque hash of the CC session ID.
 * Only set on outbound packets by the conversation runner.
 * Clients detect conversation boundaries from sessionHash transitions.
 */
import { createHash } from 'crypto';
import { z } from 'zod';

import type { Attachment, ConversationPkt, DelegatePkt, ApprovalRequestPkt, ApprovalAckPkt, PreviewPkt } from '../types.js';
import { AttachmentSchema, DEFAULT_APPROVAL_EXPIRY } from '../types.js';

// Re-export packet types for convenience (callers can import from either location)
export type { Packet, ConversationPkt, DelegatePkt, ApprovalRequestPkt, ApprovalAckPkt, PreviewPkt, PreviewPktBase, AnyPacket } from '../types.js';
export { DEFAULT_APPROVAL_EXPIRY } from '../types.js';

// --- Zod schemas (for bus boundary validation) ---

const BasePacketFields = {
  id: z.string().optional(),
  from: z.string(),
  to: z.string(),
  text: z.string(),
  timestamp: z.string(),
  streamId: z.string().optional(),
};

const ConversationPktSchema = z.object({
  ...BasePacketFields,
  type: z.literal('conversation'),
  sessionHash: z.string().optional(),
  attachments: z.array(AttachmentSchema).optional(),
});

const DelegatePktSchema = z.object({
  ...BasePacketFields,
  type: z.literal('delegate'),
  target: z.string(),
  sessionHash: z.string().optional(),
});

const ApprovalRequestPktSchema = z.object({
  ...BasePacketFields,
  type: z.literal('approval_request'),
  approvalId: z.string(),
  summary: z.string(),
  details: z.string().optional(),
  expiresAt: z.string().optional(),
  tiered: z.boolean().optional(),
});

const ApprovalAckPktSchema = z.object({
  ...BasePacketFields,
  type: z.literal('approval_ack'),
  approvalId: z.string(),
  decision: z.enum(['approved', 'rejected', 'expired']),
  summary: z.string(),
  reason: z.string().optional(),
  tier: z.enum(['once', 'always']).optional(),
});

// Preview packets — nested discriminated on `kind`. Only `text` ships in v1;
// other kinds are reserved type space (see types.ts PreviewPkt comments).
// The Zod union mirrors that: one arm today, room to grow without touching
// AnyPacketSchema or any predicate.
const PreviewPktSchema = z.discriminatedUnion('kind', [
  z.object({
    ...BasePacketFields,
    type: z.literal('preview'),
    kind: z.literal('text'),
    streamId: z.string(),
    channel: z.string(),
    final: z.boolean().optional(),
  }),
]);

export const AnyPacketSchema = z.discriminatedUnion('type', [
  ConversationPktSchema,
  DelegatePktSchema,
  ApprovalRequestPktSchema,
  ApprovalAckPktSchema,
  PreviewPktSchema,
]);

// --- Factories ---

export function conversationPkt(
  from: string,
  to: string,
  text: string,
  sessionHash?: string,
  timestamp?: string,
  attachments?: Attachment[],
  id?: string,
  /** When set, this seal terminates preview stream `streamId`. */
  streamId?: string,
): ConversationPkt {
  return {
    type: 'conversation',
    ...(id ? { id } : {}),
    from,
    to,
    text,
    timestamp: timestamp ?? new Date().toISOString(),
    sessionHash,
    ...(attachments?.length ? { attachments } : {}),
    ...(streamId ? { streamId } : {}),
  };
}

export function delegatePkt(
  from: string,
  to: string,
  target: string,
  text: string,
  sessionHash?: string,
): DelegatePkt {
  return {
    type: 'delegate',
    from,
    to,
    target,
    text,
    timestamp: new Date().toISOString(),
    sessionHash,
  };
}

export function approvalRequestPkt(
  from: string,
  to: string,
  summary: string,
  approvalId: string,
  details?: string,
  expiresIn?: number,
  tiered?: boolean,
): ApprovalRequestPkt {
  const expiresAt = new Date(Date.now() + (expiresIn ?? DEFAULT_APPROVAL_EXPIRY) * 1000).toISOString();
  return {
    type: 'approval_request',
    from,
    to,
    text: summary,
    summary,
    details,
    approvalId,
    expiresAt,
    tiered,
    timestamp: new Date().toISOString(),
  };
}

export function previewTextPkt(
  from: string,
  to: string,
  text: string,
  streamId: string,
  channel: string,
  final?: boolean,
): PreviewPkt {
  return {
    type: 'preview',
    kind: 'text',
    from,
    to,
    text,
    streamId,
    channel,
    timestamp: new Date().toISOString(),
    ...(final ? { final: true } : {}),
  };
}

export function approvalAckPkt(
  from: string,
  to: string,
  approvalId: string,
  decision: 'approved' | 'rejected' | 'expired',
  summary: string,
  reason?: string,
  tier?: 'once' | 'always',
): ApprovalAckPkt {
  const base = decision === 'approved' ? 'Approved' : decision === 'rejected' ? 'Rejected' : 'Expired';
  // `always` prefixes the verb so the ack reads as the action taken — "Always
  // approved" / "Always rejected" — matching the four button labels. `expired`
  // carries no tier.
  const label = tier === 'always' && decision !== 'expired' ? `Always ${decision}` : base;
  return {
    type: 'approval_ack',
    from,
    to,
    text: `${label}: ${summary}`,
    approvalId,
    decision,
    summary,
    reason,
    tier,
    timestamp: new Date().toISOString(),
  };
}

// --- Hashing ---

/**
 * Hash a raw key into an opaque 12-char hex string.
 * First 12 chars of SHA-256 hex. Deterministic: same input always gets same output.
 */
export function hashConversationKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex').slice(0, 12);
}
