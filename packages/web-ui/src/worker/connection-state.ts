/**
 * Per-identity ConnectionState — the data container the worker keeps in
 * `Map<identity, ConnectionState>`. Holds the WS handle, the per-identity
 * dedup set, the chat-side state slots, and a refcount for lifecycle.
 *
 * Lifecycle:
 *   - First `acquire()` for an identity creates the entry and opens the WS.
 *   - Subsequent `acquire()` calls increment refCount.
 *   - `release()` decrements; when refCount hits 0 a 500ms grace timer starts.
 *   - If a fresh `acquire()` arrives within the grace, the timer is cancelled
 *     and the entry is reused (no WS bounce on tab refresh).
 *   - If the timer fires, `dispose()` is called and the entry is dropped.
 *
 * Phase 1.1 builds the refcount lifecycle with empty state slots; Phase 2.1
 * adds WS attachment and chat ingest.
 */

import { BoundedSet } from './lib/bounded-set';
import type { CastTransport } from './interfaces';
import type { AgentsPayload, AttachmentAckPayload, DiscoverPayload } from '../lib/protocol';
import type {
  ChatConversationSnapshot,
  ChatIdentitySnapshot,
  ChatPhase,
  Identity,
  StoredMessage,
  Toast,
} from './protocol';

const PROCESSED_IDS_CAP = 5000;
const TEARDOWN_GRACE_MS = 500;
// Cap snapshot size sent to tabs. Tab's RENDER_LIMIT is 200; sending a bit more
// gives buffer for future scroll-paging without yet implementing it. Older
// messages stay in IDB and can still be served if a paging action is added.
const SNAPSHOT_MESSAGE_LIMIT = 500;

/** Live messages cache for an active conversation subscription. */
export interface ConversationCache {
  messages: StoredMessage[];
  typing: boolean;
  lifecycle: string | null;
  /** In-flight preview streams keyed by streamId. Cleared on durable seal.
   *  `firstSeenAt` is the stream's first-chunk timestamp, preserved across
   *  subsequent chunks so the render layer can hold the bubble's chronological
   *  position even as the latest chunk's server-stamped time drifts forward. */
  previews: Map<string, { text: string; firstSeenAt: string }>;
}

export class ConnectionState {
  readonly identity: Identity;

  /** Refcount of active tab subscriptions for this identity. */
  private refCount = 0;

  /** Pending teardown timer; cancelled if a fresh acquire arrives within the grace window. */
  private teardownTimer: ReturnType<typeof setTimeout> | null = null;

  /** WS transport — null until Phase 2.1 wires it up via `attachTransport`. */
  transport: CastTransport | null = null;

  /** Recently-seen server packet IDs, for dedup against drain-replays. */
  readonly processedIds = new BoundedSet<string>(PROCESSED_IDS_CAP);

  /** Identity-scoped state — backs `chat-identity` snapshots. */
  state: ChatIdentitySnapshot = {
    phase: 'connecting',
    agents: [] as AgentsPayload['list'],
    discovered: [] as DiscoverPayload['list'],
    unread: {},
    toasts: [],
    error: null,
    connectionState: 'connecting',
  };

  /** Per-conversation caches keyed by `${agent}:${channel}`. */
  readonly conversations = new Map<string, ConversationCache>();

  /** Pending registration name, set during `register-identity`. */
  pendingRegistrationName: string | null = null;

  /** Subscribers to attachment_ack packets — used by the send-message handler to await acks. */
  readonly attachmentAckListeners = new Set<(ack: AttachmentAckPayload) => void>();

  /** Disposer to invoke when refcount goes to zero past the grace period. */
  private readonly onDispose: (identity: Identity) => void;

  constructor(identity: Identity, onDispose: (identity: Identity) => void) {
    this.identity = identity;
    this.onDispose = onDispose;
  }

  acquire(): void {
    this.refCount++;
    if (this.teardownTimer !== null) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
  }

  release(): void {
    if (this.refCount <= 0) return;
    this.refCount--;
    if (this.refCount === 0) {
      this.teardownTimer = setTimeout(() => {
        this.teardownTimer = null;
        if (this.refCount === 0) {
          this.dispose();
          this.onDispose(this.identity);
        }
      }, TEARDOWN_GRACE_MS);
    }
  }

  /** Snapshot of the identity-scoped state (returned on subscribe and after every mutation). */
  snapshot(): ChatIdentitySnapshot {
    return {
      ...this.state,
      // Defensive copies of mutable structures so the post-message clone
      // can't observe a torn state if the worker mutates between
      // serialization and structured-clone.
      agents: [...this.state.agents],
      discovered: [...this.state.discovered],
      unread: { ...this.state.unread },
      toasts: [...this.state.toasts],
    };
  }

  /** Snapshot of a conversation's cache shaped for wire transit (Map → array). */
  conversationSnapshot(agent: string, channel: string): ChatConversationSnapshot {
    const cache = this.conversations.get(`${agent}:${channel}`);
    if (!cache) return { messages: [], typing: false, lifecycle: null, previews: [] };
    return {
      messages: cache.messages.slice(-SNAPSHOT_MESSAGE_LIMIT),
      typing: cache.typing,
      lifecycle: cache.lifecycle,
      previews: Array.from(cache.previews, ([streamId, { text, firstSeenAt }]) => ({ streamId, text, timestamp: firstSeenAt })),
    };
  }

  conversationCache(agent: string, channel: string): ConversationCache {
    const key = `${agent}:${channel}`;
    let cache = this.conversations.get(key);
    if (!cache) {
      cache = { messages: [], typing: false, lifecycle: null, previews: new Map() };
      this.conversations.set(key, cache);
    }
    return cache;
  }

  setPhase(phase: ChatPhase): void {
    this.state = { ...this.state, phase };
  }

  setError(error: string | null): void {
    this.state = { ...this.state, error };
  }

  pushToast(toast: Toast, max: number): void {
    this.state = { ...this.state, toasts: [...this.state.toasts.slice(-(max - 1)), toast] };
  }

  removeToast(id: string): void {
    this.state = { ...this.state, toasts: this.state.toasts.filter((t) => t.id !== id) };
  }

  bumpUnread(agent: string, channel: string): void {
    const key = `${agent}/${channel}`;
    const next = (this.state.unread[key] ?? 0) + 1;
    this.state = { ...this.state, unread: { ...this.state.unread, [key]: next } };
  }

  clearUnread(agent: string, channel: string): void {
    const key = `${agent}/${channel}`;
    if (this.state.unread[key] === undefined) return;
    const { [key]: _drop, ...rest } = this.state.unread;
    this.state = { ...this.state, unread: rest };
  }

  setAgents(list: AgentsPayload['list']): void {
    this.state = { ...this.state, agents: list };
  }

  setDiscovered(list: DiscoverPayload['list']): void {
    this.state = { ...this.state, discovered: list };
  }

  setConnectionState(state: ChatIdentitySnapshot['connectionState']): void {
    this.state = { ...this.state, connectionState: state };
  }

  /** Tear down the WS + clear state. Called when refcount is zero past grace. */
  private dispose(): void {
    this.transport?.disconnect();
    this.transport = null;
    this.conversations.clear();
  }
}
