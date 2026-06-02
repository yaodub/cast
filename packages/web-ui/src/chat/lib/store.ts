/**
 * Chat surface facade — thin per-tab projections of worker-owned state.
 *
 * Every "live" signal (`messages`, `agents`, `unread`, `typing`, ...) is
 * mirrored from a worker scope subscription; every write action is a
 * `worker.send({...})` dispatch. Per-tab UI state stays here:
 * `activeAgent`, `activeChannel`, `pendingFiles`, drafts.
 *
 * Multi-identity per tab: each tab is bound to one identity at a time
 * (URL-driven). Switching identity tears down the old chat-identity +
 * chat-conversation subscriptions and re-subscribes for the new identity.
 */

import { signal } from '@preact/signals';
import { navigate as wouterNavigate } from 'wouter/use-browser-location';

import { worker } from '../../lib/worker-client';
import {
  addIdentity, getIdentities, getIdentityByHandle, onIdentityBroadcast,
  removeIdentity, setActiveHandle,
} from '../../lib/identity';
import type {
  AdminTarget as _AdminTarget,
  ChatConversationSnapshot,
  ChatIdentitySnapshot,
  MessageAttachment,
  MessageMeta,
  StoredMessage,
  Toast,
} from '../../worker/protocol';

// Re-export types — components import them from here.
export type { MessageAttachment, MessageMeta, StoredMessage, Toast };

// ---------------------------------------------------------------------------
// Per-tab UI state
// ---------------------------------------------------------------------------

export const phase = signal<'register' | 'connecting' | 'main'>('connecting');
export const activeAgent = signal<string | null>(null);
export const activeChannel = signal<string>('default');
export const error = signal<string | null>(null);

export interface PendingFile {
  id: string;
  file: File;
  preview?: string;
}

export const pendingFiles = signal<PendingFile[]>([]);

// ---------------------------------------------------------------------------
// Worker-projected signals — populated by subscriptions
// ---------------------------------------------------------------------------

export const agents = signal<ChatIdentitySnapshot['agents']>([]);
export const discovered = signal<ChatIdentitySnapshot['discovered']>([]);
export const unread = signal<Record<string, number>>({});
export const toasts = signal<Toast[]>([]);
export const messages = signal<StoredMessage[]>([]);
export const typing = signal<boolean>(false);
export const lifecycle = signal<string | null>(null);
export const previews = signal<ChatConversationSnapshot['previews']>([]);

/** Connection state for THIS TAB's bound identity. Mirrors the worker's WS state. */
export const connectionState = signal<ChatIdentitySnapshot['connectionState']>('disconnected');

// SIDE EFFECT: Active subscriptions held in module scope so the URL-driven
// identity / conversation switcher can dispose them before re-subscribing.
let activeIdentity: string | null = null;
let identitySub: (() => void) | null = null;
let conversationSub: (() => void) | null = null;

// ---------------------------------------------------------------------------
// init — runs once on App mount
// ---------------------------------------------------------------------------

let initialized = false;

export function init(): void {
  if (initialized) return;
  initialized = true;

  // Listen for cross-tab identity removal (BroadcastChannel from `removeIdentity`).
  onIdentityBroadcast((msg) => {
    if (msg.kind === 'removed' && msg.handle === activeIdentity) {
      // Local tab's bound identity was removed in another tab — drop subs, revert.
      teardownIdentity();
      phase.value = 'register';
    }
  });

  // Surface identity-registered ambient events so a sibling tab finishing
  // registration shows up here without a manual reload (informational only;
  // the active tab handles its own success ack).

  if (getIdentities().length === 0) {
    phase.value = 'register';
    return;
  }

  // Identity selection is URL-driven (handled by Sync component); init
  // leaves phase='connecting' until Sync wires up.
  phase.value = 'connecting';
}

// ---------------------------------------------------------------------------
// setActiveIdentity — called by Sync component on URL change
// ---------------------------------------------------------------------------

/**
 * Bind this tab to an identity. Called by the URL-driven Sync component.
 * Subscriptions held until the next call (or unmount via teardownIdentity).
 */
