/**
 * useAdminChat — per-channel UI state hook for the agent design / configure
 * consoles. Pure projection of `useAdminGlobalState`'s message store; this
 * hook owns no message array of its own.
 *
 * Responsibilities (UI-only):
 *   - Read messages for (alias, channel) from the global store via
 *     `useTargetMessages`.
 *   - Typing indicator with a 5s self-clear TTL.
 *   - Optimistic echo on send (writes through the global store via
 *     `writeEcho` so other consumers see the same data).
 *   - `ui_directive` routing — gated on `isActive` so a directive doesn't
 *     yank the operator's URL when their attention has moved elsewhere.
 *   - `fresh_conversation` divider injection (also via `writeEcho`).
 *
 * Live event ingestion + IDB persistence + unread tracking happen once at
 * the Layout level in `useAdminGlobalState`. This hook never re-parses
 * packets and never writes to IDB directly.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'wouter';
import { z } from 'zod';

import {
  isServerScopeTarget,
  UiDirectiveEventDataSchema,
  type ServerScopeTarget,
} from '@getcast/admin-schema/v1';

import type { AdminTargetSnapshot } from '../../worker/protocol';
import { useChatUnread } from '../lib/chat-unread';
import { LIFECYCLE_LABELS } from '../../lib/lifecycle-labels';
import { API_BASE } from '../trpc';
import { authHeaders } from './use-session';
import { useAdminEventStream, type Target, type AgentChannel } from './use-admin-event-stream';
import {
  rollbackEcho,
  useTargetMessages,
  writeEcho,
  writeEchoBeforeLast,
} from './use-admin-global-state';

// Matches ADMIN_HANDLE / ADMIN_RESOLVED in cast/src/admin/chat.ts.
const ADMIN_FROM = 'local/admin:local';
/** Typing-indicator self-clear if no event arrives. Belt-and-suspenders against dropped typing_stopped. */
const TYPING_TTL_MS = 5000;
/** Shorter TTL for the message_received-driven flick (covers cold-start latency before first real `typing`). */
const MESSAGE_RECEIVED_TTL_MS = 1500;

export const ChatMessageSchema = z.object({
  id: z.string().nullable(),
  type: z.string(),
  from: z.string(),
  to: z.string(),
  text: z.string(),
  timestamp: z.string(),
  /** Present when this durable message terminates a preview stream. The
   *  AdminChat render keys streaming items by `stream-${streamId}` so the
   *  seal-arrival transition is a same-key prop change. */
  streamId: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// SSE event payload shapes — the data field of each event the hook
// observes. `passthrough` keeps the parse permissive to fields the cast
// server may add later (forward-compat); the consumer only reads what's
// declared. Failures bubble through the existing JSON.parse try/catch
// and surface in `console.warn`.
export const LifecycleDataSchema = z.object({
  phase: z.string(),
  channel: z.string().optional(),
  active: z.boolean().optional(),
}).passthrough();

/**
 * Try to extract an `{ error: string }` JSON body before falling back to
 * the raw text. Cast's HTTP routes return JSON errors (e.g. `chat.ts`
 * emits `{ error: 'channel required' }`); throwing the literal blob in
 * the UI banner is W14-shaped UX noise.
 */
export function parseHttpErrorBody(body: string, status: number): string {
  if (!body) return `HTTP ${status}`;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const err = (parsed as { error: unknown }).error;
      if (typeof err === 'string') return err;
    }
  } catch {
    // Not JSON — fall through to raw text.
  }
  return body;
}

export interface AdminChatState {
  messages: ChatMessage[];
  /** In-flight preview streams for this target. Each entry is a same-`streamId`
   *  ephemeral text snapshot, cleared on durable seal. Shape tracks the
   *  worker's AdminTargetSnapshot so upstream additions flow through. */
  previews: AdminTargetSnapshot['previews'];
  typing: boolean;
  /**
   * Operator-visible label for in-flight runtime state (queued, bootstrap,
   * compacting, auth_refresh). `null` when no lifecycle phase is active.
   * Mutually informative with `typing`: an agent in cleanup or queued is
   * not "typing" — surface the lifecycle reason instead.
   */
  lifecycle: string | null;
  sending: boolean;
  error: string | null;
  unread: boolean;
  send: (text: string) => Promise<void>;
}

