/**
 * Tab-side facade over the persistence SharedWorker. The chat and admin
 * surfaces use this — they never instantiate `SharedWorker` directly.
 *
 * Responsibilities:
 *   - Lazy-create + connect to the SharedWorker on first use.
 *   - Send envelopes; correlate `ack` responses to outstanding actions.
 *   - Subscribe to scopes; deliver initial snapshot + every mutation to a callback.
 *   - Receive ambient `WorkerEvent`s and dispatch to registered listeners.
 *
 * The `Promise`-based action API and the callback-based subscription API
 * map cleanly to Preact's reactive primitives (signals updated inside
 * the snapshot callback). Tabs don't see `MessagePort` directly.
 */

import {
  WorkerToTab,
  scopeKey,
  type Action,
  type Scope,
  type Snapshot,
  type WorkerEvent,
} from '../worker/protocol';

/** Snapshot data type for a given scope kind. Narrowing helper. */
type SnapshotData<K extends Scope['kind']> = Extract<Snapshot, { kind: K }>['data'];

interface PendingAction {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface SubscriptionHandle {
  scope: Scope;
  onSnapshot: (data: unknown) => void;
  /** Optional handler for transient `scoped-event` frames (e.g. admin typing/lifecycle). */
  onEvent?: (event: string, data: unknown) => void;
}

const TAB_ID = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
})();

class WorkerClient {
  private port: MessagePort | null = null;
  private worker: SharedWorker | null = null;
  private readonly pending = new Map<string, PendingAction>();
  /** scopeKey → set of subscription handles. Re-fans snapshots/mutations to all. */
  private readonly subs = new Map<string, Set<SubscriptionHandle>>();
  /**
   * Last snapshot data we've seen for each scope key. Lets late-joining
   * handles hydrate synchronously from cache instead of triggering a
   * redundant round-trip-and-fanout to all existing handles. Cleared when
   * the last handle for a scope is released.
   */
  private readonly lastSnapshot = new Map<string, unknown>();
  private readonly eventHandlers = new Map<WorkerEvent['kind'], Set<(event: WorkerEvent) => void>>();
  private readyPromise: Promise<void> | null = null;
  private workerVersion: string | null = null;

