/**
 * WatchManager tests — the 0.3 intent-cell-return contract, mirrored from
 * ext-email's subscription-manager suite.
 *
 * Covers: binding capture (target + originChannel host-stamped from the call
 * context), delivery echoing the stored binding (legacy entries omit
 * `channel` → baked-channel fallback), ownership scoping on unwatch/list,
 * and the ownership-gated explicit-id overwrite. The store and connection
 * are minimal fakes — no baileys anywhere.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { WAMessage } from '@whiskeysockets/baileys';

import { WatchManager, type WatchStore } from './watch-manager.js';
import { WhatsAppConfigSchema } from './schemas.js';
import type { ContactRow } from './contact-resolver.js';
import { noopLogger } from '@getcast/extension-schema';
import type { ExtensionContext, ToolCallContext } from '@getcast/extension-schema';

type Deliver = ExtensionContext['deliver'];

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const SCHOOL: ContactRow = {
  contact_id: 7, is_group: 1, display_name: 'School Group',
  phonebook_name: null, given_name: null, verified_name: null,
  unread_count: 0, last_ts: 0,
};

/** Store fake: one known contact (id 7, "School Group"). */
function fakeStore(): WatchStore {
  return {
    onNewMessages: null,
    resolveQueryToContactId: (q) => (q === 'school' ? 7 : null),
    resolveQueryMatches: () => [],
    getAliasesForContact: () => ['123@g.us'],
    getContactIdForJid: () => 7,
    resolver: {
      getContact: () => SCHOOL,
    },
  };
}

const connection = { isPaired: () => true };

function ctx(participant?: string, channel?: string): ToolCallContext {
  return { stagingDir: '/tmp/in', stagingOutDir: '/tmp/out', participant, channel };
}

const CONFIG = WhatsAppConfigSchema.parse({ read_mode: 'open' });

const MSG: WAMessage = {
  key: { id: 'm1', fromMe: false, remoteJid: '123@g.us' },
  message: { conversation: 'field trip friday' },
  messageTimestamp: 1_750_000_000,
  pushName: 'Teacher',
} as WAMessage;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let dir: string;
let store: ReturnType<typeof fakeStore>;
let deliver: ReturnType<typeof vi.fn<Deliver>>;
let mgr: WatchManager;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchmgr-'));
  store = fakeStore();
  deliver = vi.fn<Deliver>().mockResolvedValue({ ok: true, result: null });
  mgr = new WatchManager({
    privateDir: dir,
    deliver,
    log: noopLogger,
    store,
    config: CONFIG,
  });
  mgr.start();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function watchesOnDisk(): Array<Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'watches.json'), 'utf-8'));
}

const ALICE = ctx('u:alice@srv', 'default');
const BOB = ctx('u:bob@srv', 'main');

// ---------------------------------------------------------------------------
// Binding capture
// ---------------------------------------------------------------------------