export interface UseAdminChatOptions {
  /** Called when a `show` directive's target is a server-scope console. */
  onServerScopeTab?: (tab: ServerScopeTarget) => void;
}

export function useAdminChat(
  alias: string,
  channel: AgentChannel,
  isActive: boolean,
  opts: UseAdminChatOptions = {},
): AdminChatState {
  const stream = useAdminEventStream();
  const target: Target | null = alias ? { kind: 'agent', alias, channel } : null;
  // Pure projection — message array + in-flight previews are owned by the
  // worker; useTargetMessages subscribes to the admin-target snapshot.
  const { messages, previews } = useTargetMessages(target);
  const unread = useChatUnread({ kind: 'agent', alias, channel });
  const [typing, setTyping] = useState(false);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [, navigate] = useLocation();

  // Read at fire time so a tab switch between directive arrival and the
  // navigate call takes effect immediately (the handler could run after
  // the active-tab prop changed but before the next render reaches us).
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const onServerScopeTabRef = useRef(opts.onServerScopeTab);
  onServerScopeTabRef.current = opts.onServerScopeTab;

  // Single typing TTL ref — refreshed by every `typing`/`message_received`,
  // cleared on `typing_stopped` and unmount.
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTypingTimer = useCallback((): void => {
    if (typingTimerRef.current !== null) {
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
  }, []);
  const bumpTyping = useCallback(
    (ttlMs: number): void => {
      clearTypingTimer();
      setTyping(true);
      typingTimerRef.current = setTimeout(() => {
        setTyping(false);
        typingTimerRef.current = null;
      }, ttlMs);
    },
    [clearTypingTimer],
  );
  const stopTyping = useCallback((): void => {
    clearTypingTimer();
    setTyping(false);
  }, [clearTypingTimer]);
  useEffect(() => {
    return () => clearTypingTimer();
  }, [clearTypingTimer]);

  // --- Subscribe to the dispatcher for non-packet events.
  // `packet` is handled by useAdminGlobalState (which writes to the shared
  // store this hook reads via useTargetMessages). We still listen here for
  // typing / lifecycle / ui_directive — UI-local concerns specific to the
  // mounted chat panel.
  useEffect(() => {
    if (!alias) return;
    const t: Target = { kind: 'agent', alias, channel };
    return stream.subscribe(t, (event, data) => {
      try {
        if (event === 'packet') {
          // Handled by useAdminGlobalState — no-op here.
        } else if (event === 'typing') {
          bumpTyping(TYPING_TTL_MS);
        } else if (event === 'typing_stopped') {
          stopTyping();
        } else if (event === 'message_received') {
          // Server ack — gateway received the operator's message. Flick the
          // typing indicator on instantly (covers cold-start latency before
          // the agent's first real `typing` event). Cleared by an incoming
          // typing/typing_stopped, or by this short fallback timer if the
          // agent never streams (e.g. instant short reply).
          bumpTyping(MESSAGE_RECEIVED_TTL_MS);
        } else if (event === 'lifecycle') {
          // Server-authoritative "fresh conversation" boundary — fired
          // when the runner spawns without an SDK resume id, so the LLM
          // has no prior context. Insert a divider via the global store so
          // it persists like any other transcript row.
          //
          // Suppress on the very first operator turn: the canned
          // greeting (rendered as a synthetic agent bubble above the
          // transcript) sets up a phantom first-turn for the operator,
          // and surfacing "agent has no prior context" right after
          // their first reply contradicts that illusion. After any
          // real agent message lands, future fresh_conversation events
          // (TTL expiry, server restart, runner crash) divider normally.
          const lifecycle = LifecycleDataSchema.safeParse(data);
          if (!lifecycle.success) {
            console.warn('[use-admin-chat] lifecycle parse failed', lifecycle.error);
            return;
          }
          if (lifecycle.data.phase === 'fresh_conversation') {
            const hasPriorAgentTurn = messages.some(
              (m) => !m.from.startsWith('local/') && !m.type.startsWith('divider:'),
            );
            if (!hasPriorAgentTurn) return;
            const divider: ChatMessage = {
              id: `divider-${crypto.randomUUID()}`,
              type: 'divider:fresh_conversation',
              from: '',
              to: '',
              text: '',
              timestamp: new Date().toISOString(),
            };
            // Splice before the operator's just-sent message — the
            // lifecycle event arrives *after* their echo but the
            // divider conceptually precedes it.
            writeEchoBeforeLast(t, divider);
          } else if (lifecycle.data.active === true) {
            // Phase entered (active=true) — surface its label. Unknown phases
            // fall through silently rather than rendering a phase-name string.
            const label = LIFECYCLE_LABELS[lifecycle.data.phase];
            if (label) setLifecycle(label);
            // `queued` waits can stretch into minutes when the gate is full
            // and no idle runner exists. Mirror Telegram/Slack by appending
            // a persistent transcript row so the operator can see the wait
            // even after switching tabs or coming back later.
            if (lifecycle.data.phase === 'queued') {
              const divider: ChatMessage = {
                id: `divider-queued-${crypto.randomUUID()}`,
                type: 'divider:queued',
                from: '',
                to: '',
                text: label ?? 'Waiting for a free slot…',
                timestamp: new Date().toISOString(),
              };
              writeEchoBeforeLast(t, divider);
            }
          } else if (lifecycle.data.active === false) {
            // Phase exited (active=false) — clear the transient indicator.
            // The `queued` divider stays in the transcript as history.
            setLifecycle(null);
          }
        } else if (event === 'ui_directive') {
          // Channel-scoped by the server, but we still gate on the active
          // tab — a tab switch mid-flight shouldn't yank the user's URL.
          if (!isActiveRef.current) return;
          const payload = UiDirectiveEventDataSchema.safeParse(data);
          if (!payload.success) {
            console.warn('[use-admin-chat] ui_directive parse failed', payload.error);
            return;
          }
          const d = payload.data.directive;
          if (!d) return;

          if (d.type === 'show') {
            if (isServerScopeTarget(d.target)) {
              onServerScopeTabRef.current?.(d.target);
              return;
            }
            // wouter's base is "/admin" (see router.tsx); strip if the
            // agent emits full paths like "/admin/agents/..." by accident.
            const route = d.target.startsWith('/admin') ? d.target.slice('/admin'.length) || '/' : d.target;
            navigate(route + (d.within ? `#${d.within}` : ''));
            if (d.within) {
              // Microtask so the router has committed the new route before
              // we try to scroll to the anchor.
              setTimeout(() => {
                const el = document.getElementById(d.within!);
                el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }, 0);
            }
            return;
          }

          // `hint` — UI presentation hint (Task 171's `chat_position` slot).
          // No consumer wired yet; reserved so an unknown variant doesn't
          // fall through silently when implementation lands.
        }
      } catch (err) {
        console.warn('[use-admin-chat] handler error', { event, err });
      }
    });
    // `messages` intentionally NOT in the dep list — the lifecycle handler
    // reads it for divider suppression but a closure capture of the latest
    // value is fine; we don't want to churn the subscription on every
    // packet append.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alias, channel, stream, bumpTyping, stopTyping, navigate]);

  const send = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || sending || !target) return;
    setSending(true);
    setError(null);
    // Optimistic local echo — the server doesn't round-trip operator
    // messages back on SSE (those go to the agent, not the subscribers).
    // Stamp the id BEFORE fetch so we can roll it back on failure.
    const echoId = `echo-${crypto.randomUUID()}`;
    const echo: ChatMessage = {
      id: echoId,
      type: 'conversation',
      from: ADMIN_FROM,
      to: `agent:${alias}`,
      text: trimmed,
      timestamp: new Date().toISOString(),
    };
    writeEcho(target, echo);
    try {
      const res = await fetch(`${API_BASE}/api/admin/agents/${encodeURIComponent(alias)}/chat/send`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, text: trimmed }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(parseHttpErrorBody(body, res.status));
      }
    } catch (e) {
      // Roll back the optimistic echo so the operator doesn't see a
      // ghost message alongside the error banner. Retrying re-stamps a
      // fresh id, so no duplication.
      rollbackEcho(target, echoId);
      // Note: persisted echo stays in IndexedDB on send failure — a small
      // wart, but rolling back the IDB write would require an extra round
      // trip and the next reload would re-render the failed message
      // anyway. Acceptable until echo-id reconciliation lands.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return { messages, previews, typing, lifecycle, sending, error, unread, send };
}
