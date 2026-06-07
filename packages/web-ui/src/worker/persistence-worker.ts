/// <reference lib="webworker" />
/**
 * SharedWorker entry point — single owner of WebSocket / EventSource /
 * IndexedDB / dedup state for the entire browser origin. Tabs are thin
 * `MessagePort` clients; this worker holds the canonical state.
 *
 * Multi-identity is first-class: a `Map<identity, ConnectionState>` keeps
 * one WS per active identity. Subscriptions implicitly hold refcounts
 * (subscribe = acquire, unsubscribe = release). When refcount hits zero,
 * a 500ms grace timer absorbs page navigations before tearing down the WS.
 */

import { installChatLifecycle } from './chat/lifecycle';
import {
  dismissToast,
  explainApproval,
  getAttachment,
  onConversationFirstSubscribe,
  refreshAgents,
  refreshDiscover,
  registerIdentity,
  respondToApproval,
  sendMessage,
} from './chat/handlers';
import {
  connectAdmin,
  disconnectAdmin,
  markAdminTargetRead,
  rollbackEcho,
  writeEcho,
  writeEchoBeforeLast,
} from './admin/handlers';
import { installAdminLifecycle, onAdminTargetFirstSubscribe } from './admin/lifecycle';
import { PortTabChannel } from './tab-channel';
import {
  TabToWorker,
  scopeIdentity,
  scopeKey,
  type Action,
  type Scope,
  type WorkerToTab,
} from './protocol';
import type { TabChannel } from './interfaces';
import {
  acquireAdminConnection,
  connections,
  ensureConnection,
  releaseAdminConnection,
  snapshotFor,
  subscriptions,
} from './state';
import type { Subscription } from './subscription-registry';

// ---------------------------------------------------------------------------
// Worker version stamp — logged on every `hello` so dev-HMR staleness is
// obvious. Bump manually when the worker bundle's code changes; since
// Vite HMR doesn't replace SharedWorker code, devs only see this rotate
// when the browser fully reloads against a fresh bundle.
// ---------------------------------------------------------------------------

const WORKER_VERSION = 'v0.2.0';

// Wire chat WS handling: any newly-created ConnectionState gets its transport here.
installChatLifecycle();

// Wire admin WS handling: register the transport initializer that opens the
// admin WS on first admin scope subscribe (gated on bearer being set).
installAdminLifecycle();

// ---------------------------------------------------------------------------
// SharedWorker `onconnect` — fires once per tab
// ---------------------------------------------------------------------------

declare const self: SharedWorkerGlobalScope;

self.onconnect = (event: MessageEvent) => {
  const port = event.ports[0];
  if (!port) return;
  const channel = new PortTabChannel(port);
  attachChannel(channel);
};

// ---------------------------------------------------------------------------
// Per-channel envelope dispatch
// ---------------------------------------------------------------------------

function attachChannel(channel: TabChannel): void {
  const sendToTab = (frame: WorkerToTab): void => {
    channel.postMessage(frame);
  };

  channel.onMessage((envelope) => {
    const result = TabToWorker.safeParse(envelope);
    if (!result.success) {
      console.warn('[worker] invalid envelope', result.error.issues);
      return;
    }
    void dispatchEnvelope(channel, result.data, sendToTab);
  });

  channel.onClose(() => {
    handleChannelClose(channel);
  });
}

