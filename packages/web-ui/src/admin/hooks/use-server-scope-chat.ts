/**
 * useServerScopeChat — UI state hook for the three fleet-manager consoles
 * (design / config / security). Pure projection of `useAdminGlobalState`'s
 * message store, mirroring `useAdminChat` for per-agent rails.
 *
 * Live event ingestion + IDB persistence + unread tracking happen once at
 * the Layout level in `useAdminGlobalState`. This hook owns only UI-local
 * state (typing, sending, error) and the optimistic echo path.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'wouter';

import {
  isServerScopeTarget,
  UiDirectiveEventDataSchema,
  type ServerScopeTarget,
} from '@getcast/admin-schema/v1';

import { useChatUnread } from '../lib/chat-unread';
import { LIFECYCLE_LABELS } from '../../lib/lifecycle-labels';
import { API_BASE } from '../trpc';
import {
  ChatMessageSchema,
  LifecycleDataSchema,
  parseHttpErrorBody,
  type ChatMessage,
  type AdminChatState,
} from './use-admin-chat';
import { authHeaders } from './use-session';
import { useAdminEventStream, type Target } from './use-admin-event-stream';
import {
  rollbackEcho,
  useTargetMessages,
  writeEcho,
  writeEchoBeforeLast,
} from './use-admin-global-state';

export type { ServerScopeTarget };
// Re-exported for parity with prior surface; some callers import the schema constants from here.
export { ChatMessageSchema };

const ADMIN_FROM = 'local/admin:local';
const TYPING_TTL_MS = 5000;
const MESSAGE_RECEIVED_TTL_MS = 1500;

/**
 * Per-target wiring derived from the canonical `ServerScopeTarget` enum in
 * `@getcast/admin-schema`. Both `base` (HTTP route) and `address` (bus) are
 * `<target>` substituted into a fixed pattern; deriving in one place
 * removes the cross-package duplication a hardcoded dict would create.
 */
function configFor(target: ServerScopeTarget): { base: string; address: string } {
  return { base: `/api/admin/${target}/chat`, address: `console:${target}` };
}

export interface ServerScopeChatOptions {
  /** Whether this tab is the active (visible) one. Drives unread-dot clearing and navigate-gating. */
  isActive: boolean;
  /** Called when a `show` directive's target is a server-scope console. */
  onServerScopeTab?: (tab: ServerScopeTarget) => void;
}

export function useServerScopeChat(
  target: ServerScopeTarget,
  opts: ServerScopeChatOptions,
): AdminChatState {
  const { isActive, onServerScopeTab } = opts;
  const cfg = configFor(target);
  const stream = useAdminEventStream();

  const dispatcherTarget: Target = { kind: 'manager', slug: target };
  // Pure projection — message array + in-flight previews are owned by the worker.
  const { messages, previews } = useTargetMessages(dispatcherTarget);
  const unread = useChatUnread(dispatcherTarget);
  const [typing, setTyping] = useState(false);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [, navigate] = useLocation();

  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const onServerScopeTabRef = useRef(onServerScopeTab);
  onServerScopeTabRef.current = onServerScopeTab;

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

  useEffect(() => {
    const t: Target = { kind: 'manager', slug: target };
    return stream.subscribe(t, (event, data) => {
      try {
        if (event === 'packet') {
          // Handled by useAdminGlobalState.
        } else if (event === 'typing') {
          bumpTyping(TYPING_TTL_MS);
        } else if (event === 'typing_stopped') {
          stopTyping();
        } else if (event === 'message_received') {
          bumpTyping(MESSAGE_RECEIVED_TTL_MS);
        } else if (event === 'lifecycle') {
          // See use-admin-chat.ts for the divider-suppression rationale.
          const lifecycle = LifecycleDataSchema.safeParse(data);
          if (!lifecycle.success) {
            console.warn('[use-server-scope-chat] lifecycle parse failed', { target, error: lifecycle.error });
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
            const label = LIFECYCLE_LABELS[lifecycle.data.phase];
            if (label) setLifecycle(label);
          } else if (lifecycle.data.active === false) {
            setLifecycle(null);
          }
        } else if (event === 'ui_directive') {
          if (!isActiveRef.current) return;
          const payload = UiDirectiveEventDataSchema.safeParse(data);
          if (!payload.success) {
            console.warn('[use-server-scope-chat] ui_directive parse failed', { target, error: payload.error });
            return;
          }
          const d = payload.data.directive;
          if (!d) return;

          if (d.type === 'show') {
            if (isServerScopeTarget(d.target)) {
              onServerScopeTabRef.current?.(d.target);
              return;
            }
            const route = d.target.startsWith('/admin') ? d.target.slice('/admin'.length) || '/' : d.target;
            navigate(route + (d.within ? `#${d.within}` : ''));
            if (d.within) {
              setTimeout(() => {
                const el = document.getElementById(d.within!);
                el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }, 0);
            }
            return;
          }

          // `hint` — reserved for future layout suggestions.
        }
      } catch (err) {
        console.warn('[use-server-scope-chat] handler error', { target, event, err });
      }
    });
    // `messages` intentionally NOT a dep — the lifecycle branch reads it for
    // divider suppression but we don't want to churn subscription on every
    // packet append.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, stream, bumpTyping, stopTyping, navigate]);

  const send = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    const echoId = `echo-${crypto.randomUUID()}`;
    const echo: ChatMessage = {
      id: echoId,
      type: 'conversation',
      from: ADMIN_FROM,
      to: cfg.address,
      text: trimmed,
      timestamp: new Date().toISOString(),
    };
    writeEcho(dispatcherTarget, echo);
    try {
      const res = await fetch(`${API_BASE}${cfg.base}/send`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(parseHttpErrorBody(body, res.status));
      }
    } catch (e) {
      rollbackEcho(dispatcherTarget, echoId);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return { messages, previews, typing, lifecycle, sending, error, unread, send };
}