describe('handleWatch — binding capture', () => {
  it('stamps target, originChannel, createdBy from the call context', () => {
    const res = mgr.handleWatch({ chat: 'school', instructions: 'summarize', id: 'w-a' }, ALICE, connection);
    expect(res.isError).toBeUndefined();

    const [row] = watchesOnDisk();
    expect(row.target).toBe('u:alice@srv');
    expect(row.originChannel).toBe('default');
    expect(row.createdBy).toBe('u:alice@srv');
  });

  it('rejects when there is no participant context', () => {
    const res = mgr.handleWatch({ chat: 'school', instructions: 'i' }, ctx(), connection);
    expect(res.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Delivery — intent-cell return
// ---------------------------------------------------------------------------

describe('delivery — echoes the stored binding', () => {
  it('passes replyTo + channel from the binding', () => {
    mgr.handleWatch({ chat: 'school', instructions: 'i', id: 'w-b' }, ALICE, connection);
    store.onNewMessages!(7, [MSG]);

    expect(deliver).toHaveBeenCalledTimes(1);
    const [, opts] = deliver.mock.calls[0]!;
    expect(opts).toEqual({ replyTo: 'u:alice@srv', channel: 'default' });
  });

  it('legacy entry without originChannel omits channel (baked-channel fallback)', () => {
    fs.writeFileSync(path.join(dir, 'watches.json'), JSON.stringify([{
      id: 'legacy', contactId: 7, chatName: 'School Group',
      instructions: 'i', target: 'u:alice@srv', createdAt: '2026-01-01T00:00:00Z',
    }]));
    // Fresh manager so loadWatches() reads the legacy store.
    const mgr2 = new WatchManager({
      privateDir: dir, deliver, log: noopLogger,
      store, config: CONFIG,
    });
    mgr2.start();
    store.onNewMessages!(7, [MSG]);

    const [, opts] = deliver.mock.calls[0]!;
    expect(opts?.replyTo).toBe('u:alice@srv');
    expect(opts?.channel).toBeUndefined();
  });

  it('read_mode disabled blocks delivery (contactReadable deny branch)', () => {
    // Create the watch under the open config, then reload the same store dir
    // under a disabled config — the fire must be swallowed, not delivered.
    mgr.handleWatch({ chat: 'school', instructions: 'i', id: 'w-deny' }, ALICE, connection);
    const mgrDeny = new WatchManager({
      privateDir: dir, deliver, log: noopLogger, store,
      config: WhatsAppConfigSchema.parse({ read_mode: 'disabled' }),
    });
    mgrDeny.start(); // takes over store.onNewMessages
    store.onNewMessages!(7, [MSG]);

    expect(deliver).not.toHaveBeenCalled();
  });

  it('two watches on one contact fire once each, to their own bindings', () => {
    mgr.handleWatch({ chat: 'school', instructions: 'i', id: 'w-alice' }, ALICE, connection);
    mgr.handleWatch({ chat: 'school', instructions: 'i', id: 'w-bob' }, BOB, connection);
    store.onNewMessages!(7, [MSG]);

    expect(deliver).toHaveBeenCalledTimes(2);
    const opts = deliver.mock.calls.map(c => c[1]);
    expect(opts).toContainEqual({ replyTo: 'u:alice@srv', channel: 'default' });
    expect(opts).toContainEqual({ replyTo: 'u:bob@srv', channel: 'main' });
  });
});

// ---------------------------------------------------------------------------
// Ownership scoping
// ---------------------------------------------------------------------------

describe('ownership — list and unwatch are cell-scoped', () => {
  beforeEach(() => {
    mgr.handleWatch({ chat: 'school', instructions: 'i', id: 'w-alice' }, ALICE, connection);
    mgr.handleWatch({ chat: 'school', instructions: 'i', id: 'w-bob' }, BOB, connection);
  });

  it('list shows only the caller\'s watches', () => {
    const text = mgr.handleListWatches(ALICE).content[0].text;
    expect(text).toContain('w-alice');
    expect(text).not.toContain('w-bob');
  });

  it('operator tier sees all watches', () => {
    const text = mgr.handleListWatches(ctx('cli:operator')).content[0].text;
    expect(text).toContain('w-alice');
    expect(text).toContain('w-bob');
  });

  it('unwatch denies another cell\'s watch with the not-found message (no oracle)', () => {
    const res = mgr.handleUnwatch({ id: 'w-alice' }, BOB);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
    expect(watchesOnDisk()).toHaveLength(2);
  });

  it('unwatch removes own watch; operator can remove any', () => {
    expect(mgr.handleUnwatch({ id: 'w-alice' }, ALICE).isError).toBeUndefined();
    expect(mgr.handleUnwatch({ id: 'w-bob' }, ctx('admin:web')).isError).toBeUndefined();
    expect(watchesOnDisk()).toHaveLength(0);
  });

  it('explicit-id overwrite is ownership-gated', () => {
    const res = mgr.handleWatch({ chat: 'school', instructions: 'steal', id: 'w-alice' }, BOB, connection);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('already in use');
    const row = watchesOnDisk().find(r => r.id === 'w-alice')!;
    expect(row.target).toBe('u:alice@srv');
  });

  it('own explicit-id overwrite updates in place', () => {
    const res = mgr.handleWatch({ chat: 'school', instructions: 'v2', id: 'w-alice' }, ALICE, connection);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('updated');
    const rows = watchesOnDisk().filter(r => r.id === 'w-alice');
    expect(rows).toHaveLength(1);
    expect(rows[0].instructions).toBe('v2');
  });
});
