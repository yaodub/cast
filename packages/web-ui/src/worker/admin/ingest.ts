/**
 * Admin wire-frame router. Parses every JSON frame off the admin WS at the
 * worker boundary (validate at edges, trust internally) and dispatches:
 *
 *   - `envelope` packets → ChatMessage validation, IDB persist, per-target
 *     cache append, `admin-target` snapshot mutation.
 *   - `envelope` transients (typing/typing_stopped/lifecycle/ui_directive/
 *     message_received) → fan as `scoped-event` to subscribers of the
 *     `admin-target` scope. No state mutation.
 *   - `envelope` lifecycle (agent_added/agent_removed) → mutate
 *     `adminGlobal.initialAgents`, broadcast `admin-global` mutation.
 *   - `ready` / `shutdown` → mutate `adminGlobal`, broadcast `admin-global`.
 */

import { z } from 'zod';

import {
  adminGlobal,
  broadcastMutation,
  broadcastScopedEvent,
  ensureAdminTargetCache,
  store,
} from '../state';
import {
  AdminWireFrame,
  type AdminChatMessage,
  type AdminTarget,
} from '../protocol';

/**
 * Schema for the `event === 'packet'` payload — looser than `AdminChatMessage`
 * so we can capture and explicitly drop null-id packets at the worker boundary
 * (preserves the diagnostic from the prior tab-side dispatcher).
 */
const AdminPacketPayloadSchema = z.object({
  id: z.string().nullable(),
  type: z.string(),
  from: z.string(),
  to: z.string(),
  text: z.string(),
  timestamp: z.string(),
  sessionHash: z.string().nullable().optional(),
  /** Present when this durable packet terminates a preview stream. Used to
   *  seal-clear the matching entry in the per-target previews map. */
  streamId: z.string().optional(),
});

const AdminPreviewPayloadSchema = z.object({
  streamId: z.string(),
  from: z.string(),
  to: z.string(),
  text: z.string(),
  timestamp: z.string(),
  /** Producer-side terminator — set when the runner won't emit a durable seal
   *  for this stream (validation failure, empty/hidden final text). Consumers
   *  drop the in-flight preview entry instead of upserting. */
  final: z.boolean().optional(),
});

const TRANSIENT_EVENTS = new Set([
  'typing',
  'typing_stopped',
  'lifecycle',
  'ui_directive',
  'message_received',
]);

/** Entry point — parse + route a single raw frame from the admin WS. */
export async function ingestAdminFrame(raw: unknown): Promise<void> {
  const result = AdminWireFrame.safeParse(raw);
  if (!result.success) {
    console.warn('[worker/admin] dropping malformed wire frame', { issues: result.error.issues });
    return;
  }
  const frame = result.data;
  switch (frame.type) {
    case 'ready':
      adminGlobal.initialAgents = frame.agents;
      adminGlobal.connectionState = 'open';
      adminGlobal.serverShutdownReason = null;
      broadcastMutation({ kind: 'admin-global' });
      return;

    case 'shutdown':
      adminGlobal.serverShutdownReason = frame.reason;
      // Connection state stays at 'open' until the socket actually closes —
      // the WebSocketTransport's onState callback flips us to 'reconnecting'
      // when that happens. The reason banner is sticky until the next 'ready'.
      broadcastMutation({ kind: 'admin-global' });
      return;

    case 'envelope':
      await dispatchEnvelope(frame);
      return;
  }
}