export function setActiveIdentity(handle: string): void {
  if (activeIdentity === handle) return;
  teardownIdentity();
  activeIdentity = handle;
  setActiveHandle(handle);

  // Reset projected signals to defaults; subscription snapshot will repopulate.
  agents.value = [];
  discovered.value = [];
  unread.value = {};
  toasts.value = [];
  error.value = null;
  phase.value = 'connecting';

  identitySub = worker.subscribe(
    { kind: 'chat-identity', identity: handle },
    (data: ChatIdentitySnapshot) => {
      agents.value = data.agents;
      discovered.value = data.discovered;
      unread.value = data.unread;
      toasts.value = data.toasts;
      error.value = data.error;
      phase.value = data.phase;
      connectionState.value = data.connectionState;
    },
  );
}

function teardownIdentity(): void {
  identitySub?.();
  conversationSub?.();
  identitySub = null;
  conversationSub = null;
  activeIdentity = null;
  activeAgent.value = null;
  activeChannel.value = 'default';
  messages.value = [];
  typing.value = false;
  lifecycle.value = null;
}

// ---------------------------------------------------------------------------
// Active conversation — drives chat-conversation subscription
// ---------------------------------------------------------------------------

export function setActiveConversation(agent: string, ch: string): void {
  activeAgent.value = agent;
  activeChannel.value = ch;
  conversationSub?.();
  conversationSub = null;

  if (!activeIdentity) {
    messages.value = [];
    typing.value = false;
    lifecycle.value = null;
    previews.value = [];
    return;
  }

  // Reset cache while loading; subscription snapshot will repopulate.
  messages.value = [];
  typing.value = false;
  lifecycle.value = null;
  previews.value = [];

  conversationSub = worker.subscribe(
    { kind: 'chat-conversation', identity: activeIdentity, agent, channel: ch },
    (data: ChatConversationSnapshot) => {
      messages.value = data.messages;
      typing.value = data.typing;
      lifecycle.value = data.lifecycle;
      previews.value = data.previews;
    },
  );
}

export function clearActiveConversation(): void {
  conversationSub?.();
  conversationSub = null;
  activeAgent.value = null;
  activeChannel.value = 'default';
  messages.value = [];
  typing.value = false;
  lifecycle.value = null;
  previews.value = [];
}

// ---------------------------------------------------------------------------
// Send message + attachments
// ---------------------------------------------------------------------------

export async function sendMessage(text: string): Promise<void> {
  if (!activeIdentity) return;
  const agent = activeAgent.value;
  if (!agent) return;
  const channel = activeChannel.value;

  const staged = pendingFiles.value;
  const attachments = staged.length > 0
    ? await Promise.all(staged.map(async (pf) => ({
      clientId: pf.id,
      filename: pf.file.name,
      mimeType: pf.file.type || 'application/octet-stream',
      bytes: new Uint8Array(await pf.file.arrayBuffer()),
    })))
    : undefined;
  if (staged.length > 0) clearPendingFiles();

  const clientMsgId = crypto.randomUUID();
  // Transfer attachment bytes (zero-copy via Transferable) so multi-MB uploads
  // don't pay the structured-clone copy tax.
  const transfer: Transferable[] = attachments?.map((a) => a.bytes.buffer) ?? [];

  await worker.send(
    {
      kind: 'send-message',
      identity: activeIdentity,
      agent,
      channel,
      text,
      clientMsgId,
      attachments,
    },
    transfer,
  );
}

// ---------------------------------------------------------------------------
// Pending attachment staging
// ---------------------------------------------------------------------------

export function stageFiles(files: File[] | FileList): void {
  const newFiles: PendingFile[] = [];
  for (const file of files) {
    const pf: PendingFile = { id: crypto.randomUUID(), file };
    if (file.type.startsWith('image/')) {
      pf.preview = URL.createObjectURL(file);
    }
    newFiles.push(pf);
  }
  pendingFiles.value = [...pendingFiles.value, ...newFiles];
}

export function unstageFile(id: string): void {
  const removed = pendingFiles.value.find((f) => f.id === id);
  if (removed?.preview) URL.revokeObjectURL(removed.preview);
  pendingFiles.value = pendingFiles.value.filter((f) => f.id !== id);
}

export function clearPendingFiles(): void {
  for (const f of pendingFiles.value) {
    if (f.preview) URL.revokeObjectURL(f.preview);
  }
  pendingFiles.value = [];
}

