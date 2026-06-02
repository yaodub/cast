/**
 * Tests for the WhatsApp Store at the integration level — specifically, that
 * a merge re-keys existing messages onto the surviving contact instead of
 * leaving them orphaned under a deleted contact_id.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { WAMessage } from '@whiskeysockets/baileys';

import { WhatsAppStore } from './store.js';

const PN = 'xxxxxxxxxx@s.whatsapp.net';
const LID = '111222333@lid';

function fakeMessage(id: string, remoteJid: string, ts: number, text: string): WAMessage {
  return {
    key: { id, remoteJid, fromMe: false },
    messageTimestamp: ts,
    message: { conversation: text },
    pushName: 'Alice',
  } as WAMessage;
}

let tmp: string;
let store: WhatsAppStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-store-test-'));
  const authDir = path.join(tmp, 'auth');
  fs.mkdirSync(authDir, { recursive: true });
  store = new WhatsAppStore({
    dbPath: path.join(tmp, 'messages.db'),
    authDir,
  });
});

afterEach(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Store merge re-keys messages', () => {
  it('moves loser-side messages onto the surviving contact', () => {
    // Step 1: ingest messages under PN-only addressing — creates contact A
    store.ingestMessages([
      fakeMessage('pn-msg-1', PN, 1700000000, 'hello via pn'),
      fakeMessage('pn-msg-2', PN, 1700000010, 'still via pn'),
    ], 'append');
    const cidPn = store.getContactIdForJid(PN)!;
    expect(cidPn).not.toBeNull();

    // Step 2: ingest messages under LID-only addressing — creates contact B (no pair known yet)
    store.ingestMessages([
      fakeMessage('lid-msg-1', LID, 1700000020, 'hello via lid'),
    ], 'append');
    const cidLid = store.getContactIdForJid(LID)!;
    expect(cidLid).not.toBe(cidPn);

    // Before merge: each side sees only its own messages
    expect(store.getMessagesByContact(cidPn).map(m => m.key.id)).toEqual(['pn-msg-1', 'pn-msg-2']);
    expect(store.getMessagesByContact(cidLid).map(m => m.key.id)).toEqual(['lid-msg-1']);

    // Step 3: learn the pair — forces a merge
    store.resolver.learnPair(PN, LID);

    // After merge: everything lives under the survivor (lower contact_id)
    const survivor = Math.min(cidPn, cidLid);
    const subsumed = Math.max(cidPn, cidLid);
    expect(store.getContactIdForJid(PN)).toBe(survivor);
    expect(store.getContactIdForJid(LID)).toBe(survivor);

    const allIds = store.getMessagesByContact(survivor).map(m => m.key.id).sort();
    expect(allIds).toEqual(['lid-msg-1', 'pn-msg-1', 'pn-msg-2']);

    // No messages remain on the loser contact_id
    expect(store.getMessagesByContact(subsumed)).toHaveLength(0);
  });

  it('deduplicates when same message id is present on both sides', () => {
    store.ingestMessages([fakeMessage('dup-id', PN, 1700000000, 'via pn')], 'append');
    store.ingestMessages([fakeMessage('dup-id', LID, 1700000000, 'via lid')], 'append');
    const cidPn = store.getContactIdForJid(PN)!;
    const cidLid = store.getContactIdForJid(LID)!;
    expect(cidPn).not.toBe(cidLid);

    store.resolver.learnPair(PN, LID);

    const survivor = Math.min(cidPn, cidLid);
    const rows = store.getMessagesByContact(survivor);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key.id).toBe('dup-id');
  });
});

describe('Store listContacts filters out pure group participants', () => {
  it('excludes contacts with last_ts = 0', () => {
    // Create a contact via resolver without any last_ts — simulates a group participant we
    // learned about but never messaged directly.
    store.resolver.resolveContactId(PN, { givenName: 'Bob' });
    // And a real chat with a real message (last_ts bumped)
    store.ingestMessages([fakeMessage('m1', LID, 1700000000, 'hello')], 'append');

    const contacts = store.listContacts();
    const jids = contacts.map(c => store.getAliasesForContact(c.contact_id)[0]);
    expect(jids).toContain(LID);
    expect(jids).not.toContain(PN);
  });
});
