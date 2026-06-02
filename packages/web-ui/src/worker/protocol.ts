/**
 * Worker ↔ tab IPC protocol — Zod is the single source of truth.
 *
 * This is the protocol between the SharedWorker (single owner of WS / SSE /
 * IndexedDB / dedup state) and a tab. It is intentionally distinct from
 * `lib/protocol.ts`, which is the Cast server WS wire format. A tab never
 * speaks the wire protocol directly; it dispatches `Action`s to the worker
 * and renders `Scope` projections from the worker.
 *
 * Multi-identity is first-class: every `Action` and every `Scope` carry the
 * identity they apply to. The worker dispatches each action to the matching
 * `ConnectionState` in its `Map<identity, ConnectionState>`.
 *
 * Future split: when the worker eventually moves to a networked persistence
 * service, this protocol carries verbatim across the wire — `MessagePort`
 * postMessage becomes a JSON frame on a WebSocket; `Transferable` payloads
 * (attachment bytes) become binary-after-header frames. Nothing in this
 * protocol is `MessagePort`-specific.
 */
import { z } from 'zod';

import { SERVER_SCOPE_TARGETS } from '@getcast/admin-schema/v1';

import { AgentsPayload, DiscoverPayload } from '../lib/protocol';

// ---------------------------------------------------------------------------
// Shared atoms (re-used across actions and snapshots)
// ---------------------------------------------------------------------------

const Identity = z.string().min(1).describe('Cast handle, e.g. "web:abc123"');

const MessageAttachment = z.object({
  filename: z.string(),
  mimeType: z.string(),
  hash: z.string().optional(),
});

/** Discriminated metadata union — drives special rendering in MessageBubble. */
const MessageMeta = z.union([
  z.object({
    type: z.literal('approval_request'),
    approvalId: z.string(),
    summary: z.string(),
    details: z.string().optional(),
    expiresAt: z.string().optional(),
  }),
  z.object({
    type: z.literal('approval_ack'),
    approvalId: z.string(),
    summary: z.string(),
    decision: z.enum(['approved', 'rejected', 'expired']),
    reason: z.string().optional(),
  }),
]);

const StoredMessage = z.object({
  id: z.string(),
  identity: Identity,
  agent: z.string(),
  channel: z.string(),
  from: z.string(),
  to: z.string(),
  text: z.string(),
  timestamp: z.string(),
  sessionHash: z.string().nullable(),
  attachments: z.array(MessageAttachment).optional(),
  /** Structured metadata for special rendering. Absent = normal message. */
  meta: MessageMeta.optional(),
  /**
   * Coarse message-class tag — used by the admin console transcript to
   * discriminate `conversation` from `divider:*` synthetic rows. Optional;
   * the user chat surface ignores it (uses `meta` for special rendering).
   */
  type: z.string().optional(),
  /** Set when this message sealed a preview stream — lets ChatArea unify the in-flight bubble with the sealed one. */
  streamId: z.string().optional(),
});

const Toast = z.object({
  id: z.string(),
  agent: z.string(),
  channel: z.string(),
  from: z.string(),
  preview: z.string(),
  timestamp: z.string(),
});

const ChatPhase = z.enum(['register', 'connecting', 'main']);

const ConnectionState = z.enum(['connecting', 'connected', 'disconnected']);

const AdminTarget = z.union([
  z.object({
    kind: z.literal('agent'),
    alias: z.string(),
    channel: z.enum(['__design', '__configure']),
  }),
  z.object({
    kind: z.literal('manager'),
    slug: z.enum(SERVER_SCOPE_TARGETS),
  }),
]);

const AdminChatMessage = z.object({
  id: z.string(),
  type: z.string(),
  from: z.string(),
  to: z.string(),
  text: z.string(),
  timestamp: z.string(),
  sessionHash: z.string().nullable().optional(),
  /** Present when this durable message terminates a preview stream. The unified
   *  admin render list keys streaming items by `stream-${streamId}` so the
   *  seal-arrival transition is a same-key prop change. */
  streamId: z.string().optional(),
}).passthrough();