// ---------------------------------------------------------------------------
// Identity actions
// ---------------------------------------------------------------------------

export function navigateTo(agent: string, ch?: string): void {
  if (!activeIdentity) return;
  const handleId = activeIdentity.startsWith('web:') ? activeIdentity.slice(4) : activeIdentity;
  const channelPart = ch && ch !== 'default' ? `/${ch}` : '';
  wouterNavigate(`/chat/${handleId}/${agent}${channelPart}`);
}

export function navigateToIdentity(handle: string): void {
  const handleId = handle.startsWith('web:') ? handle.slice(4) : handle;
  wouterNavigate(`/chat/${handleId}`);
}

/**
 * Switch THIS TAB to a different identity. Other tabs unaffected.
 * Updates `cast-active-identity` localStorage as the "default for fresh
 * tabs without URL identity" semantic.
 */
export function switchIdentity(handle: string): void {
  setActiveHandle(handle);
  navigateToIdentity(handle);
  // setActiveIdentity will be called by the Sync component after the URL change.
}

/** Open a new browser tab bound to the given identity. */
export function openIdentityInNewTab(handle: string): void {
  const handleId = handle.startsWith('web:') ? handle.slice(4) : handle;
  window.open(`/chat/${handleId}`, '_blank', 'noopener');
}

/**
 * Remove an identity. Broadcasts to sibling tabs (which revert if they were
 * viewing it). If THIS tab was viewing the removed identity, also revert.
 */
export function removeIdentityAndNotify(handle: string): void {
  removeIdentity(handle);
  if (activeIdentity === handle) {
    teardownIdentity();
    phase.value = getIdentities().length === 0 ? 'register' : 'connecting';
    wouterNavigate('/chat/', { replace: true });
  }
}

export async function register(name: string): Promise<void> {
  const result = await worker.send<{ identity: string; identityId: string; name: string }>({
    kind: 'register-identity',
    name,
  });
  addIdentity(result.identity, result.name, result.identityId);
  setActiveHandle(result.identity);
  navigateToIdentity(result.identity);
}

// ---------------------------------------------------------------------------
// Approval handlers + misc dispatchers
// ---------------------------------------------------------------------------

export function respondToApproval(approvalId: string, decision: 'approved' | 'rejected'): void {
  if (!activeIdentity) return;
  const agent = activeAgent.value;
  if (!agent) return;
  void worker.send({
    kind: 'respond-to-approval',
    identity: activeIdentity,
    agent,
    approvalId,
    decision,
  });
}

export function explainApproval(approvalId: string, summary: string): void {
  if (!activeIdentity) return;
  const agent = activeAgent.value;
  if (!agent) return;
  void worker.send({
    kind: 'explain-approval',
    identity: activeIdentity,
    agent,
    channel: activeChannel.value,
    approvalId,
    summary,
  });
}

export function refreshAgents(): void {
  if (!activeIdentity) return;
  void worker.send({ kind: 'refresh-agents', identity: activeIdentity });
}

export function refreshDiscover(): void {
  if (!activeIdentity) return;
  void worker.send({ kind: 'refresh-discover', identity: activeIdentity });
}

export function dismissToast(id: string): void {
  if (!activeIdentity) return;
  void worker.send({ kind: 'dismiss-toast', identity: activeIdentity, toastId: id });
}

export function renameUser(newName: string): void {
  // Renames are expressed as a chat `/name <name>` message into the active
  // conversation. The server picks it up and re-emits the agents list with
  // the updated display name. Also updates localStorage immediately for
  // responsive UI.
  void sendMessage(`/name ${newName}`);
  if (!activeIdentity) return;
  const identities = getIdentities();
  const updated = identities.map((i) =>
    i.handle === activeIdentity ? { ...i, name: newName } : i,
  );
  localStorage.setItem('cast-identities', JSON.stringify(updated));
}

// ---------------------------------------------------------------------------
// Attachment lookup — pulled from worker (which owns IDB)
// ---------------------------------------------------------------------------

export async function getAttachment(
  hash: string,
): Promise<{ blob: Uint8Array; mimeType: string; filename: string } | null> {
  return worker.send<{ blob: Uint8Array; mimeType: string; filename: string } | null>({
    kind: 'get-attachment',
    hash,
  });
}
