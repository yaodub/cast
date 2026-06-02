/**
 * In-memory MessageStore for tests. Validates that worker code only
 * touches the interface surface — if a hard-coded IDB call slips in,
 * tests using this mock will fail loudly.
 */

import type { MessageStore } from '../interfaces';
import type { AdminTarget, AdminChatMessage, ChatConversationScope, StoredMessage } from '../protocol';

const ADMIN_IDENTITY = 'admin:local';

function adminKey(target: AdminTarget): { agent: string; channel: string } {
  return target.kind === 'agent'
    ? { agent: target.alias, channel: target.channel }
    : { agent: '__manager__', channel: target.slug };
}

export class MockMessageStore implements MessageStore {
  private messages = new Map<string, StoredMessage>();
  private attachments = new Map<string, { blob: Uint8Array; mimeType: string; filename: string }>();

  async getByConversation(scope: ChatConversationScope): Promise<StoredMessage[]> {
    return Array.from(this.messages.values())
      .filter((m) => m.identity === scope.identity && m.agent === scope.agent && m.channel === scope.channel)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async getByAdminTarget(target: AdminTarget): Promise<AdminChatMessage[]> {
    const { agent, channel } = adminKey(target);
    return Array.from(this.messages.values())
      .filter((m) => m.identity === ADMIN_IDENTITY && m.agent === agent && m.channel === channel)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .map((s) => ({
        id: s.id,
        type: s.type ?? 'message',
        from: s.from,
        to: s.to,
        text: s.text,
        timestamp: s.timestamp,
        sessionHash: s.sessionHash,
      }));
  }

  async put(msg: StoredMessage): Promise<void> {
    this.messages.set(msg.id, msg);
  }

  async putAdmin(target: AdminTarget, msg: AdminChatMessage): Promise<void> {
    const { agent, channel } = adminKey(target);
    this.messages.set(msg.id, {
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
    });
  }

  async has(id: string): Promise<boolean> {
    return this.messages.has(id);
  }

  async hasAdmin(id: string): Promise<boolean> {
    return this.has(id);
  }

  async delete(id: string): Promise<void> {
    this.messages.delete(id);
  }

  async getAttachment(hash: string): Promise<{ blob: Uint8Array; mimeType: string; filename: string } | null> {
    return this.attachments.get(hash) ?? null;
  }

  async putAttachment(hash: string, blob: Uint8Array, mimeType: string, filename: string): Promise<void> {
    this.attachments.set(hash, { blob, mimeType, filename });
  }
}