async function dispatchEnvelope(frame: Extract<AdminWireFrame, { type: 'envelope' }>): Promise<void> {
  if (frame.target.kind === 'lifecycle') {
    // TS limitation: z.union doesn't propagate the lifecycle variant's
    // narrower `data` shape after narrowing on `target.kind`. The Zod parse
    // already validated this shape per AdminWireLifecycleEnvelope.
    const data = frame.data as { alias?: string; address: string };
    if (frame.event === 'agent_added' && data.alias) {
      const alias = data.alias;
      const address = data.address;
      // Idempotent — if already present, no-op.
      if (!adminGlobal.initialAgents.some((a) => a.address === address)) {
        adminGlobal.initialAgents = [...adminGlobal.initialAgents, { alias, address }];
        broadcastMutation({ kind: 'admin-global' });
      }
    } else if (frame.event === 'agent_removed') {
      const address = data.address;
      const next = adminGlobal.initialAgents.filter((a) => a.address !== address);
      if (next.length !== adminGlobal.initialAgents.length) {
        adminGlobal.initialAgents = next;
        broadcastMutation({ kind: 'admin-global' });
      }
    }
    return;
  }

  // Agent or manager target — narrow into the AdminTarget shape used by scopes
  // and caches. The wire shape and the protocol shape match exactly today.
  const target: AdminTarget = frame.target;
  const scope = { kind: 'admin-target' as const, target };

  if (frame.event === 'preview') {
    const parsed = AdminPreviewPayloadSchema.safeParse(frame.data);
    if (!parsed.success) {
      console.warn('[worker/admin] preview parse failed', { issues: parsed.error.issues });
      return;
    }
    const cache = ensureAdminTargetCache(target);
    if (parsed.data.final) {
      cache.previews.delete(parsed.data.streamId);
    } else {
      // Preserve firstSeenAt across chunks — see ConversationCache.previews docs.
      const existing = cache.previews.get(parsed.data.streamId);
      cache.previews.set(parsed.data.streamId, {
        text: parsed.data.text,
        from: parsed.data.from,
        firstSeenAt: existing?.firstSeenAt ?? parsed.data.timestamp,
      });
    }
    broadcastMutation(scope);
    return;
  }

  if (frame.event === 'packet') {
    const parsed = AdminPacketPayloadSchema.safeParse(frame.data);
    if (!parsed.success) {
      console.warn('[worker/admin] packet parse failed', { issues: parsed.error.issues });
      return;
    }
    if (parsed.data.id === null) {
      console.warn('[worker/admin] dropping packet with null id', { target });
      return;
    }
    // Seal-inherit: a durable packet terminating a preview stream takes the
    // stream's first-seen timestamp instead of the seal-time stamp. Holds the
    // bubble in its chronological position relative to messages that arrived
    // mid-stream.
    const streamStart = parsed.data.streamId
      ? ensureAdminTargetCache(target).previews.get(parsed.data.streamId)?.firstSeenAt
      : undefined;
    const msg: AdminChatMessage = {
      id: parsed.data.id,
      type: parsed.data.type,
      from: parsed.data.from,
      to: parsed.data.to,
      text: parsed.data.text,
      timestamp: streamStart ?? parsed.data.timestamp,
      sessionHash: parsed.data.sessionHash ?? null,
      ...(parsed.data.streamId ? { streamId: parsed.data.streamId } : {}),
    };
    await appendAndPersist(target, msg);
    broadcastMutation(scope);
    return;
  }

  if (TRANSIENT_EVENTS.has(frame.event)) {
    broadcastScopedEvent(scope, frame.event, frame.data);
    return;
  }

  // Unknown event — forward as scoped-event so future server-side additions
  // surface in the UI without a worker code change. Logged once for visibility.
  console.info('[worker/admin] unknown event forwarded as scoped-event', { event: frame.event });
  broadcastScopedEvent(scope, frame.event, frame.data);
}

async function appendAndPersist(target: AdminTarget, msg: AdminChatMessage): Promise<void> {
  const cache = ensureAdminTargetCache(target);
  // Seal-clear: a durable packet carrying streamId terminates the matching
  // preview stream. Removing the preview entry BEFORE pushing the message
  // means the single broadcastMutation issued by the caller covers both
  // sides of the transition — no double-render at seal.
  if (msg.streamId) cache.previews.delete(msg.streamId);
  if (cache.messages.some((m) => m.id === msg.id)) {
    // Already in cache (typically a delivery race after an echo) — still
    // ensure IDB has it; the cache append is the dedup gate.
    await persist(target, msg);
    return;
  }
  cache.messages.push(msg);
  await persist(target, msg);
}

async function persist(target: AdminTarget, msg: AdminChatMessage): Promise<void> {
  const already = await store.hasAdmin(msg.id).catch(() => false);
  if (already) return;
  await store.putAdmin(target, msg).catch((err) => {
    console.warn('[worker/admin] putAdmin failed', { err, target, id: msg.id });
  });
}