const AttachmentDraft = z.object({
  clientId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  bytes: z.instanceof(Uint8Array),
});

// ---------------------------------------------------------------------------
// Scope union — what a tab can subscribe to
// ---------------------------------------------------------------------------

const ChatIdentityScope = z.object({
  kind: z.literal('chat-identity'),
  identity: Identity,
});

const ChatConversationScope = z.object({
  kind: z.literal('chat-conversation'),
  identity: Identity,
  agent: z.string(),
  channel: z.string(),
});

const AdminGlobalScope = z.object({
  kind: z.literal('admin-global'),
});

const AdminTargetScope = z.object({
  kind: z.literal('admin-target'),
  target: AdminTarget,
});

export const Scope = z.discriminatedUnion('kind', [
  ChatIdentityScope,
  ChatConversationScope,
  AdminGlobalScope,
  AdminTargetScope,
]);

// ---------------------------------------------------------------------------
// Snapshots — initial state pushed on subscribe + on every mutation
//
// Mutation strategy: full snapshot replacement on every change. Simple,
// deterministic, no merge logic in the tab. Wire cost is non-trivial
// for long message arrays; tracked as a future optimization (delta union)
// when profiling justifies it.
// ---------------------------------------------------------------------------

const ChatIdentitySnapshot = z.object({
  phase: ChatPhase,
  agents: AgentsPayload.shape.list,
  discovered: DiscoverPayload.shape.list,
  unread: z.record(z.string(), z.number()),
  toasts: z.array(Toast),
  error: z.string().nullable(),
  connectionState: ConnectionState,
});

const ChatConversationSnapshot = z.object({
  messages: z.array(StoredMessage),
  typing: z.boolean(),
  lifecycle: z.string().nullable(),
  /** In-flight preview streams. Each entry's text supersedes earlier ticks; cleared on durable seal.
   *  `timestamp` is the stream's first-seen instant — preserved across chunks so the bubble
   *  holds its chronological position while other messages arrive. */
  previews: z.array(z.object({
    streamId: z.string(),
    text: z.string(),
    timestamp: z.string(),
  })),
});

const AdminGlobalSnapshot = z.object({
  initialAgents: z.array(z.object({
    alias: z.string(),
    address: z.string(),
  })),
  connectionState: z.enum(['connecting', 'open', 'reconnecting']),
  serverShutdownReason: z.string().nullable(),
});

const AdminTargetSnapshot = z.object({
  messages: z.array(AdminChatMessage),
  /** In-flight preview streams for this target. Mirrors the chat-conversation
   *  snapshot shape so the unified render list logic transfers cleanly.
   *  `timestamp` is the stream's first-seen instant. */
  previews: z.array(z.object({
    streamId: z.string(),
    text: z.string(),
    from: z.string(),
    timestamp: z.string(),
  })),
});

const Snapshot = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat-identity'), data: ChatIdentitySnapshot }),
  z.object({ kind: z.literal('chat-conversation'), data: ChatConversationSnapshot }),
  z.object({ kind: z.literal('admin-global'), data: AdminGlobalSnapshot }),
  z.object({ kind: z.literal('admin-target'), data: AdminTargetSnapshot }),
]);

// ---------------------------------------------------------------------------
// Action union — what a tab can dispatch
//
// Every action that affects per-identity state carries `identity`. The worker
// dispatches to the matching `ConnectionState`; identity-not-bound returns a
// failure ack so the tab can re-register cleanly.
// ---------------------------------------------------------------------------

/**
 * Fresh-registration flow: the worker opens a temporary WS (no identity bound),
 * sends `register`, awaits the response, then closes the temp WS. The new
 * identity is returned in the action's ack `result`. The tab adds it to its
 * identity store and navigates to its URL, which triggers a fresh subscribe
 * cycle — the persistent ConnectionState is created implicitly by that
 * subscription, not by an explicit connect call.
 */
