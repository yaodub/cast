/**
 * WebSocket protocol schemas — Zod is the single source of truth.
 * Types are inferred from schemas, never hand-written.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Server → Client message schemas
// ---------------------------------------------------------------------------

export const RegisterPayload = z.object({
  type: z.literal('register'),
  handle: z.string(),
  identity: z.string(),
  name: z.string().optional(),
});

export const AgentsPayload = z.object({
  type: z.literal('agents'),
  list: z.array(z.object({
    /** Agent alias (manifest.name). This is the value clients echo back in subsequent messages. */
    alias: z.string(),
    /** Canonical bus address `a:<guid>@<issuer>`. Stable across alias rename — safe to cache. */
    address: z.string(),
    description: z.string().optional(),
    channels: z.array(z.object({ name: z.string(), bits: z.string() })),
  })),
  name: z.string().optional(),
});

export const DiscoverPayload = z.object({
  type: z.literal('discover'),
  list: z.array(z.object({
    alias: z.string(),
    address: z.string(),
    description: z.string().optional(),
  })),
});

export const MessagePayload = z.object({
  type: z.literal('conversation'),
  id: z.string().optional(),
  agent: z.string().optional(),
  channel: z.string().optional(),
  from: z.string(),
  to: z.string(),
  text: z.string(),
  timestamp: z.string(),
  sessionHash: z.string().nullable().optional(),
  attachments: z.array(z.object({
    filename: z.string(),
    mimeType: z.string(),
    hash: z.string().optional(),
  })).optional(),
  /** Present when this seal terminates a preview stream — used to clear the matching in-flight bubble. */
  streamId: z.string().optional(),
});

export const PreviewPayload = z.object({
  type: z.literal('preview'),
  kind: z.literal('text'),
  agent: z.string().optional(),
  channel: z.string().optional(),
  from: z.string(),
  to: z.string(),
  text: z.string(),
  timestamp: z.string(),
  streamId: z.string(),
  /** Producer-side terminator — set when the runner won't emit a durable seal
   *  for this stream (validation failure, empty/hidden final text). Consumers
   *  drop the in-flight preview entry instead of upserting. */
  final: z.boolean().optional(),
});

export const HistoryPayload = z.object({
  type: z.literal('history'),
  entries: z.array(z.object({
    id: z.string(),
    type: z.string(),
    from_addr: z.string(),
    to_addr: z.string(),
    text: z.string(),
    timestamp: z.string(),
    session_hash: z.string().nullable(),
  })),
});

export const AttachmentAckPayload = z.object({
  type: z.literal('attachment_ack'),
  hash: z.string(),
  filename: z.string(),
  mimeType: z.string(),
});

export const ErrorPayload = z.object({
  type: z.literal('error'),
  text: z.string(),
});

export const TypingPayload = z.object({
  type: z.literal('typing'),
  agent: z.string().optional(),
  channel: z.string().optional(),
});

export const TypingStoppedPayload = z.object({
  type: z.literal('typing_stopped'),
  agent: z.string().optional(),
  channel: z.string().optional(),
});

export const LifecyclePhase = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('queued'), active: z.boolean() }),
  z.object({ phase: z.literal('bootstrap'), active: z.boolean() }),
  z.object({ phase: z.literal('auth_refresh'), active: z.boolean() }),
  z.object({
    phase: z.literal('compacting'),
    active: z.boolean(),
    preTokens: z.number().optional(),
    trigger: z.enum(['manual', 'auto']).optional(),
  }),
]);

export const LifecyclePayload = z.object({
  type: z.literal('lifecycle'),
  agent: z.string().optional(),
  channel: z.string().optional(),
  data: LifecyclePhase,
});

export const ApprovalStalePayload = z.object({
  type: z.literal('approval_stale'),
  agent: z.string().optional(),
  data: z.object({
    approvalId: z.string(),
    status: z.enum(['approved', 'rejected', 'expired']),
    summary: z.string(),
  }),
});

export const ApprovalRequestPayload = z.object({
  type: z.literal('approval_request'),
  id: z.string().optional(),
  agent: z.string().optional(),
  channel: z.string().optional(),
  from: z.string(),
  to: z.string(),
  text: z.string(),
  timestamp: z.string(),
  approvalId: z.string(),
  summary: z.string(),
  details: z.string().optional(),
  expiresAt: z.string().optional(),
  tiered: z.boolean().optional(),
});

export const ApprovalAckPayload = z.object({
  type: z.literal('approval_ack'),
  id: z.string().optional(),
  agent: z.string().optional(),
  channel: z.string().optional(),
  from: z.string(),
  to: z.string(),
  text: z.string(),
  timestamp: z.string(),
  approvalId: z.string(),
  decision: z.enum(['approved', 'rejected', 'expired']),
  summary: z.string(),
  reason: z.string().optional(),
  tier: z.enum(['once', 'always']).optional(),
});

export const ServerMessage = z.discriminatedUnion('type', [
  RegisterPayload,
  AgentsPayload,
  DiscoverPayload,
  MessagePayload,
  HistoryPayload,
  AttachmentAckPayload,
  ErrorPayload,
  TypingPayload,
  TypingStoppedPayload,
  LifecyclePayload,
  ApprovalStalePayload,
  ApprovalRequestPayload,
  ApprovalAckPayload,
  PreviewPayload,
]);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type RegisterPayload = z.infer<typeof RegisterPayload>;
export type AgentsPayload = z.infer<typeof AgentsPayload>;
export type DiscoverPayload = z.infer<typeof DiscoverPayload>;
export type MessagePayload = z.infer<typeof MessagePayload>;
export type HistoryPayload = z.infer<typeof HistoryPayload>;
export type AttachmentAckPayload = z.infer<typeof AttachmentAckPayload>;
export type ErrorPayload = z.infer<typeof ErrorPayload>;
export type TypingPayload = z.infer<typeof TypingPayload>;
export type TypingStoppedPayload = z.infer<typeof TypingStoppedPayload>;
export type LifecyclePhase = z.infer<typeof LifecyclePhase>;
export type LifecyclePayload = z.infer<typeof LifecyclePayload>;
export type ApprovalStalePayload = z.infer<typeof ApprovalStalePayload>;
export type ApprovalRequestPayload = z.infer<typeof ApprovalRequestPayload>;
export type ApprovalAckPayload = z.infer<typeof ApprovalAckPayload>;
export type PreviewPayload = z.infer<typeof PreviewPayload>;
export type ServerMessage = z.infer<typeof ServerMessage>;

export type Agent = AgentsPayload['list'][number];
export type DiscoverAgent = DiscoverPayload['list'][number];

// ---------------------------------------------------------------------------
// Binary frame header
// ---------------------------------------------------------------------------

export const BinaryFrameHeaderSchema = z.object({
  agent: z.string(),
  hash: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  direction: z.enum(['in', 'out']),
});

export type BinaryFrameHeader = z.infer<typeof BinaryFrameHeaderSchema>;
