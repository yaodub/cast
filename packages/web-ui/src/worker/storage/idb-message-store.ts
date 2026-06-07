/**
 * IndexedDB implementation of MessageStore. Owns the `cast-web-client`
 * schema — DB_NAME / DB_VERSION / object stores were originally defined in
 * `lib/db.ts` (since deleted); the schema and key layout were
 * carried verbatim into this worker module so existing browser data
 * continues to load on first run. IDB is available in Worker globals.
 */

import type { MessageStore } from '../interfaces';
import type { AdminTarget, AdminChatMessage, ChatConversationScope, StoredMessage } from '../protocol';

const DB_NAME = 'cast-web-client';
const DB_VERSION = 2;
const MSG_STORE = 'messages';
const ATT_STORE = 'attachments';
const MAX_ATT_BYTES = 50 * 1024 * 1024;

const ADMIN_IDENTITY = 'admin:local';

interface StoredAttachment {
  hash: string;
  blob: Uint8Array;
  mimeType: string;
  filename: string;
  size: number;
  timestamp: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(MSG_STORE)) db.deleteObjectStore(MSG_STORE);
      if (db.objectStoreNames.contains(ATT_STORE)) db.deleteObjectStore(ATT_STORE);

      const msgs = db.createObjectStore(MSG_STORE, { keyPath: 'id' });
      msgs.createIndex('conversation', ['identity', 'agent', 'channel'], { unique: false });

      const atts = db.createObjectStore(ATT_STORE, { keyPath: 'hash' });
      atts.createIndex('timestamp', 'timestamp', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function adminTargetToStorageKey(target: AdminTarget): { agent: string; channel: string } {
  // Match the legacy admin/lib/chat-message-store.ts:19-23 shape so existing
  // `cast-web-client` IDB data carries forward without migration: managers
  // are keyed `(agent: <slug>, channel: 'default')`, not the inverted form.
  return target.kind === 'agent'
    ? { agent: target.alias, channel: target.channel }
    : { agent: target.slug, channel: 'default' };
}

export class IDBMessageStore implements MessageStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = open();
    return this.dbPromise;
  }

  async getByConversation(scope: ChatConversationScope): Promise<StoredMessage[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MSG_STORE, 'readonly');
      const idx = tx.objectStore(MSG_STORE).index('conversation');
      const req = idx.getAll(IDBKeyRange.only([scope.identity, scope.agent, scope.channel]));
      req.onsuccess = () => {
        const all = req.result as StoredMessage[];
        resolve(all.sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getByAdminTarget(target: AdminTarget): Promise<AdminChatMessage[]> {
    const { agent, channel } = adminTargetToStorageKey(target);
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MSG_STORE, 'readonly');
      const idx = tx.objectStore(MSG_STORE).index('conversation');
      const req = idx.getAll(IDBKeyRange.only([ADMIN_IDENTITY, agent, channel]));
      req.onsuccess = () => {
        const stored = req.result as StoredMessage[];
        const sorted = stored.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        // Project StoredMessage → AdminChatMessage. AdminChatMessage is the
        // looser passthrough shape used by the admin surface; the discriminating
        // fields (id, type, from, to, text, timestamp) are preserved verbatim.
        resolve(sorted.map((s) => ({
          id: s.id,
          type: s.type ?? 'message',
          from: s.from,
          to: s.to,
          text: s.text,
          timestamp: s.timestamp,
          sessionHash: s.sessionHash,
          ...(s.streamId ? { streamId: s.streamId } : {}),
        })));
      };
      req.onerror = () => reject(req.error);
    });
  }

  async put(msg: StoredMessage): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MSG_STORE, 'readwrite');
      tx.objectStore(MSG_STORE).put(msg);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async putAdmin(target: AdminTarget, msg: AdminChatMessage): Promise<void> {
    const { agent, channel } = adminTargetToStorageKey(target);
    const stored: StoredMessage = {
      id: msg.id,
      identity: ADMIN_IDENTITY,
      agent,
      channel,
      from: msg.from,
      to: msg.to,
      text: msg.text,
      timestamp: msg.timestamp,
      sessionHash: msg.sessionHash ?? null,
      type: msg.type,
      ...(msg.streamId ? { streamId: msg.streamId } : {}),
    };
    return this.put(stored);
  }

  async has(id: string): Promise<boolean> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MSG_STORE, 'readonly');
      const req = tx.objectStore(MSG_STORE).getKey(id);
      req.onsuccess = () => resolve(req.result !== undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async hasAdmin(id: string): Promise<boolean> {
    return this.has(id);
  }

  async delete(id: string): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MSG_STORE, 'readwrite');
      tx.objectStore(MSG_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAttachment(hash: string): Promise<{ blob: Uint8Array; mimeType: string; filename: string } | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ATT_STORE, 'readonly');
      const req = tx.objectStore(ATT_STORE).get(hash);
      req.onsuccess = () => {
        const result = req.result as StoredAttachment | undefined;
        resolve(result ? { blob: result.blob, mimeType: result.mimeType, filename: result.filename } : null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async putAttachment(hash: string, blob: Uint8Array, mimeType: string, filename: string): Promise<void> {
    const db = await this.getDb();
    await this.evictAttachments(db, blob.length);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ATT_STORE, 'readwrite');
      tx.objectStore(ATT_STORE).put({
        hash,
        blob,
        mimeType,
        filename,
        size: blob.length,
        timestamp: Date.now(),
      } satisfies StoredAttachment);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async evictAttachments(db: IDBDatabase, incomingSize: number): Promise<void> {
    const all = await new Promise<StoredAttachment[]>((resolve, reject) => {
      const tx = db.transaction(ATT_STORE, 'readonly');
      const req = tx.objectStore(ATT_STORE).getAll();
      req.onsuccess = () => resolve(req.result as StoredAttachment[]);
      req.onerror = () => reject(req.error);
    });

    let totalSize = all.reduce((sum, a) => sum + a.size, 0) + incomingSize;
    if (totalSize <= MAX_ATT_BYTES) return;

    const sorted = all.sort((a, b) => a.timestamp - b.timestamp);
    const toDelete: string[] = [];
    for (const att of sorted) {
      if (totalSize <= MAX_ATT_BYTES) break;
      toDelete.push(att.hash);
      totalSize -= att.size;
    }

    if (toDelete.length === 0) return;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(ATT_STORE, 'readwrite');
      const store = tx.objectStore(ATT_STORE);
      for (const hash of toDelete) store.delete(hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