const RegisterIdentityAction = z.object({
  kind: z.literal('register-identity'),
  name: z.string().min(1),
});

const SendMessageAction = z.object({
  kind: z.literal('send-message'),
  identity: Identity,
  agent: z.string(),
  channel: z.string(),
  text: z.string(),
  /** Tab-generated ID; worker echoes in the optimistic mutation so tabs can correlate UI state. */
  clientMsgId: z.string(),
  /** Inline file payloads. Worker handles the binary-frame WS send + ack collection + IDB cache. */
  attachments: z.array(AttachmentDraft).optional(),
});

const RespondToApprovalAction = z.object({
  kind: z.literal('respond-to-approval'),
  identity: Identity,
  agent: z.string(),
  approvalId: z.string(),
  decision: z.enum(['approved', 'rejected']),
});

const ExplainApprovalAction = z.object({
  kind: z.literal('explain-approval'),
  identity: Identity,
  agent: z.string(),
  channel: z.string(),
  approvalId: z.string(),
  summary: z.string(),
});

const RefreshAgentsAction = z.object({
  kind: z.literal('refresh-agents'),
  identity: Identity,
});

const RefreshDiscoverAction = z.object({
  kind: z.literal('refresh-discover'),
  identity: Identity,
});

const DismissToastAction = z.object({
  kind: z.literal('dismiss-toast'),
  identity: Identity,
  toastId: z.string(),
});

const GetAttachmentAction = z.object({
  kind: z.literal('get-attachment'),
  hash: z.string(),
});

const ConnectAdminAction = z.object({
  kind: z.literal('connect-admin'),
  /**
   * Operator Bearer token. Required — the admin WS handler authenticates
   * via `?token=<bearer>` query string (browsers can't set headers on
   * WebSocket). The 127.0.0.1 server bind keeps the token from leaking.
   */
  bearer: z.string().min(1),
});

const DisconnectAdminAction = z.object({
  kind: z.literal('disconnect-admin'),
});

const WriteEchoAction = z.object({
  kind: z.literal('write-echo'),
  target: AdminTarget,
  msg: AdminChatMessage,
});

const WriteEchoBeforeLastAction = z.object({
  kind: z.literal('write-echo-before-last'),
  target: AdminTarget,
  msg: AdminChatMessage,
});

const RollbackEchoAction = z.object({
  kind: z.literal('rollback-echo'),
  target: AdminTarget,
  echoId: z.string(),
});

const MarkAdminTargetReadAction = z.object({
  kind: z.literal('mark-admin-target-read'),
  target: AdminTarget,
});

export const Action = z.discriminatedUnion('kind', [
  RegisterIdentityAction,
  SendMessageAction,
  RespondToApprovalAction,
  ExplainApprovalAction,
  RefreshAgentsAction,
  RefreshDiscoverAction,
  DismissToastAction,
  GetAttachmentAction,
  ConnectAdminAction,
  DisconnectAdminAction,
  WriteEchoAction,
  WriteEchoBeforeLastAction,
  RollbackEchoAction,
  MarkAdminTargetReadAction,
]);

// ---------------------------------------------------------------------------
// Action result shapes — typed payload on successful ack
// ---------------------------------------------------------------------------

const RegisterIdentityResult = z.object({
  identity: Identity,
  identityId: z.string(),
  name: z.string(),
});

const GetAttachmentResult = z.union([
  z.null(),
  z.object({
    blob: z.instanceof(Uint8Array),
    mimeType: z.string(),
    filename: z.string(),
  }),
]);

const SendMessageResult = z.object({
  /** Server-assigned attachment hashes, in submission order. Empty if no attachments. */
  attachmentHashes: z.array(z.object({
    clientId: z.string(),
    hash: z.string(),
    filename: z.string(),
    mimeType: z.string(),
  })),
});

// ---------------------------------------------------------------------------
// Ambient events — pushed without a request, e.g. lifecycle changes
// ---------------------------------------------------------------------------

