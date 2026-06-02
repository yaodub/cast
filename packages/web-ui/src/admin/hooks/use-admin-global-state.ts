/**
 * useAdminGlobalState — thin tab-side facade. The persistence SharedWorker
 * owns the authoritative per-target message store and IDB persistence; this
 * module only:
 *
 *   - Drives the per-tab unread tracker (`chat-unread.ts` localStorage layer)
 *     by watching admin-target snapshots for new non-operator message ids
 *     and bumping unread when the new arrival's target isn't currently
 *     active. Unread state is intentionally tab-side: localStorage + the
 *     `storage` event give us free cross-tab parity that a worker-side
 *     counter would have to re-engineer.
 *   - Re-exports `useTargetMessages(target)` as a worker-subscribe
 *     projection — chat hooks read messages exclusively from here.
 *   - Routes `writeEcho` / `writeEchoBeforeLast` / `rollbackEcho` to worker
 *     actions so optimistic state mutations land in the worker's per-target
 *     cache (visible to every tab) and persist to IDB through the worker.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { ServerScopeTarget } from '@getcast/admin-schema/v1';

import { worker } from '../../lib/worker-client';
import type {
  AdminChatMessage,
  AdminTargetSnapshot,
} from '../../worker/protocol';
import {
  hasUnreadSince,
  markUnread,
  newestBadgeworthyTimestamp,
  readReadCursor,
  writeReadCursor,
} from '../lib/chat-unread';
import type { ChatMessage } from './use-admin-chat';
import type { Target } from './use-admin-event-stream';

const MANAGER_SLUGS: ServerScopeTarget[] = ['design-manager', 'config-manager', 'security-manager'];
const AGENT_CHANNELS = ['__design', '__configure'] as const;
/** Baseline read-cursor for a target seen for the first time with no real
 *  messages yet — any later message sorts after it, so the first arrival
 *  flags unread. */
const EPOCH = '1970-01-01T00:00:00.000Z';

function targetKey(target: Target): string {
  return target.kind === 'agent'
    ? `agent:${target.alias}:${target.channel}`
    : `manager:${target.slug}`;
}

function sameTarget(a: Target | null, b: Target): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'agent' && b.kind === 'agent') {
    return a.alias === b.alias && a.channel === b.channel;
  }
  if (a.kind === 'manager' && b.kind === 'manager') {
    return a.slug === b.slug;
  }
  return false;
}

// --- Public mutation API (delegates to worker actions) ----------------------

/**
 * Optimistic echo or operator-injected message (e.g. a `divider:fresh_conversation`
 * row). The worker appends to its per-target cache + persists to IDB and
 * broadcasts the resulting mutation to every subscribed tab. Caller supplies
 * a stable id; for echoes use `echo-<uuid>`, replaced server-side by the real
 * pktId on next WS delivery (dedup by id keeps us coherent).
 *
 * Fire-and-forget — failures only surface as console warnings. The send-
 * message HTTP POST is the source of truth for delivery; this is just the
 * optimistic-render path.
 */
export function writeEcho(target: Target, msg: ChatMessage): void {
  if (msg.id === null) return;
  void worker.send({
    kind: 'write-echo',
    target,
    msg: msg as AdminChatMessage,
  }).catch((err) => {
    console.warn('[admin-global-state] write-echo failed', err);
  });
}

/**
 * Like `writeEcho`, but splices the message in *before* the last existing
 * row and backdates its timestamp to `lastMsg.timestamp - 1ms`. Used for
 * the `fresh_conversation` divider, which is fired *after* the operator
 * message that triggered it but conceptually precedes that message.
 *
 * Backdating keeps the order stable across IDB rehydration (worker-side
 * `mergeById` sorts by timestamp).
 */
export function writeEchoBeforeLast(target: Target, msg: ChatMessage): void {
  if (msg.id === null) return;
  void worker.send({
    kind: 'write-echo-before-last',
    target,
    msg: msg as AdminChatMessage,
  }).catch((err) => {
    console.warn('[admin-global-state] write-echo-before-last failed', err);
  });
}

/** Roll back an echo whose POST failed. Idempotent — no-op if not present. */
export function rollbackEcho(target: Target, echoId: string): void {
  void worker.send({
    kind: 'rollback-echo',
    target,
    echoId,
  }).catch((err) => {
    console.warn('[admin-global-state] rollback-echo failed', err);
  });
}

// --- Layout-level hook (mounted once) --------------------------------------

interface GlobalStateOptions {
  /** Current agent aliases (e.g. from tRPC `agent.list`). */
  aliases: string[];
  /** Target currently being viewed by the operator, or null if none. */
  activeTarget: Target | null;
}

/**
 * Subscribes to every (alias, channel) and manager admin-target so packets
 * landing on inactive targets light their unread badge. Unread is computed
 * against a *persisted* per-target read-cursor (the newest timestamp the
 * operator has seen as read), not a volatile per-mount "seen ids" set: a
 * message that arrives while this tracker is unmounted (operator on /chat/)
 * is flagged unread on return rather than re-seeded as history. The cursor
 * model also removes the churn where adding/removing an agent reset every
 * target's seed.
 *
 * Operator echoes (`from` starts with `local/`) and synthetic dividers are
 * never badge-worthy.
 */