  /** Open the SharedWorker connection. Idempotent — repeated calls return the same promise. */
  ready(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      try {
        this.worker = new SharedWorker(
          new URL('../worker/persistence-worker.ts', import.meta.url),
          { type: 'module', name: 'cast-persistence' },
        );
        this.port = this.worker.port;
        this.port.onmessage = (e) => this.onIncoming(e.data);
        this.port.start();

        // Send `hello`; await `hello-ack` to resolve.
        const helloHandler = (data: unknown): void => {
          const result = WorkerToTab.safeParse(data);
          if (!result.success || result.data.kind !== 'hello-ack') return;
          this.workerVersion = result.data.workerVersion;
          console.info('[worker-client] connected', { tabId: TAB_ID, workerVersion: this.workerVersion });
          this.port?.removeEventListener('message', earlyListener as EventListener);
          resolve();
        };
        const earlyListener = (e: MessageEvent): void => helloHandler(e.data);
        this.port.addEventListener('message', earlyListener);

        this.port.postMessage({ kind: 'hello', tabId: TAB_ID });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return this.readyPromise;
  }

  /**
   * Subscribe to a scope. The returned function unsubscribes.
   * `onSnapshot` is called with the initial snapshot and on every subsequent
   * mutation. Snapshots are full data — no merge logic in the tab.
   *
   * Optional `onEvent` receives transient `scoped-event` frames for this
   * scope — used by admin for typing/lifecycle/ui_directive/message_received
   * signals that don't change the snapshot.
   */
  subscribe<K extends Scope['kind']>(
    scope: Scope & { kind: K },
    onSnapshot: (data: SnapshotData<K>) => void,
    onEvent?: (event: string, data: unknown) => void,
  ): () => void {
    const key = scopeKey(scope);
    const handle: SubscriptionHandle = {
      scope,
      onSnapshot: onSnapshot as (data: unknown) => void,
      onEvent,
    };
    let set = this.subs.get(key);
    const isFirstHandleForScope = !set;
    if (!set) {
      set = new Set();
      this.subs.set(key, set);
    }
    set.add(handle);

    if (isFirstHandleForScope) {
      // First handle — round-trip to worker for the snapshot. The worker's
      // mutation broadcasts thereafter feed every late handle.
      void this.ready().then(() => {
        this.port?.postMessage({
          kind: 'subscribe',
          requestId: crypto.randomUUID(),
          scope,
        });
      });
    } else {
      // Late handle — hydrate from the cached snapshot if we've already seen
      // one. If not (cache lost or first snapshot not yet arrived), the
      // pending subscribe round-trip's snapshot will fan to this handle too.
      const cached = this.lastSnapshot.get(key);
      if (cached !== undefined) {
        // Microtask to keep handler registration symmetric with the first-
        // handle path (snapshot arrives async there too).
        queueMicrotask(() => handle.onSnapshot(cached));
      }
    }

    return () => {
      const s = this.subs.get(key);
      if (s) {
        s.delete(handle);
        if (s.size === 0) {
          this.subs.delete(key);
          this.lastSnapshot.delete(key);
        }
      }
      // Only send unsubscribe to worker when the LAST handle for this scope is gone.
      if (!s || s.size === 0) {
        void this.ready().then(() => {
          this.port?.postMessage({ kind: 'unsubscribe', scope });
        });
      }
    };
  }

  /**
   * Dispatch an action to the worker. Returns a Promise that resolves with the
   * ack `result` on success, rejects with the error message on failure.
   */
  async send<R = unknown>(action: Action, transfer?: Transferable[]): Promise<R> {
    await this.ready();
    return new Promise<R>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      this.pending.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      const envelope = { kind: 'action' as const, requestId, action };
      if (transfer && transfer.length > 0) {
        this.port?.postMessage(envelope, transfer);
      } else {
        this.port?.postMessage(envelope);
      }
    });
  }

  /** Register a handler for an ambient `WorkerEvent` kind. Returns an unregister function. */
  on<K extends WorkerEvent['kind']>(
    kind: K,
    handler: (event: Extract<WorkerEvent, { kind: K }>) => void,
  ): () => void {
    let set = this.eventHandlers.get(kind);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(kind, set);
    }
    set.add(handler as (event: WorkerEvent) => void);
    return () => { set?.delete(handler as (event: WorkerEvent) => void); };
  }

  /** Tab-local identifier (random per page-load). Used for source-tagging ambient events. */
  get tabId(): string {
    return TAB_ID;
  }

  private onIncoming(data: unknown): void {
    const result = WorkerToTab.safeParse(data);
    if (!result.success) {
      console.warn('[worker-client] invalid frame from worker', result.error.issues);
      return;
    }
    const frame = result.data;
    switch (frame.kind) {
      case 'hello-ack':
        // Handled by the early listener in `ready()`.
        return;
      case 'snapshot':
      case 'mutation': {
        const key = scopeKey(frame.scope);
        // Cache latest data so late-joining handles for the same scope can
        // hydrate without a redundant subscribe round-trip.
        this.lastSnapshot.set(key, frame.snapshot.data);
        const set = this.subs.get(key);
        if (!set) return;
        for (const handle of set) {
          // The snapshot kind matches the scope kind by construction.
          handle.onSnapshot(frame.snapshot.data);
        }
        return;
      }
      case 'scoped-event': {
        const key = scopeKey(frame.scope);
        const set = this.subs.get(key);
        if (!set) return;
        for (const handle of set) {
          handle.onEvent?.(frame.event, frame.data);
        }
        return;
      }
      case 'ack': {
        const pending = this.pending.get(frame.requestId);
        if (!pending) return;
        this.pending.delete(frame.requestId);
        if (frame.ok) {
          pending.resolve(frame.result);
        } else {
          pending.reject(new Error(frame.error ?? 'action failed'));
        }
        return;
      }
      case 'event': {
        const handlers = this.eventHandlers.get(frame.event.kind);
        if (!handlers) return;
        for (const h of handlers) h(frame.event);
        return;
      }
    }
  }
}

// SIDE EFFECT: Process-global singleton WorkerClient. The `SharedWorker` itself
// is a single instance per origin; one client wrapping it from each tab
// is the natural fit. Components import and use the singleton directly.
export const worker = new WorkerClient();
