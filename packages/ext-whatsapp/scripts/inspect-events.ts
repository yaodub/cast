#!/usr/bin/env npx tsx
/**
 * Debug script — connect to WhatsApp with existing auth and log all events.
 * Usage: npx tsx packages/ext-whatsapp/scripts/inspect-events.ts <auth-dir>
 *
 * <auth-dir> is an agent's whatsapp auth directory:
 *   <agents-root>/<agent-folder>/ext/whatsapp/auth
 */
import makeWASocket, { useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import { WA_VERSION } from '../src/constants.js';

const authDir = process.argv[2];
if (!authDir) {
  console.error('Usage: npx tsx inspect-events.ts <auth-dir>');
  process.exit(1);
}

const logger = pino({ level: 'silent' });

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const sock = makeWASocket({
    version: WA_VERSION,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,
    logger,
  });

  sock.ev.on('creds.update', saveCreds);

  // Log all relevant events
  sock.ev.on('connection.update', (data) => {
    console.log('connection.update:', JSON.stringify(data));
  });
  sock.ev.on('chats.upsert', (chats) => {
    console.log(`chats.upsert: ${chats.length} chat(s)`);
    for (const c of chats.slice(0, 5)) {
      console.log(`  id=${c.id} name=${c.name ?? '(none)'}`);
    }
    if (chats.length > 5) console.log(`  ... and ${chats.length - 5} more`);
  });
  sock.ev.on('chats.update', (chats) => {
    console.log(`chats.update: ${chats.length} chat(s)`);
  });
  sock.ev.on('messaging-history.set', (data) => {
    console.log(`messaging-history.set: chats=${data.chats?.length ?? 0} contacts=${data.contacts?.length ?? 0} messages=${data.messages?.length ?? 0}`);
    if (data.chats) {
      for (const c of data.chats.slice(0, 5)) {
        console.log(`  id=${c.id} name=${c.name ?? '(none)'}`);
      }
      if (data.chats.length > 5) console.log(`  ... and ${data.chats.length - 5} more`);
    }
  });
  sock.ev.on('contacts.upsert', (contacts) => {
    console.log(`contacts.upsert: ${contacts.length} contact(s)`);
  });
  sock.ev.on('contacts.update', (contacts) => {
    console.log(`contacts.update: ${contacts.length} contact(s)`);
  });

  setTimeout(() => {
    console.log('--- 20s timeout, exiting ---');
    sock.end(undefined);
    process.exit(0);
  }, 20_000);
}

main().catch((err) => { console.error(err); process.exit(1); });
