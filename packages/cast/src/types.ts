import { z } from 'zod';

import type { UiDirective } from '@getcast/admin-schema/v1';

export interface Host {
  name: string;
  folder: string;
}

export interface NewMessage {
  id: string;
  address: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
}

export interface ScheduledTask {
  id: string;
  address: string;
  prompt: string;
  schedule_type: 'cron' | 'once';
  schedule_value: string;
  /** IANA timezone for cron expressions (e.g. 'America/New_York'). Null = UTC. */
  timezone: string | null;
  channel: string | null;
  /** Where task output should be routed (e.g. 'tg:12345', 'cli:user'). */
  target_participant: string | null;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'running' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
}

// --- Media attachments ---

/**
 * Attachment metadata schema — the shape that crosses the bus / persists in
 * gateway.db / agent.db. Binary `data` is intentionally NOT in the schema:
 * it lives only on the in-process path (transport → agent-manager) and is
 * stripped by `persistAttachment` before any serialization. Buffer doesn't
 * survive JSON, so cross-agent bus payloads carry hash + hostPath only.
 *
 * Zod parse on inbound bus payloads strips unknown keys by default — if a
 * future caller accidentally includes `data`, it will be silently dropped
 * (correct behavior; data has no meaning post-serialization).
 */
export const AttachmentSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  hostPath: z.string().optional(),
  filesize: z.number().optional(),
  hash: z.string().optional(),
});

export type Attachment = {
  filename: string;
  mimeType: string;
  /** Raw file data — present on inbound (transport → agent-manager), stripped after disk write. */
  data?: Buffer;
  /** Host-side file path — present after agent-manager writes to disk or outbound harvest. */
  hostPath?: string;
  /** File size in bytes. */
  filesize?: number;
  /** SHA-256 content hash — present after persist to attachment store. */
  hash?: string;
};

/** Attachment metadata stored in message/packet JSON columns. */
export interface AttachmentMeta {
  label: string;
  hash: string;
  mimeType: string;
  size: number;
}

// --- Packet types ---

export interface Packet {
  type: string;
  id?: string;
  from: string;
  to: string;
  text: string;
  timestamp: string;
  /** When set on a durable packet, this is the terminal frame of preview
   *  stream `<streamId>`. Transports use it to fold the final into the
   *  in-place preview bubble instead of posting a fresh message. */
  streamId?: string;
}

/** Conversation packet (participant ↔ agent). */
export interface ConversationPkt extends Packet {
  type: 'conversation';
  sessionHash?: string;
  attachments?: Attachment[];
}

/** Delegation packet (X tells agent Y to talk to Z). */
export interface DelegatePkt extends Packet {
  type: 'delegate';
  target: string;
  sessionHash?: string;
}

/** Approval request packet (agent → participant, requesting confirmation). */
export interface ApprovalRequestPkt extends Packet {
  type: 'approval_request';
  approvalId: string;
  summary: string;
  details?: string;
  expiresAt?: string;
}

/** Approval acknowledgment packet (agent → participant, confirming decision). */
export interface ApprovalAckPkt extends Packet {
  type: 'approval_ack';
  approvalId: string;
  decision: 'approved' | 'rejected' | 'expired';
  summary: string;
  reason?: string;
}

/** Ephemeral directed content — fourth corner of the packet/event matrix.
 *  Lives in the packet lane (single-recipient, ACL-gated) but skips
 *  persistence and gets per-`streamId` coalesce in the gateway. Discriminated
 *  on a nested `kind` field so future preview flavors (tool calls, progress)
 *  share the same predicate / gateway / ACL plumbing without growing
 *  AnyPacket. Mirrors the `LifecycleEvt`/`LifecyclePhase` pattern above. */
export interface PreviewPktBase extends Packet {
  type: 'preview';
  streamId: string;
  channel: string;
  /** Self-sufficient terminator — set when no durable companion is coming
   *  (e.g. `kind: 'progress'`). For `kind: 'text'` previews, the durable
   *  conversation packet with matching `streamId` serves as the terminator. */
  final?: boolean;
}

