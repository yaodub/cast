#!/usr/bin/env npx tsx
/**
 * REFERENCE: WhatsApp history sync → SQLite persistence + query.
 *
 * Standalone POC that validated the SQLite persistence approach.
 * The production implementation is in src/store.ts.
 *
 * Validated against:
 *   @whiskeysockets/baileys  7.0.0-rc.9
 *   better-sqlite3            ^11.8.1
 *   Node.js                   v25.7.0
 *   WA_VERSION                [2, 3000, 1034074495]
 *
 * Usage:
 *   npx tsx packages/ext-whatsapp/scripts/reference/sync-to-db.ts [--reuse]
 *
 * By default, deletes auth and does a fresh pair (required for history sync).
 * --reuse  Reconnect with existing auth (no history sync, but live messages work).
 *
 * Data is stored in packages/ext-whatsapp/scripts/reference/data/
 *   auth/       — Baileys auth state
 *   whatsapp.db — SQLite message database
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import type { WASocket, WAMessage, proto } from '@whiskeysockets/baileys';
import pino from 'pino';
import Database from 'better-sqlite3';

import { WA_VERSION } from '../../src/constants.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POC_DIR = path.resolve(__dirname, 'data');
const AUTH_DIR = path.join(POC_DIR, 'auth');
const DB_PATH = path.join(POC_DIR, 'whatsapp.db');

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const reuse = process.argv.includes('--reuse');

// ---------------------------------------------------------------------------
// Logger — silent for Baileys, our own for stdout
// ---------------------------------------------------------------------------

const baileysLog = pino({ level: 'silent' });

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  fs.mkdirSync(POC_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid           TEXT PRIMARY KEY,
      name          TEXT,
      is_group      INTEGER NOT NULL DEFAULT 0,
      unread_count  INTEGER NOT NULL DEFAULT 0,
      last_ts       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS contacts (
      jid           TEXT PRIMARY KEY,
      name          TEXT,
      notify        TEXT,
      phone         TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            TEXT NOT NULL,
      chat_jid      TEXT NOT NULL,
      sender_jid    TEXT,
      from_me       INTEGER NOT NULL DEFAULT 0,
      timestamp     INTEGER NOT NULL DEFAULT 0,
      text          TEXT,
      media_type    TEXT,
      push_name     TEXT,
      raw_json      TEXT,
      PRIMARY KEY (id, chat_jid)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_text ON messages(text) WHERE text IS NOT NULL;
  `);

  return db;
}

// ---------------------------------------------------------------------------
// DB writers (prepared statements)
// ---------------------------------------------------------------------------

function makeWriters(db: Database.Database) {
  const upsertChat = db.prepare(`
    INSERT INTO chats (jid, name, is_group, unread_count, last_ts)
    VALUES (@jid, @name, @is_group, @unread_count, @last_ts)
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(@name, chats.name),
      unread_count = @unread_count,
      last_ts = MAX(chats.last_ts, @last_ts)
  `);

  const upsertContact = db.prepare(`
    INSERT INTO contacts (jid, name, notify, phone)
    VALUES (@jid, @name, @notify, @phone)
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(@name, contacts.name),
      notify = COALESCE(@notify, contacts.notify),
      phone = COALESCE(@phone, contacts.phone)
  `);

  const upsertMessage = db.prepare(`
    INSERT INTO messages (id, chat_jid, sender_jid, from_me, timestamp, text, media_type, push_name, raw_json)
    VALUES (@id, @chat_jid, @sender_jid, @from_me, @timestamp, @text, @media_type, @push_name, @raw_json)
    ON CONFLICT(id, chat_jid) DO UPDATE SET
      text = COALESCE(@text, messages.text),
      media_type = COALESCE(@media_type, messages.media_type)
  `);

  return { upsertChat, upsertContact, upsertMessage };
}

// ---------------------------------------------------------------------------
// Message extraction
// ---------------------------------------------------------------------------

function normalizeTs(ts: number | { toNumber(): number } | null | undefined): number {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  return ts.toNumber();
}

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

function getMediaType(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return m.audioMessage.ptt ? 'voice_note' : 'audio';
  if (m.documentMessage) return 'document';
  if (m.stickerMessage) return 'sticker';
  if (m.contactMessage) return 'contact';
  if (m.locationMessage) return 'location';
  return null;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

let stats = { chats: 0, contacts: 0, messages: 0, historyChunks: 0 };

function wireEvents(
  sock: WASocket,
  db: Database.Database,
  writers: ReturnType<typeof makeWriters>,
  saveCreds: () => Promise<void>,
) {
  // -- Connection lifecycle ------------------------------------------------
  sock.ev.on('connection.update', (update) => {
    if (update.connection === 'open') {
      log('Connected to WhatsApp');
    }
    if (update.connection === 'close') {
      const err = update.lastDisconnect?.error;
      const code = (err as { output?: { statusCode?: number } })?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log('FATAL: logged out. Delete auth and re-pair.');
        process.exit(1);
      }
      if (code === DisconnectReason.restartRequired) {
        log('515 restart required — reconnecting...');
        startSocket(db, writers);
        return;
      }
      log(`Disconnected (code=${code}), reconnecting in 3s...`);
      setTimeout(() => startSocket(db, writers), 3000);
    }
    // Log any other fields for debugging
    if (update.receivedPendingNotifications) {
      log('Received pending notifications — history sync should follow');
    }
    if (update.qr) {
      log(`QR code generated (length=${update.qr.length}). Use pairing code instead.`);
    }
  });

  sock.ev.on('creds.update', () => {
    saveCreds().catch(e => log(`saveCreds error: ${e}`));
  });

  // -- History sync (the big one) ------------------------------------------
  sock.ev.on('messaging-history.set', (data) => {
    stats.historyChunks++;
    const chatCount = data.chats?.length ?? 0;
    const contactCount = data.contacts?.length ?? 0;
    const msgCount = data.messages?.length ?? 0;
    log(`history chunk #${stats.historyChunks}: ${chatCount} chats, ${contactCount} contacts, ${msgCount} messages`);

    const tx = db.transaction(() => {
      if (data.chats) {
        for (const chat of data.chats) {
          const conv = chat as proto.IConversation;
          writers.upsertChat.run({
            jid: chat.id ?? '',
            name: conv.name ?? null,
            is_group: (chat.id ?? '').endsWith('@g.us') ? 1 : 0,
            unread_count: conv.unreadCount ?? 0,
            last_ts: normalizeTs(conv.conversationTimestamp),
          });
          stats.chats++;
        }
      }
      if (data.contacts) {
        for (const contact of data.contacts) {
          writers.upsertContact.run({
            jid: contact.id ?? '',
            name: contact.name ?? null,
            notify: contact.notify ?? null,
            phone: null,
          });
          stats.contacts++;
        }
      }
      if (data.messages) {
        for (const msg of data.messages) {
          ingestMessage(msg, writers);
        }
      }
    });
    tx();

    log(`  totals: ${stats.chats} chats, ${stats.contacts} contacts, ${stats.messages} messages`);
  });

  // -- Live chats ----------------------------------------------------------
  sock.ev.on('chats.upsert', (chats) => {
    log(`chats.upsert: ${chats.length} chat(s)`);
    const tx = db.transaction(() => {
      for (const chat of chats) {
        const conv = chat as proto.IConversation;
        writers.upsertChat.run({
          jid: chat.id ?? '',
          name: conv.name ?? null,
          is_group: (chat.id ?? '').endsWith('@g.us') ? 1 : 0,
          unread_count: conv.unreadCount ?? 0,
          last_ts: normalizeTs(conv.conversationTimestamp),
        });
        stats.chats++;
      }
    });
    tx();
  });

  sock.ev.on('chats.update', (updates) => {
    log(`chats.update: ${updates.length} update(s)`);
    for (const u of updates) {
      const conv = u as proto.IConversation;
      if (u.id) {
        writers.upsertChat.run({
          jid: u.id,
          name: conv.name ?? null,
          is_group: u.id.endsWith('@g.us') ? 1 : 0,
          unread_count: conv.unreadCount ?? 0,
          last_ts: normalizeTs(conv.conversationTimestamp),
        });
      }
    }
  });

  // -- Live contacts -------------------------------------------------------
  sock.ev.on('contacts.upsert', (contacts) => {
    log(`contacts.upsert: ${contacts.length} contact(s)`);
    const tx = db.transaction(() => {
      for (const c of contacts) {
        writers.upsertContact.run({
          jid: c.id ?? '',
          name: c.name ?? null,
          notify: c.notify ?? null,
          phone: null,
        });
        stats.contacts++;
      }
    });
    tx();
  });

  sock.ev.on('contacts.update', (contacts) => {
    log(`contacts.update: ${contacts.length} contact(s)`);
    for (const c of contacts) {
      if (c.id) {
        writers.upsertContact.run({
          jid: c.id,
          name: c.name ?? null,
          notify: c.notify ?? null,
          phone: null,
        });
      }
    }
  });

  // -- Live messages -------------------------------------------------------
  sock.ev.on('messages.upsert', (data) => {
    log(`messages.upsert (${data.type}): ${data.messages.length} message(s)`);
    const tx = db.transaction(() => {
      for (const msg of data.messages) {
        ingestMessage(msg, writers);
      }
    });
    tx();
  });
}

function ingestMessage(msg: WAMessage, writers: ReturnType<typeof makeWriters>) {
  const id = msg.key.id;
  const chatJid = msg.key.remoteJid;
  if (!id || !chatJid) return;

  // Skip protocol messages with no content
  const text = extractText(msg);
  const mediaType = getMediaType(msg);
  if (!text && !mediaType && !msg.message) return;

  writers.upsertMessage.run({
    id,
    chat_jid: chatJid,
    sender_jid: msg.key.participant ?? (msg.key.fromMe ? 'me' : chatJid),
    from_me: msg.key.fromMe ? 1 : 0,
    timestamp: normalizeTs(msg.messageTimestamp),
    text,
    media_type: mediaType,
    push_name: msg.pushName ?? null,
    raw_json: JSON.stringify(msg.message ?? {}),
  });
  stats.messages++;
}

// ---------------------------------------------------------------------------
// Socket creation
// ---------------------------------------------------------------------------

let currentSock: WASocket | null = null;

async function startSocket(db: Database.Database, writers: ReturnType<typeof makeWriters>): Promise<WASocket> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    version: WA_VERSION,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLog),
    },
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,
    shouldSyncHistoryMessage: () => true,
    logger: baileysLog,
    getMessage: async () => undefined,
  });

  currentSock = sock;
  wireEvents(sock, db, writers, saveCreds);
  return sock;
}

// ---------------------------------------------------------------------------
// Pairing flow
// ---------------------------------------------------------------------------

async function promptPhone(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('Enter phone number (with country code, e.g. 14155550123): ', (answer) => {
      rl.close();
      resolve(answer.replace(/\D/g, ''));
    });
  });
}

async function pairAndSync(sock: WASocket) {
  // Wait for WS handshake
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 15_000);
    sock.ev.on('connection.update', ({ connection }) => {
      if (connection === 'connecting') {
        clearTimeout(timeout);
        setTimeout(resolve, 1500);
      }
    });
  });

  const phone = await promptPhone();
  log(`Requesting pairing code for ${phone}...`);
  const code = await sock.requestPairingCode(phone);
  log(`\n  >>> PAIRING CODE: ${code} <<<\n`);
  log('Enter this code in WhatsApp → Linked Devices → Link with phone number');
  log('Waiting for pairing + history sync...\n');
}

// ---------------------------------------------------------------------------
// Query REPL
// ---------------------------------------------------------------------------

function startRepl(db: Database.Database) {
  console.log('\n--- REPL ready. Commands: ---');
  console.log('  chats                    — list all chats');
  console.log('  msgs <jid-or-name> [n]   — last n messages (default 20)');
  console.log('  search <keyword>         — search messages');
  console.log('  stats                    — database stats');
  console.log('  sql <query>              — raw SQL');
  console.log('  quit                     — exit\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'wa> ' });
  rl.prompt();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }

    try {
      const [cmd, ...args] = trimmed.split(/\s+/);

      if (cmd === 'quit' || cmd === 'exit') {
        currentSock?.end(undefined);
        process.exit(0);
      }

      if (cmd === 'stats') {
        const chatCount = (db.prepare('SELECT COUNT(*) as c FROM chats').get() as { c: number }).c;
        const contactCount = (db.prepare('SELECT COUNT(*) as c FROM contacts').get() as { c: number }).c;
        const msgCount = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
        const oldestMsg = db.prepare('SELECT MIN(timestamp) as ts FROM messages WHERE timestamp > 0').get() as { ts: number | null };
        const newestMsg = db.prepare('SELECT MAX(timestamp) as ts FROM messages').get() as { ts: number | null };
        console.log(`Chats: ${chatCount}, Contacts: ${contactCount}, Messages: ${msgCount}`);
        if (oldestMsg.ts) console.log(`Oldest: ${new Date(oldestMsg.ts * 1000).toISOString()}`);
        if (newestMsg.ts) console.log(`Newest: ${new Date(newestMsg.ts * 1000).toISOString()}`);
      }

      else if (cmd === 'chats') {
        const rows = db.prepare(`
          SELECT c.jid, c.name, c.is_group, c.unread_count, c.last_ts,
                 co.name as contact_name, co.notify as contact_notify,
                 (SELECT COUNT(*) FROM messages m WHERE m.chat_jid = c.jid) as msg_count,
                 (SELECT push_name FROM messages WHERE chat_jid = c.jid AND push_name IS NOT NULL AND from_me = 0 LIMIT 1) as peer_push_name
          FROM chats c
          LEFT JOIN contacts co ON co.jid = c.jid
          ORDER BY c.last_ts DESC
          LIMIT 50
        `).all() as { jid: string; name: string | null; is_group: number; unread_count: number; last_ts: number; contact_name: string | null; contact_notify: string | null; msg_count: number; peer_push_name: string | null }[];

        for (const r of rows) {
          const name = r.name ?? r.contact_name ?? r.contact_notify ?? r.peer_push_name ?? r.jid;
          const group = r.is_group ? ' (group)' : '';
          const ts = r.last_ts > 0 ? new Date(r.last_ts * 1000).toISOString().slice(0, 16) : '';
          console.log(`  ${name}${group} — ${r.msg_count} msgs — ${ts} — ${r.jid}`);
        }
        if (rows.length === 0) console.log('  (no chats)');
      }

      else if (cmd === 'msgs') {
        const query = args[0];
        const limit = parseInt(args[1] ?? '20', 10);
        if (!query) { console.log('Usage: msgs <jid-or-name> [count]'); rl.prompt(); return; }

        // Resolve: exact JID or name search (chat name → contact name/notify → message push_name)
        let jid = query;
        if (!query.includes('@')) {
          const pattern = `%${query}%`;
          const match = db.prepare(`
            SELECT c.jid,
                   COALESCE(c.name, co.name, co.notify) as display
            FROM chats c
            LEFT JOIN contacts co ON co.jid = c.jid
            WHERE c.name LIKE @p OR co.name LIKE @p OR co.notify LIKE @p
            LIMIT 1
          `).get({ p: pattern }) as { jid: string; display: string | null } | undefined;
          if (!match) {
            // Fall back to push_name from messages
            const pushMatch = db.prepare(`
              SELECT chat_jid as jid, push_name as display FROM messages
              WHERE push_name LIKE ? AND from_me = 0
              GROUP BY chat_jid
              LIMIT 1
            `).get(pattern) as { jid: string; display: string | null } | undefined;
            if (!pushMatch) { console.log(`No chat/contact matching "${query}"`); rl.prompt(); return; }
            jid = pushMatch.jid;
            console.log(`  → resolved to ${pushMatch.display ?? jid} (${jid})`);
          } else {
            jid = match.jid;
            console.log(`  → resolved to ${match.display ?? jid} (${jid})`);
          }
        }

        const msgs = db.prepare(`
          SELECT m.timestamp, m.from_me, m.push_name, m.sender_jid, m.text, m.media_type,
                 COALESCE(c.name, c.notify, m.sender_jid) as sender_name
          FROM messages m
          LEFT JOIN contacts c ON c.jid = m.sender_jid
          WHERE m.chat_jid = ?
          ORDER BY m.timestamp DESC
          LIMIT ?
        `).all(jid, limit) as { timestamp: number; from_me: number; push_name: string | null; sender_jid: string; text: string | null; media_type: string | null; sender_name: string | null }[];

        // Print in chronological order
        for (const m of msgs.reverse()) {
          const ts = m.timestamp > 0 ? new Date(m.timestamp * 1000).toISOString().slice(5, 16).replace('T', ' ') : '??';
          const sender = m.from_me ? 'You' : (m.push_name ?? m.sender_name ?? m.sender_jid);
          const media = m.media_type ? `[${m.media_type}] ` : '';
          const text = m.text ?? '';
          console.log(`  ${ts} | ${sender}: ${media}${text}`);
        }
        if (msgs.length === 0) console.log('  (no messages)');
      }

      else if (cmd === 'search') {
        const keyword = args.join(' ');
        if (!keyword) { console.log('Usage: search <keyword>'); rl.prompt(); return; }

        const results = db.prepare(`
          SELECT m.timestamp, m.chat_jid, m.from_me, m.push_name, m.text,
                 COALESCE(ch.name, m.chat_jid) as chat_name
          FROM messages m
          LEFT JOIN chats ch ON ch.jid = m.chat_jid
          WHERE m.text LIKE ?
          ORDER BY m.timestamp DESC
          LIMIT 30
        `).all(`%${keyword}%`) as { timestamp: number; chat_jid: string; from_me: number; push_name: string | null; text: string; chat_name: string }[];

        for (const r of results) {
          const ts = r.timestamp > 0 ? new Date(r.timestamp * 1000).toISOString().slice(5, 16).replace('T', ' ') : '??';
          const sender = r.from_me ? 'You' : (r.push_name ?? '');
          console.log(`  ${ts} [${r.chat_name}] ${sender}: ${r.text?.slice(0, 100)}`);
        }
        if (results.length === 0) console.log('  (no results)');
      }

      else if (cmd === 'sql') {
        const query = args.join(' ');
        if (!query) { console.log('Usage: sql <query>'); rl.prompt(); return; }
        const rows = db.prepare(query).all();
        console.log(JSON.stringify(rows, null, 2));
      }

      else {
        console.log(`Unknown command: ${cmd}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : e}`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    currentSock?.end(undefined);
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('WhatsApp sync POC');
  log(`Mode: ${reuse ? 'reuse existing auth' : 'fresh pair'}`);
  log(`Data dir: ${POC_DIR}`);

  // Fresh pair: delete auth
  if (!reuse) {
    if (fs.existsSync(AUTH_DIR)) {
      log('Deleting old auth for fresh pair...');
      fs.rmSync(AUTH_DIR, { recursive: true });
    }
  }

  const db = initDb();
  const writers = makeWriters(db);
  const sock = await startSocket(db, writers);

  if (!reuse) {
    await pairAndSync(sock);
  } else {
    log('Reconnecting with existing auth (no history sync expected)...');
  }

  // Wait for initial sync to settle, then start REPL.
  // History arrives in chunks over ~30-60s. We watch for a quiet period.
  log('Waiting for sync to settle (10s of quiet)...');
  let lastEventAt = Date.now();
  const origLog = log;

  // Patch: update lastEventAt on any data event
  const checkInterval = setInterval(() => {
    if (stats.messages > 0 || stats.chats > 0) {
      // Check if we've had 10s of quiet
      if (Date.now() - lastEventAt > 10_000) {
        clearInterval(checkInterval);
        origLog(`Sync settled. ${stats.messages} messages, ${stats.chats} chats, ${stats.contacts} contacts in ${stats.historyChunks} chunks.`);
        startRepl(db);
      }
    }
  }, 1000);

  // Track event activity via the stats object
  let prevTotal = 0;
  setInterval(() => {
    const total = stats.messages + stats.chats + stats.contacts;
    if (total !== prevTotal) {
      lastEventAt = Date.now();
      prevTotal = total;
    }
  }, 500);

  // Safety: start REPL after 120s regardless
  setTimeout(() => {
    clearInterval(checkInterval);
    log('Timeout — starting REPL regardless of sync state.');
    startRepl(db);
  }, 120_000);
}

main().catch((err) => { console.error(err); process.exit(1); });
