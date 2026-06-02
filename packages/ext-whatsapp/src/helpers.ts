/**
 * WhatsApp extension — pure helper functions.
 *
 * JID utilities, contact resolution, message formatting, media helpers.
 * No state, no logger, no side effects.
 */
import fs from 'fs';
import path from 'path';

import type { AnyMessageContent } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';

// ---------------------------------------------------------------------------
// Auth check
// ---------------------------------------------------------------------------

/** Check if the auth dir contains a registered (fully paired) session. */
export function isRegistered(authDir: string): boolean {
  const credsPath = path.join(authDir, 'creds.json');
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    return creds.registered === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// JID utilities
// ---------------------------------------------------------------------------

export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

export function isPnJid(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net');
}

export function isLidJid(jid: string): boolean {
  return jid.endsWith('@lid');
}

/**
 * Strip the `:device` suffix that appears on some JIDs (`xxxxxxxxxx:17@s.whatsapp.net`).
 * Leaves the JID unchanged if no device suffix is present.
 */
export function normalizeJid(jid: string): string {
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  const user = jid.slice(0, at);
  const server = jid.slice(at);
  const colon = user.indexOf(':');
  if (colon < 0) return jid;
  return user.slice(0, colon) + server;
}

/**
 * Given a pair of (possibly undefined) JIDs, classify them into `{ pn, lid }` by suffix.
 * Both can be undefined; either can be missing; ignores anything that isn't a PN or LID JID.
 */
export function extractPnLidPair(
  a: string | null | undefined,
  b: string | null | undefined,
): { pn?: string; lid?: string } {
  const out: { pn?: string; lid?: string } = {};
  for (const raw of [a, b]) {
    if (!raw) continue;
    const j = normalizeJid(raw);
    if (isPnJid(j)) out.pn = j;
    else if (isLidJid(j)) out.lid = j;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timestamp normalization
// ---------------------------------------------------------------------------

/**
 * protobuf.js's Long type used throughout Baileys proto definitions. We only
 * need `toNumber()` — unix-seconds timestamps always fit in a JS number.
 */
type Long = { toNumber(): number };

/** Normalize protobuf Long | number | null to plain number (unix seconds). */
export function normalizeTimestamp(ts: number | Long | null | undefined): number {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  return ts.toNumber();
}

// ---------------------------------------------------------------------------
// Timeout utility
// ---------------------------------------------------------------------------

export function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message ?? 'Timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

export interface FormattedMessage {
  id: string;
  timestamp: number;
  sender: string;
  text: string;
  hasMedia: boolean;
  mediaType?: string;
}

/**
 * Extract displayable content from a WAMessage. `senderName` is pre-resolved
 * by the caller using the ContactResolver (the display_name layer handles
 * all name fallbacks centrally, so helpers stay pure).
 */
export function formatMessage(msg: WAMessage, senderName: string): FormattedMessage {
  const id = msg.key.id ?? '';
  const timestamp = normalizeTimestamp(msg.messageTimestamp);
  const fromMe = msg.key.fromMe ?? false;
  const sender = fromMe ? 'You' : senderName;
  const mediaType = getMediaType(msg);
  const text = extractTextContent(msg) ?? (mediaType ? mediaPlaceholder(msg) : '');

  return {
    id,
    timestamp,
    sender,
    text: mediaType && text ? `${mediaPlaceholder(msg)} ${text}` : text,
    hasMedia: mediaType !== null,
    mediaType: mediaType ?? undefined,
  };
}

/** Extract plain text content from a message, or null if media-only. */
function extractTextContent(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;

  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  if (m.listResponseMessage?.title) return m.listResponseMessage.title;
  if (m.buttonsResponseMessage?.selectedDisplayText) return m.buttonsResponseMessage.selectedDisplayText;

  return null;
}

/** Get the media type of a message, or null if not media. */
export function getMediaType(msg: WAMessage): 'image' | 'video' | 'audio' | 'document' | 'sticker' | null {
  const m = msg.message;
  if (!m) return null;
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return 'audio';
  if (m.documentMessage) return 'document';
  if (m.stickerMessage) return 'sticker';
  return null;
}

function mediaPlaceholder(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return '';
  if (m.imageMessage) return '[image]';
  if (m.videoMessage) return '[video]';
  if (m.audioMessage) return m.audioMessage.ptt ? '[voice note]' : '[audio]';
  if (m.documentMessage) {
    const name = m.documentMessage.fileName;
    return name ? `[document: ${name}]` : '[document]';
  }
  if (m.stickerMessage) return '[sticker]';
  if (m.contactMessage) return '[contact]';
  if (m.contactsArrayMessage) return '[contacts]';
  if (m.locationMessage) return '[location]';
  return '';
}

// ---------------------------------------------------------------------------
// Media helpers
// ---------------------------------------------------------------------------

const EXTENSION_MIMETYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
};

export function mimetypeFromExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_MIMETYPES[ext] ?? 'application/octet-stream';
}

/** Build Baileys media content object from a file buffer. */
export function buildMediaContent(
  buffer: Buffer,
  filename: string,
  mimetype: string,
  caption?: string,
): AnyMessageContent {
  if (mimetype.startsWith('image/')) {
    return { image: buffer, caption };
  }
  if (mimetype.startsWith('video/')) {
    return { video: buffer, caption };
  }
  if (mimetype.startsWith('audio/')) {
    const isVoiceNote = mimetype === 'audio/ogg' || mimetype === 'audio/opus';
    return { audio: buffer, ptt: isVoiceNote };
  }
  // Default: send as document
  return { document: buffer, mimetype, fileName: filename, caption };
}