export function useAdminGlobalState({ aliases, activeTarget }: GlobalStateOptions): void {
  const activeTargetRef = useRef(activeTarget);
  activeTargetRef.current = activeTarget;

  // Newest badge-worthy message timestamp seen per target key. Lets the
  // active-target effect advance the read-cursor when a chat is focused even
  // if no new snapshot fires (operator opened a chat and read existing rows).
  const newestByTargetRef = useRef<Map<string, string>>(new Map());

  // Stable key so the subscription effect doesn't churn on every render.
  const aliasesKey = useMemo(() => aliases.slice().sort().join(','), [aliases]);

  useEffect(() => {
    const sortedAliases = aliasesKey ? aliasesKey.split(',') : [];
    const targets: Target[] = [];
    for (const slug of MANAGER_SLUGS) targets.push({ kind: 'manager', slug });
    for (const alias of sortedAliases) {
      for (const channel of AGENT_CHANNELS) targets.push({ kind: 'agent', alias, channel });
    }

    const disposers: Array<() => void> = [];
    for (const target of targets) {
      const key = targetKey(target);
      const dispose = worker.subscribe(
        { kind: 'admin-target', target },
        (data: AdminTargetSnapshot) => {
          const newest = newestBadgeworthyTimestamp(data.messages);
          if (newest) newestByTargetRef.current.set(key, newest);

          if (sameTarget(activeTargetRef.current, target)) {
            // Operator is viewing this target — everything in it is read.
            if (newest) writeReadCursor(target, newest);
            markUnread(target, false);
            return;
          }

          const cursor = readReadCursor(target);
          if (cursor === null) {
            // First sight of this target: treat current history as read so a
            // fresh load doesn't light up every badge. Persisting the cursor
            // means a later remount computes against this baseline rather than
            // re-seeding (the bug this replaces).
            writeReadCursor(target, newest || EPOCH);
            markUnread(target, false);
            return;
          }

          // Unread iff a badge-worthy message arrived after the operator last
          // read this target.
          markUnread(target, hasUnreadSince(data.messages, cursor));
        },
      );
      disposers.push(dispose);
    }

    return () => {
      for (const d of disposers) d();
    };
  }, [aliasesKey]);

  // Mark the active target read whenever the operator focuses a chat, advancing
  // its read-cursor past the newest message we've seen so rows they just viewed
  // don't resurface as unread after they navigate away.
  useEffect(() => {
    if (!activeTarget) return;
    const newest = newestByTargetRef.current.get(targetKey(activeTarget));
    if (newest) writeReadCursor(activeTarget, newest);
    markUnread(activeTarget, false);
  }, [activeTarget]);
}

// --- Consumer hook (mounted by chat hooks) ---------------------------------

export interface TargetView {
  messages: ChatMessage[];
  /** In-flight preview streams for this target. Drained on durable seal.
   *  Shape tracks the snapshot's `previews` so adding a field upstream
   *  flows through without per-consumer edits. */
  previews: AdminTargetSnapshot['previews'];
}

const EMPTY_PREVIEWS: TargetView['previews'] = [];

/**
 * Reactive view of the messages + in-flight previews for a target. Returns
 * empty arrays if `target` is null (e.g. when no agent is URL-active).
 * Subscribes to the worker's `admin-target` snapshot — the worker handles
 * IDB hydration, live packet append, and preview coalescing by streamId.
 */
export function useTargetMessages(target: Target | null): TargetView {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [previews, setPreviews] = useState<TargetView['previews']>(EMPTY_PREVIEWS);
  // Stable content-hash of `target`. Callers typically construct `target`
  // inline (`{kind:'manager', slug}`), producing a new object reference on
  // every render. We MUST depend only on `key` — depending on `target`
  // re-runs the effect every render, which re-subscribes; worker-client
  // then microtask-fires the cached snapshot's `setMessages(newArray)`
  // → re-render → effect re-runs → infinite loop, main-thread hang.
  const key = target ? targetKey(target) : null;

  useEffect(() => {
    if (!target || !key) {
      setMessages([]);
      setPreviews(EMPTY_PREVIEWS);
      return;
    }
    return worker.subscribe(
      { kind: 'admin-target', target },
      (data: AdminTargetSnapshot) => {
        setMessages(data.messages.map(adminToChat));
        setPreviews(data.previews);
      },
    );
    // `target` is intentionally NOT in the deps — see comment above `key`.
    // The closure captures whatever target was passed at last effect run;
    // since `key` is target's content-hash, equivalent content keeps the
    // same captured value valid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { messages, previews };
}

/**
 * Worker stores admin packets as `AdminChatMessage` (sessionHash optional/
 * nullable, may carry passthrough fields). Tab consumers expect the older
 * `ChatMessage` shape with no sessionHash. Project once at the boundary.
 */
function adminToChat(m: AdminChatMessage): ChatMessage {
  return {
    id: m.id,
    type: m.type,
    from: m.from,
    to: m.to,
    text: m.text,
    timestamp: m.timestamp,
    ...(m.streamId ? { streamId: m.streamId } : {}),
  };
}
