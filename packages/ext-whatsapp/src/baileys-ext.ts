/**
 * Baileys structural extensions.
 *
 * Baileys 7.0.0-rc.9 emits a handful of fields — the PN↔LID pair fields on
 * message keys, chats, contacts, chat updates, and group participants — that
 * are present at runtime but not declared on its public types. Rather than
 * scatter `as { … }` casts across the store, we centralize the shapes here.
 *
 * When Baileys' types catch up (track GH #2263 / #2376), this file goes away.
 */
import type { Chat, ChatUpdate, Contact, GroupParticipant, WAMessage } from '@whiskeysockets/baileys';

/** WAMessage key with the LID/PN alt fields Baileys attaches at runtime. */
export type WAMessageKeyExt = WAMessage['key'] & {
  remoteJidAlt?: string;
  participantAlt?: string;
};

/** Chat with the PN/LID pair fields Baileys attaches to some chats. */
export type ChatExt = Chat & {
  lidJid?: string;
  pnJid?: string;
};

/** Contact update payload — Baileys emits `lid` and `phoneNumber` that aren't
 *  in its own Contact type. */
export type ContactExt = Partial<Contact> & {
  lid?: string;
  phoneNumber?: string;
};

/** ChatUpdate carries `id`, `conversationTimestamp`, `name`, `unreadCount`
 *  dynamically — Baileys types it as a sparse record. */
export type ChatUpdateExt = ChatUpdate & {
  id?: string;
  conversationTimestamp?: number;
  name?: string;
  unreadCount?: number;
};

/** Group participant pairs carry authoritative `lid` and `phoneNumber`. */
export type GroupParticipantExt = GroupParticipant & {
  lid?: string;
  phoneNumber?: string;
};
