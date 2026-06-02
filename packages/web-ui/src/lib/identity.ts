/**
 * Identity manager — localStorage-backed storage for web: handles.
 *
 * Multi-tab semantics:
 *   - `cast-identities`: shared across tabs of this origin (the identity catalog).
 *   - `cast-active-identity`: "default for fresh tabs without URL identity",
 *     not "global active". Each tab is bound to one identity at a time via URL.
 *   - `BroadcastChannel('cast-identity')`: notifies sibling tabs when an
 *     identity is removed so they can revert their own tab to register if
 *     they were viewing that identity.
 */

const STORAGE_KEY = 'cast-identities';
const ACTIVE_KEY = 'cast-active-identity';

const IDENTITY_CHANNEL = 'cast-identity';

export type IdentityBroadcast =
  | { kind: 'removed'; handle: string };

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel {
  if (!channel) channel = new BroadcastChannel(IDENTITY_CHANNEL);
  return channel;
}

/** Subscribe to cross-tab identity events. Returns an unsubscribe function. */
export function onIdentityBroadcast(handler: (msg: IdentityBroadcast) => void): () => void {
  const ch = getChannel();
  const wrapper = (e: MessageEvent): void => handler(e.data as IdentityBroadcast);
  ch.addEventListener('message', wrapper);
  return () => ch.removeEventListener('message', wrapper);
}

function emitBroadcast(msg: IdentityBroadcast): void {
  getChannel().postMessage(msg);
}

export interface StoredIdentity {
  handle: string;
  name: string;
  identity: string;
  createdAt: string;
}

function load(): StoredIdentity[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function save(identities: StoredIdentity[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identities));
}

export function getIdentities(): StoredIdentity[] {
  return load();
}

export function addIdentity(handle: string, name: string, identity: string): void {
  const list = load();
  list.push({ handle, name, identity, createdAt: new Date().toISOString() });
  save(list);
}

export function removeIdentity(handle: string): void {
  save(load().filter((i) => i.handle !== handle));
  if (getActiveHandle() === handle) {
    localStorage.removeItem(ACTIVE_KEY);
  }
  emitBroadcast({ kind: 'removed', handle });
}

export function getActiveHandle(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveHandle(handle: string): void {
  localStorage.setItem(ACTIVE_KEY, handle);
}

export function getActiveIdentity(): StoredIdentity | null {
  const handle = getActiveHandle();
  if (!handle) return null;
  return load().find((i) => i.handle === handle) ?? null;
}

export function getIdentityByHandle(handle: string): StoredIdentity | null {
  return load().find((i) => i.handle === handle) ?? null;
}