export const WorkerEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('identity-registered'),
    identity: Identity,
    identityId: z.string(),
    name: z.string(),
  }),
  z.object({
    kind: z.literal('identity-removed'),
    identity: Identity,
    /** Source tab — receivers ignore if it's their own remove. */
    source: z.string().optional(),
  }),
  z.object({
    kind: z.literal('chat-connection-state'),
    identity: Identity,
    state: ConnectionState,
  }),
  z.object({
    kind: z.literal('admin-connection-state'),
    state: z.enum(['connecting', 'open', 'reconnecting', 'shutdown']),
    reason: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('error'),
    /** Origin of the error — `'global'` for worker-internal; `'identity:<handle>'` for identity-scoped. */
    origin: z.string(),
    message: z.string(),
  }),
]);

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/** Tab → worker frames. */
export const TabToWorker = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('subscribe'),
    requestId: z.string(),
    scope: Scope,
  }),
  z.object({
    kind: z.literal('unsubscribe'),
    scope: Scope,
  }),
  z.object({
    kind: z.literal('action'),
    requestId: z.string(),
    action: Action,
  }),
  z.object({
    kind: z.literal('hello'),
    /** Tab identifier (random per page-load). Used for ambient-event source tagging. */
    tabId: z.string(),
  }),
]);

/** Worker → tab frames. */
export const WorkerToTab = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('snapshot'),
    scope: Scope,
    snapshot: Snapshot,
  }),
  z.object({
    kind: z.literal('mutation'),
    scope: Scope,
    snapshot: Snapshot,
  }),
  /**
   * Transient signal scoped to a subscription. Not persisted; not part of the
   * snapshot. Used for admin `typing` / `typing_stopped` / `lifecycle` /
   * `ui_directive` / `message_received` events that drive UI state outside
   * the canonical message list. Tab consumes via `subscribe(scope, onSnapshot, onEvent)`.
   */
  z.object({
    kind: z.literal('scoped-event'),
    scope: Scope,
    event: z.string(),
    data: z.unknown(),
  }),
  /**
   * Action ack — one frame shape for both outcomes. `ok=true` carries an
   * optional `result` (action-specific), `ok=false` carries an `error`
   * string. Zod 4's discriminatedUnion forbids two options sharing the
   * same discriminator (`kind: 'ack'`), so the success/failure split lives
   * inside the shape rather than as sibling variants. Consumer narrowing
   * on `frame.ok` decides which field to read.
   */
  z.object({
    kind: z.literal('ack'),
    requestId: z.string(),
    ok: z.boolean(),
    /** Action-specific result — present when `ok === true`. */
    result: z.unknown().optional(),
    /** Error message — present when `ok === false`. */
    error: z.string().optional(),
  }),
  z.object({
    kind: z.literal('event'),
    event: WorkerEvent,
  }),
  z.object({
    kind: z.literal('hello-ack'),
    /** Worker code version stamp — logged on every connect so stale dev-HMR is obvious. */
    workerVersion: z.string(),
  }),
]);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Identity = z.infer<typeof Identity>;
export type MessageAttachment = z.infer<typeof MessageAttachment>;
export type MessageMeta = z.infer<typeof MessageMeta>;
export type StoredMessage = z.infer<typeof StoredMessage>;
export type Toast = z.infer<typeof Toast>;
export type ChatPhase = z.infer<typeof ChatPhase>;
export type ConnectionState = z.infer<typeof ConnectionState>;
export type AdminTarget = z.infer<typeof AdminTarget>;
export type AdminChatMessage = z.infer<typeof AdminChatMessage>;
export type AttachmentDraft = z.infer<typeof AttachmentDraft>;

export type ChatIdentityScope = z.infer<typeof ChatIdentityScope>;
export type ChatConversationScope = z.infer<typeof ChatConversationScope>;
export type AdminGlobalScope = z.infer<typeof AdminGlobalScope>;
export type AdminTargetScope = z.infer<typeof AdminTargetScope>;
export type Scope = z.infer<typeof Scope>;

