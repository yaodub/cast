/**
 * WhatsApp extension — SQLite-backed store (contact-identity model).
 *
 * Data model: every logical human/group is a row in `contacts` with a
 * stable `contact_id`. Every JID form (PN, LID, group) is an entry in
 * `jid_aliases` pointing at its contact. Messages are keyed on
 * `(id, contact_id)`. When WhatsApp reveals two JIDs are the same human,
 * we merge contact_ids instead of rewriting the messages table.
 *
 * Pair learning sources (all authoritative, server-attested):
 *   - creds.me self pair
 *   - auth/lid-mapping-*.json files (forward + reverse)
 *   - messaging-history.set: messages, contacts, chats (with lidJid/pnJid),
 *     group participants
 *   - messages.upsert: key.remoteJidAlt + participantAlt
 *   - contacts.upsert / contacts.update: phoneNumber + lid
 *   - group-participants.update: participant.lid + phoneNumber
 *
 * Display name is materialized at contact-write time in ContactResolver
 * using the hierarchy: phonebook_name → verified_name → given_name →
 * formatted PN → raw JID. Tools read `contacts.display_name` directly.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import type { Chat, ChatUpdate, Contact, GroupMetadata, GroupParticipant, WAMessage } from '@whiskeysockets/baileys';
import type { Logger } from '@getcast/extension-schema';
import { noopLogger } from '@getcast/extension-schema';

import { ContactResolver, type ContactRow } from './contact-resolver.js';
import type {
  ChatExt,
  ChatUpdateExt,
  ContactExt,
  GroupParticipantExt,
  WAMessageKeyExt,
} from './baileys-ext.js';
import {
  extractPnLidPair,
  getMediaType,
  isGroupJid,
  normalizeJid,
  normalizeTimestamp,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MEDIA_ENTRIES = 500;
/** contact_id used for `fromMe` senders when resolver hasn't seen our own JID. */
const SELF_CONTACT_SENTINEL = -1;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class WhatsAppStore {
  private db: Database.Database;
  private log: Logger;
  private readonly authDir: string;

  readonly resolver: ContactResolver;

  /** Raw WAMessage objects for media messages — needed for downloadMediaMessage(). */
  readonly mediaMessages = new Map<string, WAMessage>();

  /**
   * Callback for live (notify-type) messages. Set by watch-manager.
   * Passes the contact_id of the thread the messages arrived in.
   */
  onNewMessages: ((contactId: number, messages: WAMessage[]) => void) | null = null;

  private stmts!: ReturnType<typeof prepareStatements>;

  /** Cached contact_id of the authenticated account. Resolved lazily because
   *  the store can be constructed before the device is paired. */
  private selfContactId: number | null = null;

  constructor(opts: { dbPath: string; authDir: string; log?: Logger }) {
    fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.db = new Database(opts.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.authDir = opts.authDir;
    this.log = opts.log ?? noopLogger;

    this.createSchema();
    this.stmts = prepareStatements(this.db);

    this.resolver = new ContactResolver(this.db, this.log);
    this.resolver.onMerge = (surviving, subsumed) => this.rekeyMessagesForMerge(surviving, subsumed);
    this.resolver.seedFromAuthDir(opts.authDir);

    // Try to seed the self contact. Safe to miss — `getSelfContactId()` will
    // retry lazily on the first fromMe message.
    this.getSelfContactId();
  }

  /**
   * Resolve the authenticated account's contact_id, caching the result.
   * Retries from creds.json on every call while the cache is empty, so a
   * Store constructed pre-pair still picks up self after re-pair without
   * needing a restart.
   */
  private getSelfContactId(): number | null {
    if (this.selfContactId != null) return this.selfContactId;
    try {
      const creds = JSON.parse(fs.readFileSync(path.join(this.authDir, 'creds.json'), 'utf-8'));
      const meId = typeof creds?.me?.id === 'string' ? normalizeJid(creds.me.id) : null;
      if (meId) {
        this.selfContactId = this.resolver.resolveContactId(meId, {
          phonebookName: typeof creds?.me?.name === 'string' ? creds.me.name : undefined,
        });
        return this.selfContactId;
      }
    } catch {
      // unpaired — creds.json missing or unreadable
    }
    return null;
  }

  close(): void {
    this.db.close();
  }

  // =========================================================================
  // Schema
  // =========================================================================

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT NOT NULL,
        contact_id      INTEGER NOT NULL,
        sender_contact_id INTEGER,
        from_me         INTEGER NOT NULL DEFAULT 0,
        timestamp       INTEGER NOT NULL DEFAULT 0,
        text            TEXT,
        media_type      TEXT,
        push_name       TEXT,
        raw_jid         TEXT,  -- original msg.key.remoteJid for Baileys routing
        raw_json        TEXT,
        PRIMARY KEY (id, contact_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_contact_ts
        ON messages(contact_id, timestamp);

      CREATE INDEX IF NOT EXISTS idx_messages_text
        ON messages(text) WHERE text IS NOT NULL;
    `);
  }

  // =========================================================================
  // Public ingest — called from connection.ts event wiring
  // =========================================================================

  ingestChats(chats: Chat[]): void {
    const tx = this.db.transaction(() => {
      // Chat objects can carry lidJid/pnJid — learn those pairs, then bump metadata.
      this.learnFromChats(chats);
      for (const chat of chats) {
        if (!chat.id) continue;
        this.upsertChatMeta(chat);
      }
    });
    tx();
  }

  updateChats(updates: ChatUpdate[]): void {
    const tx = this.db.transaction(() => {
      for (const raw of updates) {
        const update = raw as ChatUpdateExt;
        if (!update.id) continue;
        const cid = this.resolver.resolveContactId(update.id, {
          isGroup: isGroupJid(update.id),
          unreadCount: update.unreadCount,
        });
        if (update.conversationTimestamp) {
          this.resolver.bumpLastTs(cid, normalizeTimestamp(update.conversationTimestamp));
        }
        if (update.name) {
          this.resolver.updateContact(cid, { phonebookName: update.name });
        }
      }
    });
    tx();
  }

  ingestContacts(contacts: Contact[]): void {
    const tx = this.db.transaction(() => {
      this.learnFromContacts(contacts);
      for (const c of contacts) this.absorbContactInto(c);
    });
    tx();
  }

  updateContacts(updates: Array<Partial<Contact>>): void {
    const tx = this.db.transaction(() => {
      this.learnFromContacts(updates);
      for (const u of updates) this.absorbContactInto(u);
    });
    tx();
  }

  ingestMessages(messages: WAMessage[], type: 'append' | 'notify'): void {
    const byContactId = new Map<number, WAMessage[]>();
    const tx = this.db.transaction(() => {
      this.learnFromMessages(messages);
      for (const msg of messages) {
        const cid = this.ingestSingleMessage(msg);
        if (cid == null) continue;
        let list = byContactId.get(cid);
        if (!list) { list = []; byContactId.set(cid, list); }
        list.push(msg);
      }
    });
    tx();

    if (type === 'notify' && this.onNewMessages) {
      for (const [cid, msgs] of byContactId) this.onNewMessages(cid, msgs);
    }
  }

  ingestHistoryMessages(data: {
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
  }): void {
    const tx = this.db.transaction(() => {
      this.learnFromChats(data.chats);
      this.learnFromContacts(data.contacts);
      this.learnFromMessages(data.messages);

      for (const chat of data.chats) {
        if (chat.id) this.upsertChatMeta(chat);
      }
      for (const c of data.contacts) this.absorbContactInto(c);
      for (const msg of data.messages) this.ingestSingleMessage(msg);
    });
    tx();
  }

  /**
   * Handle group metadata events. Group participants carry `{id, phoneNumber, lid}`
   * per member — each pair is authoritative.
   */
  ingestGroupMetadata(groups: GroupMetadata[]): void {
    const tx = this.db.transaction(() => {
      for (const g of groups) {
        if (!g.id) continue;
        this.resolver.resolveContactId(g.id, { isGroup: true, phonebookName: g.subject });
        this.learnFromGroupParticipants(g.participants ?? []);
      }
    });
    tx();
  }

  ingestGroupParticipantsUpdate(update: { id: string; participants: GroupParticipant[] }): void {
    const tx = this.db.transaction(() => {
      this.resolver.resolveContactId(update.id, { isGroup: true });
      this.learnFromGroupParticipants(update.participants ?? []);
    });
    tx();
  }

  // =========================================================================
  // Pair source helpers
  // =========================================================================

  private learnFromMessages(messages: WAMessage[]): void {
    for (const msg of messages) {
      const k = msg.key as WAMessageKeyExt;
      {
        const pair = extractPnLidPair(k.remoteJid, k.remoteJidAlt);
        if (pair.pn && pair.lid) this.resolver.learnPair(pair.pn, pair.lid);
      }
      {
        const pair = extractPnLidPair(k.participant, k.participantAlt);
        if (pair.pn && pair.lid) this.resolver.learnPair(pair.pn, pair.lid);
      }
    }
  }

  private learnFromContacts(contacts: Array<ContactExt>): void {
    for (const c of contacts) {
      const pnFromPhone = phoneToJidMaybe(c.phoneNumber);
      const candidates = [c.id, c.lid, pnFromPhone];
      const pair = extractPnLidPair(
        candidates.find(j => j && j.endsWith('@s.whatsapp.net')),
        candidates.find(j => j && j.endsWith('@lid')),
      );
      if (pair.pn && pair.lid) this.resolver.learnPair(pair.pn, pair.lid);
    }
  }

  private learnFromChats(chats: Chat[]): void {
    for (const raw of chats) {
      const chat = raw as ChatExt;
      const pair = extractPnLidPair(chat.pnJid, chat.lidJid);
      if (pair.pn && pair.lid) this.resolver.learnPair(pair.pn, pair.lid);
    }
  }

  private learnFromGroupParticipants(participants: GroupParticipant[]): void {
    for (const raw of participants) {
      const p = raw as GroupParticipantExt;
      const candidates = [p.id, p.lid, phoneToJidMaybe(p.phoneNumber)];
      const pair = extractPnLidPair(
        candidates.find(j => j && j.endsWith('@s.whatsapp.net')),
        candidates.find(j => j && j.endsWith('@lid')),
      );
      if (pair.pn && pair.lid) this.resolver.learnPair(pair.pn, pair.lid);
    }
  }

  // =========================================================================
  // Single-event ingest
  // =========================================================================

  private absorbContactInto(c: ContactExt): void {
    if (!c.id) return;
    this.resolver.resolveContactId(c.id, {
      phonebookName: c.name ?? undefined,
      givenName: c.notify ?? undefined,
      verifiedName: c.verifiedName ?? undefined,
    });
    // Also register any PN/LID alias we didn't already attach via learnPair
    if (c.lid) this.resolver.resolveContactId(c.lid);
    const pnFromPhone = phoneToJidMaybe(c.phoneNumber);
    if (pnFromPhone) this.resolver.resolveContactId(pnFromPhone);
  }

  private upsertChatMeta(chat: Chat): void {
    const c = chat as ChatExt;
    if (!c.id) return;
    this.resolver.resolveContactId(c.id, {
      isGroup: isGroupJid(c.id),
      phonebookName: c.name ?? undefined,
      lastTs: c.conversationTimestamp ? normalizeTimestamp(c.conversationTimestamp) : undefined,
      unreadCount: c.unreadCount ?? undefined,
    });
  }

  private ingestSingleMessage(msg: WAMessage): number | null {
    const id = msg.key.id;
    const rawJid = msg.key.remoteJid;
    if (!id || !rawJid) return null;

    const contactId = this.resolver.resolveContactId(rawJid, {
      isGroup: isGroupJid(rawJid),
      givenName: msg.pushName && !msg.key.fromMe ? msg.pushName : undefined,
      lastTs: normalizeTimestamp(msg.messageTimestamp),
    });

    const text = extractText(msg);
    const mediaType = getMediaType(msg);
    if (!text && !mediaType && !msg.message) return contactId;

    const participant = msg.key.participant;
    let senderContactId: number;
    if (msg.key.fromMe) {
      senderContactId = this.getSelfContactId() ?? SELF_CONTACT_SENTINEL;
    } else if (participant) {
      senderContactId = this.resolver.resolveContactId(participant, {
        givenName: msg.pushName ?? undefined,
      });
    } else {
      senderContactId = contactId;
    }

    this.stmts.upsertMessage.run({
      id,
      contact_id: contactId,
      sender_contact_id: senderContactId,
      from_me: msg.key.fromMe ? 1 : 0,
      timestamp: normalizeTimestamp(msg.messageTimestamp),
      text,
      media_type: mediaType,
      push_name: msg.pushName ?? null,
      raw_jid: rawJid,
      raw_json: JSON.stringify(msg),
    });

    this.retainMedia(msg);
    // last_ts was already bumped by resolveContactId via the lastTs hint above.
    return contactId;
  }

  // =========================================================================
  // Query API — used by extension tool handlers
  // =========================================================================

  /** All contacts (= all threads) sorted by most recent activity. */
  listContacts(limit = 500): ContactRow[] {
    return this.resolver.listContacts(limit);
  }

  /** Admin-UI-shaped list: one row per contact with its preferred display JID. */
  listContactsResolved(limit = 500): Array<{ contactId: number; jid: string; name: string; isGroup: boolean }> {
    return this.resolver.listContacts(limit).map(c => ({
      contactId: c.contact_id,
      jid: this.resolver.getPreferredJid(c.contact_id) ?? `contact-${c.contact_id}`,
      name: c.display_name ?? `contact-${c.contact_id}`,
      isGroup: !!c.is_group,
    }));
  }

  /** Resolve a user query (JID, name, phone digits) to a contact_id. */
  resolveQueryToContactId(query: string): number | null {
    if (!query) return null;
    if (query.includes('@')) return this.resolver.tryResolveContactId(query);
    const matches = this.findContactIdsByQuery(query);
    return matches.length === 1 ? matches[0]! : null;
  }

  /** All candidate matches for an ambiguous query (used by tool error paths). */
  resolveQueryMatches(query: string): Array<{ contactId: number; name: string; jid: string; isGroup: boolean }> {
    if (!query) return [];
    if (query.includes('@')) {
      const cid = this.resolver.tryResolveContactId(query);
      if (cid == null) return [];
      const row = this.resolver.getContact(cid);
      if (!row) return [];
      return [{
        contactId: cid,
        name: row.display_name ?? '',
        jid: this.resolver.getPreferredJid(cid) ?? query,
        isGroup: !!row.is_group,
      }];
    }
    return this.findContactIdsByQuery(query).map(cid => {
      const row = this.resolver.getContact(cid);
      return {
        contactId: cid,
        name: row?.display_name ?? `contact-${cid}`,
        jid: this.resolver.getPreferredJid(cid) ?? `contact-${cid}`,
        isGroup: !!row?.is_group,
      };
    });
  }

  /**
   * Shared candidate search used by both `resolveQueryToContactId` and
   * `resolveQueryMatches`, so the two paths agree on what counts as a hit.
   * Returns contact_ids in insertion order, deduped.
   */
  private findContactIdsByQuery(query: string): number[] {
    const q = query.toLowerCase().trim();
    const seen = new Set<number>();
    const byName = this.db.prepare(`
      SELECT contact_id FROM contacts
      WHERE display_name IS NOT NULL AND lower(display_name) LIKE ?
    `).all(`%${q}%`) as { contact_id: number }[];
    for (const r of byName) seen.add(r.contact_id);
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 5) {
      const byPn = this.db.prepare(`
        SELECT DISTINCT contact_id FROM jid_aliases
        WHERE form = 'pn' AND jid LIKE ?
      `).all(`${digits}@s.whatsapp.net`) as { contact_id: number }[];
      for (const r of byPn) seen.add(r.contact_id);
    }
    return [...seen];
  }

  getMessagesByContact(contactId: number, count = 20): WAMessage[] {
    const rows = this.stmts.getMessagesByContact.all(contactId, count) as { raw_json: string }[];
    return rows.reverse().map(r => JSON.parse(r.raw_json) as WAMessage);
  }

  getMessageByIdAndContact(id: string, contactId: number): WAMessage | undefined {
    const row = this.stmts.getMessageByIdAndContact.get(id, contactId) as { raw_json: string } | undefined;
    return row ? JSON.parse(row.raw_json) as WAMessage : undefined;
  }

  /** Look up a raw WAMessage for media download (by message ID, contact-scoped). */
  getMediaMessage(msgId: string): WAMessage | undefined {
    return this.mediaMessages.get(msgId);
  }

  /** For ACL: check if the raw input JID (any form) belongs to a contact_id. */
  getContactIdForJid(jid: string): number | null {
    return this.resolver.tryResolveContactId(jid);
  }

  /** For ACL dual-form lookup: all alias JIDs for a contact. */
  getAliasesForContact(contactId: number): string[] {
    return this.resolver.getAliases(contactId);
  }

  /** Preferred JID to route outbound messages. */
  getPreferredJid(contactId: number): string | undefined {
    return this.resolver.getPreferredJid(contactId);
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  /**
   * When two contacts merge, re-key the losing contact's messages onto the
   * survivor. Messages are PK'd on (id, contact_id); if the same message
   * exists on both sides (rare, but possible when the same message was
   * delivered under both addressing forms before we learned the pair),
   * keep the survivor's row and drop the loser's.
   */
  private rekeyMessagesForMerge(surviving: number, subsumed: number): void {
    // Drop loser rows that would collide with an existing survivor row
    this.stmts.deleteCollidingMessages.run({ surviving, subsumed });
    this.stmts.rekeyMessageOwner.run({ surviving, subsumed });
    this.stmts.rekeySenderContact.run({ surviving, subsumed });
  }

  /** Retain raw WAMessage for media download. LRU eviction when over cap. */
  private retainMedia(msg: WAMessage): void {
    if (!getMediaType(msg)) return;
    const id = msg.key.id;
    if (!id) return;
    this.mediaMessages.delete(id);
    this.mediaMessages.set(id, msg);
    while (this.mediaMessages.size > MAX_MEDIA_ENTRIES) {
      const oldest = this.mediaMessages.keys().next().value;
      if (oldest) this.mediaMessages.delete(oldest);
      else break;
    }
  }
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

function prepareStatements(db: Database.Database) {
  return {
    upsertMessage: db.prepare(`
      INSERT INTO messages (id, contact_id, sender_contact_id, from_me, timestamp, text, media_type, push_name, raw_jid, raw_json)
      VALUES (@id, @contact_id, @sender_contact_id, @from_me, @timestamp, @text, @media_type, @push_name, @raw_jid, @raw_json)
      ON CONFLICT(id, contact_id) DO UPDATE SET
        text = COALESCE(@text, messages.text),
        media_type = COALESCE(@media_type, messages.media_type),
        raw_json = @raw_json
    `),
    getMessagesByContact: db.prepare(`
      SELECT raw_json FROM messages
      WHERE contact_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `),
    getMessageByIdAndContact: db.prepare(`
      SELECT raw_json FROM messages
      WHERE id = ? AND contact_id = ?
      LIMIT 1
    `),
    deleteCollidingMessages: db.prepare(`
      DELETE FROM messages
      WHERE contact_id = @subsumed
        AND id IN (SELECT id FROM messages WHERE contact_id = @surviving)
    `),
    rekeyMessageOwner: db.prepare(`
      UPDATE messages SET contact_id = @surviving WHERE contact_id = @subsumed
    `),
    rekeySenderContact: db.prepare(`
      UPDATE messages SET sender_contact_id = @surviving WHERE sender_contact_id = @subsumed
    `),
  };
}

// ---------------------------------------------------------------------------
// Text extraction (inlined to avoid circular dep concerns)
// ---------------------------------------------------------------------------

function extractText(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  return null;
}

/** Convert a Baileys `phoneNumber` field to a PN JID, or undefined if empty.
 *  Accepts raw digits, formatted phone strings, or pre-formed JIDs. */
function phoneToJidMaybe(phoneNumber: string | undefined): string | undefined {
  if (!phoneNumber) return undefined;
  if (phoneNumber.includes('@')) return phoneNumber;
  const digits = phoneNumber.replace(/\D/g, '');
  if (!digits) return undefined;
  return `${digits}@s.whatsapp.net`;
}
