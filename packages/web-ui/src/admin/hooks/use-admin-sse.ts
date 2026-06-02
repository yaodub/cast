/**
 * Shared SSE subscription hook for the admin UI.
 *
 * Centralizes the `fetchEventSource` + Bearer-header + stale-token-refresh
 * dance used by `/api/changes` and `/api/admin/events` (multiplexed admin
 * event stream). Stores the `onMessage` callback in a ref so inline
 * closures don't force re-subscribes on every render.
 */
import { useEffect, useRef } from 'preact/hooks';
import { fetchEventSource, type EventSourceMessage } from '@microsoft/fetch-event-source';

import { getToken, refreshToken } from './use-session';

export interface UseAdminSseHooks {
  /** Fires whenever the underlying EventSource opens (initial connect + each successful reconnect). */
  onOpen?: () => void;
  /** Fires whenever fetch-event-source reports a transport error (connection drop, etc.). */
  onError?: () => void;
}

export function useAdminSse(
  url: string,
  onMessage: (ev: EventSourceMessage) => void,
  enabled: boolean = true,
  hooks?: UseAdminSseHooks,
): void {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;

  useEffect(() => {
    if (!enabled) return;

    const ctrl = new AbortController();
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    fetchEventSource(url, {
      headers,
      signal: ctrl.signal,
      openWhenHidden: true,
      async onopen() {
        hooksRef.current?.onOpen?.();
      },
      onmessage(ev) {
        onMessageRef.current(ev);
      },
      onerror() {
        hooksRef.current?.onError?.();
        // Likely stale bearer after server restart — refresh and mutate headers
        // in place so fetch-event-source's next retry picks it up.
        void refreshToken().then((fresh) => {
          if (fresh) headers.Authorization = `Bearer ${fresh}`;
        });
      },
    }).catch(() => {
      // AbortError on unmount, or unrecoverable error.
    });

    return () => ctrl.abort();
  }, [url, enabled]);
}