export type ChatIdentitySnapshot = z.infer<typeof ChatIdentitySnapshot>;
export type ChatConversationSnapshot = z.infer<typeof ChatConversationSnapshot>;
export type AdminGlobalSnapshot = z.infer<typeof AdminGlobalSnapshot>;
export type AdminTargetSnapshot = z.infer<typeof AdminTargetSnapshot>;
export type Snapshot = z.infer<typeof Snapshot>;

export type Action = z.infer<typeof Action>;
export type RegisterIdentityResult = z.infer<typeof RegisterIdentityResult>;
export type GetAttachmentResult = z.infer<typeof GetAttachmentResult>;
export type SendMessageResult = z.infer<typeof SendMessageResult>;

export type WorkerEvent = z.infer<typeof WorkerEvent>;
export type TabToWorker = z.infer<typeof TabToWorker>;
export type WorkerToTab = z.infer<typeof WorkerToTab>;

// ---------------------------------------------------------------------------
// Admin server WS wire format — what the worker reads off `/api/admin/events`
//
// Server-side definition mirrored at `packages/cast/src/admin/ws-events.ts`
// (`WireFrame` type). Validated at the worker boundary (validate at edges,
// trust internally) before being routed to scopes.
// ---------------------------------------------------------------------------

const AdminWireAgentEnvelope = z.object({
  type: z.literal('envelope'),
  target: z.object({
    kind: z.literal('agent'),
    alias: z.string(),
    channel: z.enum(['__design', '__configure']),
  }),
  event: z.string(),
  data: z.unknown(),
});

const AdminWireManagerEnvelope = z.object({
  type: z.literal('envelope'),
  target: z.object({
    kind: z.literal('manager'),
    slug: z.enum(SERVER_SCOPE_TARGETS),
  }),
  event: z.string(),
  data: z.unknown(),
});

const AdminWireLifecycleEnvelope = z.object({
  type: z.literal('envelope'),
  target: z.object({ kind: z.literal('lifecycle') }),
  event: z.enum(['agent_added', 'agent_removed']),
  data: z.object({ alias: z.string().optional(), address: z.string() }),
});

const AdminWireReady = z.object({
  type: z.literal('ready'),
  agents: z.array(z.object({ alias: z.string(), address: z.string() })),
  managers: z.array(z.enum(SERVER_SCOPE_TARGETS)),
});

const AdminWireShutdown = z.object({
  type: z.literal('shutdown'),
  reason: z.string(),
});

export const AdminWireFrame = z.union([
  AdminWireAgentEnvelope,
  AdminWireManagerEnvelope,
  AdminWireLifecycleEnvelope,
  AdminWireReady,
  AdminWireShutdown,
]);

export type AdminWireFrame = z.infer<typeof AdminWireFrame>;

// ---------------------------------------------------------------------------
// Scope key — stable string identifier for indexing subscription registries
// ---------------------------------------------------------------------------

/** Stable, JSON-free key for routing subscriptions in the worker's registry. */
export function scopeKey(scope: Scope): string {
  switch (scope.kind) {
    case 'chat-identity':
      return `chat-identity:${scope.identity}`;
    case 'chat-conversation':
      return `chat-conversation:${scope.identity}:${scope.agent}:${scope.channel}`;
    case 'admin-global':
      return 'admin-global';
    case 'admin-target': {
      const t = scope.target;
      return t.kind === 'agent'
        ? `admin-target:agent:${t.alias}:${t.channel}`
        : `admin-target:manager:${t.slug}`;
    }
  }
}

/**
 * Identity associated with a scope, if any. Used by the worker to route
 * subscription requests to the correct ConnectionState.
 */
export function scopeIdentity(scope: Scope): Identity | null {
  switch (scope.kind) {
    case 'chat-identity':
    case 'chat-conversation':
      return scope.identity;
    case 'admin-global':
    case 'admin-target':
      return null;
  }
}