async function dispatchEnvelope(
  channel: TabChannel,
  envelope: TabToWorker,
  sendToTab: (frame: WorkerToTab) => void,
): Promise<void> {
  switch (envelope.kind) {
    case 'hello':
      sendToTab({ kind: 'hello-ack', workerVersion: WORKER_VERSION });
      console.info('[worker] hello', { tabId: envelope.tabId, workerVersion: WORKER_VERSION });
      return;
    case 'subscribe':
      await handleSubscribe(channel, envelope.scope, envelope.requestId, sendToTab);
      return;
    case 'unsubscribe':
      handleUnsubscribe(channel, envelope.scope);
      return;
    case 'action':
      try {
        const result = await dispatchAction(envelope.action);
        sendToTab({ kind: 'ack', requestId: envelope.requestId, ok: true, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendToTab({ kind: 'ack', requestId: envelope.requestId, ok: false, error: message });
      }
      return;
  }
}

// ---------------------------------------------------------------------------
// Subscribe / unsubscribe — implicit identity refcount + hydration
// ---------------------------------------------------------------------------

async function handleSubscribe(
  channel: TabChannel,
  scope: Scope,
  requestId: string,
  sendToTab: (frame: WorkerToTab) => void,
): Promise<void> {
  // First subscriber to a chat-conversation? Hydrate IDB cache + clear unread.
  // Sampled BEFORE the registry add so we can tell global-first apart from
  // tab-first.
  const isFirstForScope = subscriptions.countForScopeKey(scopeKey(scope)) === 0;
  const { isNew } = subscriptions.add(channel, scope);

  // Acquire connection refcount only on a genuinely new (port, scope) pair.
  // Multiple hooks in one tab subscribing to the same admin-target scope must
  // not multi-acquire — the unsubscribe side only fires once per scope.
  if (isNew) {
    const identity = scopeIdentity(scope);
    if (identity !== null) {
      const conn = ensureConnection(identity);
      conn.acquire();
      if (conn.transport && conn.transport.state() === 'disconnected') {
        conn.transport.connect();
      }
    } else if (scope.kind === 'admin-global' || scope.kind === 'admin-target') {
      acquireAdminConnection();
    }
  }

  if (scope.kind === 'chat-conversation' && isFirstForScope) {
    await onConversationFirstSubscribe(scope.identity, scope.agent, scope.channel);
  }
  if (scope.kind === 'admin-target' && isFirstForScope) {
    await onAdminTargetFirstSubscribe(scope.target);
  }

  // Always send the snapshot — every subscribe envelope from a tab earns one,
  // even if the (port, scope) is already registered, so the new tab-side
  // handle can hydrate. The unsubscribe side stays balanced because the
  // tab-client only sends a single unsubscribe per scope (gated on its last
  // local handle being released).
  sendToTab({ kind: 'snapshot', scope, snapshot: snapshotFor(scope) });
  sendToTab({ kind: 'ack', requestId, ok: true });
}

function handleUnsubscribe(channel: TabChannel, scope: Scope): void {
  const removed = subscriptions.removeByPortAndScope(channel, scope);
  if (!removed) return;
  releaseSubscription(removed);
  maybeDropConversationCache(scope);
}

function handleChannelClose(channel: TabChannel): void {
  const removed = subscriptions.removeAllByPort(channel);
  for (const sub of removed) {
    releaseSubscription(sub);
    maybeDropConversationCache(sub.scope);
  }
}

function releaseSubscription(sub: Subscription): void {
  if (sub.scope.kind === 'admin-global' || sub.scope.kind === 'admin-target') {
    releaseAdminConnection();
    return;
  }
  const identity = scopeIdentity(sub.scope);
  if (identity === null) return;
  const conn = connections.get(identity);
  if (conn) conn.release();
}

function maybeDropConversationCache(scope: Scope): void {
  if (scope.kind !== 'chat-conversation') return;
  if (subscriptions.countForScopeKey(scopeKey(scope)) > 0) return;
  const conn = connections.get(scope.identity);
  if (!conn) return;
  // No remaining viewers — drop the cache to bound memory. New subscribers
  // will re-hydrate from IDB.
  conn.conversations.delete(`${scope.agent}:${scope.channel}`);
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

async function dispatchAction(action: Action): Promise<unknown> {
  switch (action.kind) {
    case 'register-identity':
      return registerIdentity(action.name);

    case 'send-message':
      return sendMessage(action.identity, action.agent, action.channel, action.text, action.clientMsgId, action.attachments);

    case 'respond-to-approval':
      respondToApproval(action.identity, action.agent, action.approvalId, action.decision);
      return undefined;

    case 'explain-approval':
      return explainApproval(action.identity, action.agent, action.channel, action.approvalId, action.summary);

    case 'refresh-agents':
      refreshAgents(action.identity);
      return undefined;

    case 'refresh-discover':
      refreshDiscover(action.identity);
      return undefined;

    case 'dismiss-toast':
      dismissToast(action.identity, action.toastId);
      return undefined;

    case 'get-attachment':
      return getAttachment(action.hash);

    case 'connect-admin':
      connectAdmin(action.bearer);
      return undefined;

    case 'disconnect-admin':
      disconnectAdmin();
      return undefined;

    case 'write-echo':
      await writeEcho(action.target, action.msg);
      return undefined;

    case 'write-echo-before-last':
      await writeEchoBeforeLast(action.target, action.msg);
      return undefined;

    case 'rollback-echo':
      rollbackEcho(action.target, action.echoId);
      return undefined;

    case 'mark-admin-target-read':
      markAdminTargetRead(action.target);
      return undefined;
  }
}