export type PreviewPkt =
  | (PreviewPktBase & { kind: 'text' })
  // future kinds — design-admitted, not implemented in v1:
  // | (PreviewPktBase & { kind: 'tool_call'; toolName: string; args: unknown })
  // | (PreviewPktBase & { kind: 'tool_output'; toolUseId: string; output: string })
  // | (PreviewPktBase & { kind: 'progress'; pct?: number; label: string })
  ;

export type AnyPacket = ConversationPkt | DelegatePkt | ApprovalRequestPkt | ApprovalAckPkt | PreviewPkt;

/** Default approval expiry in seconds (1 hour). */
export const DEFAULT_APPROVAL_EXPIRY = 3600;

/** Structured approval response from participant. */
export interface ApprovalResponsePayload {
  id: string;
  decision: 'approved' | 'rejected';
  reason?: string;
}

// --- Route result (returned by MessageBus.route()) ---

/**
 * Result of routing a message through the agent pipeline.
 *
 * `ok: true` covers both fire-and-forget acceptance (`result: null`) and
 * synchronous request/reply (`result: <agent text>`). The reply path is
 * exposed to in-process services via `routeMessage()` in agent-service-base.
 */
export type RouteResult =
  | { ok: true; result: string | null }
  | { ok: false; error: string };

// --- Event envelope ---

/** Common fields shared by all bus events. */
interface EvtBase {
  from: string;
  to: string;
}

/** Agent is actively producing output. */
export interface TypingEvt extends EvtBase {
  type: 'typing';
  data: { channel: string };
}

/** Agent has stopped producing output (final message sent). */
export interface TypingStoppedEvt extends EvtBase {
  type: 'typing_stopped';
  data: { channel: string };
}

/** Lifecycle phase variants — discriminated by `phase`.
 *
 * `fresh_conversation` fires once per spawn that starts without an SDK
 * resume id (i.e. the LLM has no prior turns). True on the first spawn for
 * any conversation key (agent or console); subsequent spawns resume the
 * stored ccSessionId. Lets transports surface the boundary post-hoc — not a
 * queueable signal, so subscribers must already be connected to receive it.
 *
 * `channel` is the runner's channel name, included so multi-channel
 * transports (ConsoleTransport hosts per-agent subscribers split by
 * `__design` / `__configure`) can scope-filter the same way they do
 * typing events. */
export type LifecyclePhase =
  | { phase: 'queued'; active: boolean; channel: string }
  | { phase: 'bootstrap' | 'auth_refresh'; active: boolean; channel: string }
  | { phase: 'compacting'; active: boolean; channel: string; preTokens?: number; trigger?: 'manual' | 'auto' }
  | { phase: 'fresh_conversation'; channel: string };

/** Conversation lifecycle transitions (queue, bootstrap, compaction, auth refresh). */
export interface LifecycleEvt extends EvtBase {
  type: 'lifecycle';
  data: LifecyclePhase;
}

/** Late approval response — the request was already resolved or expired. */
export interface ApprovalStaleEvt extends EvtBase {
  type: 'approval_stale';
  data: { approvalId: string; status: 'approved' | 'rejected' | 'expired' | 'interrupted'; summary: string };
}

/** Structured intent for the operator's admin UI. Only meaningful to
 *  transports that render into a browser (console SSE); other transports
 *  render a plain-text fallback line. The directive shape is the SSOT in
 *  `@getcast/admin-schema/v1` — see `UiDirective`. */
export interface UiDirectiveEvt extends EvtBase {
  type: 'ui_directive';
  data: {
    channel: string;
    directive: UiDirective;
  };
}

/** Server-side ack: gateway accepted and persisted an inbound message.
 *  Transient signal — not persisted. Each transport decides how to render. */
export interface MessageReceivedEvt extends EvtBase {
  type: 'message_received';
  data: { id: string; channel: string; timestamp: string };
}

/** Ephemeral event routed through the bus. Discriminated by `type`. */
export type Evt =
  | TypingEvt
  | TypingStoppedEvt
  | LifecycleEvt
  | ApprovalStaleEvt
  | UiDirectiveEvt
  | MessageReceivedEvt;

// --- Transport abstraction ---
//
// `Transport` and `OutboundContext` live in `./transports/schema.ts` — see
// `defineTransport({...})` and the registry there.
