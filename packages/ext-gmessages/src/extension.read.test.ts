/**
 * Read-handler tests — the fetch → ACL → resolve → render path through the real
 * extension, with the connection and library reads faked. No socket, no account.
 */
import { describe, it, expect, vi } from 'vitest';

import type { ConversationSummary, InboundMessage, Client } from 'gmessages';

import { GmessagesExtension, type ReadDeps } from './extension.js';
import type { ConnectionLike } from './connection.js';
import { GmessagesConfigSchema, type GmessagesConfig } from './schemas.js';
import type { ExtensionContext, ToolCallContext } from '@getcast/extension-schema';

// ---------------------------------------------------------------------------

function conv(over: Partial<ConversationSummary>): ConversationSummary {
  return { conversationId: 'c0', type: 1, kind: 'sms', participants: [], raw: {} as never, ...over };
}

function message(over: Partial<InboundMessage>): InboundMessage {
  return {
    messageId: 'm1',
    conversationId: 'c1',
    participantId: 'them',
    text: '',
    timestampMicros: 0n,
    statusCode: 0,
    statusLabel: null,
    reactions: [],
    attachments: [],
    ...over,
  };
}

const CONVERSATIONS: ConversationSummary[] = [
  conv({ conversationId: 'c1', kind: 'rcs', participants: ['Alice Chen'] }),
  conv({ conversationId: 'c2', kind: 'sms', participants: ['+14155550000'] }),
];

function fakeConnection(): ConnectionLike {
  return {
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    pair: vi.fn(),
    isPaired: () => true,
    isConnected: () => true,
    ownParticipantId: () => 'me',
    deadReason: () => null,
    ready: Promise.resolve(),
    socket: { operations: {} } as unknown as Client,
  };
}

function makeExt(config: Partial<GmessagesConfig>, reads: Partial<ReadDeps> = {}, connection?: ConnectionLike) {
  const ctx = {
    config: GmessagesConfigSchema.parse(config),
    privateDir: '/tmp/unused',
  } as unknown as ExtensionContext<GmessagesConfig, never>;
  const readDeps: ReadDeps = {
    listConversations: vi.fn(async () => CONVERSATIONS),
    listMessages: vi.fn(async () => [] as InboundMessage[]),
    sendMessage: vi.fn(async () => new Uint8Array()),
    uploadMedia: vi.fn(async () => ({ mediaId: 'up1', key: new Uint8Array(32), sizeBytes: 1n })),
    downloadMedia: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' })),
    getFullSizeMedia: vi.fn(async () => message({})),
    sendMediaMessage: vi.fn(async () => new Uint8Array()),
    ...reads,
  };
  return new GmessagesExtension(ctx, { connection: connection ?? fakeConnection(), reads: readDeps });
}

const call = {} as ToolCallContext;

// ---------------------------------------------------------------------------

describe('gmessages__chats', () => {
  it('lists readable conversations', async () => {
    const ext = makeExt({ read_mode: 'open' });
    const res = await ext.handle('gmessages__chats', {}, call);
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toBe('Alice Chen · rcs · c1\n+14155550000 · sms · c2');
  });

  it('hides deny-listed conversations', async () => {
    const ext = makeExt({ read_mode: 'open', chats: { c2: { read: 'deny' } } });
    const res = await ext.handle('gmessages__chats', {}, call);
    expect(res.content[0]!.text).toBe('Alice Chen · rcs · c1');
  });

  it('reports disabled reading', async () => {
    const ext = makeExt({ read_mode: 'disabled' });
    const res = await ext.handle('gmessages__chats', {}, call);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Reading is disabled.');
  });
});

describe('gmessages__messages', () => {
  it('resolves a name and renders the thread', async () => {
    const listMessages = vi.fn(async () => [
      message({ participantId: 'them', text: 'hello', conversationId: 'c1' }),
      message({ participantId: 'me', text: 'hi back', conversationId: 'c1' }),
    ]);
    const ext = makeExt({ read_mode: 'open' }, { listMessages });
    const res = await ext.handle('gmessages__messages', { chat: 'Alice' }, call);
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toBe('Alice Chen: hello\nYou: hi back');
    expect(listMessages).toHaveBeenCalledWith(expect.anything(), 'c1', { count: 25 });
  });

  it('asks for disambiguation when a name is ambiguous', async () => {
    const ambiguous: ConversationSummary[] = [
      conv({ conversationId: 'c1', participants: ['Alice Chen'] }),
      conv({ conversationId: 'c3', participants: ['Alice Wong'] }),
    ];
    const ext = makeExt({ read_mode: 'open' }, { listConversations: vi.fn(async () => ambiguous) });
    const res = await ext.handle('gmessages__messages', { chat: 'Alice' }, call);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Multiple conversations match');
  });

  it('blocks a deny-listed conversation', async () => {
    const ext = makeExt({ read_mode: 'open', chats: { c1: { read: 'deny' } } });
    const res = await ext.handle('gmessages__messages', { chat: 'Alice' }, call);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Access to this conversation is restricted.');
  });

  it('filters by keyword', async () => {
    const listMessages = vi.fn(async () => [
      message({ participantId: 'them', text: 'dinner at 7' }),
      message({ participantId: 'them', text: 'unrelated' }),
    ]);
    const ext = makeExt({ read_mode: 'open' }, { listMessages });
    const res = await ext.handle('gmessages__messages', { chat: 'c1', query: 'dinner' }, call);
    expect(res.content[0]!.text).toBe('Alice Chen: dinner at 7');
  });

  it('tells the user to re-pair when the session is dead, instead of timing out', async () => {
    const dead = fakeConnection();
    (dead as { deadReason: () => string | null }).deadReason = () =>
      'Google Messages session expired (cookies no longer authenticate). Re-pair in the admin panel.';
    // A dead connection never becomes ready; without the dead check this would
    // hang for the full ready timeout and report a bare "timeout".
    (dead as { ready: Promise<void> }).ready = new Promise<void>(() => {});
    const ext = makeExt({ read_mode: 'open' }, {}, dead);
    const res = await ext.handle('gmessages__chats', {}, call);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Re-pair');
  });

  it('surfaces a not-paired connection as a tool error', async () => {
    const down = fakeConnection();
    (down as { isPaired: () => boolean }).isPaired = () => false;
    const ext = makeExt({ read_mode: 'open' }, {}, down);
    const res = await ext.handle('gmessages__messages', { chat: 'Alice' }, call);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('not paired');
  });
});

describe('resolution cost — the MCP call has a deadline', () => {
  it('does not re-list when the cache can already resolve the name', async () => {
    // The first live read failed because every `messages` call re-fetched the whole
    // inbox before it could resolve anything, then owed a second round trip for the
    // messages themselves. Two listings per read is what blew the MCP timeout.
    const listConversations = vi.fn(async () => CONVERSATIONS);
    const ext = makeExt({ read_mode: 'open' }, { listConversations });

    await ext.handle('gmessages__chats', {}, call); // warms the cache — 1 listing
    expect(listConversations).toHaveBeenCalledTimes(1);

    await ext.handle('gmessages__messages', { chat: 'Alice' }, call);
    expect(listConversations).toHaveBeenCalledTimes(1); // still 1 — resolved from cache
  });

  it('treats a bare conversation id as a target without listing at all', async () => {
    // The agent passes ids straight back from `chats` output; `listMessages` takes an
    // id, so resolving one needs no network.
    const listConversations = vi.fn(async () => CONVERSATIONS);
    const listMessages = vi.fn(async () => [message({ text: 'hi' })]);
    const ext = makeExt({ read_mode: 'open' }, { listConversations, listMessages });

    const res = await ext.handle('gmessages__messages', { chat: '538' }, call);
    expect(res.isError).toBeFalsy();
    expect(listConversations).not.toHaveBeenCalled();
    expect(listMessages).toHaveBeenCalledWith(expect.anything(), '538', { count: 25 });
  });

  it('falls back to one fresh listing for an unknown name', async () => {
    const listConversations = vi.fn(async () => CONVERSATIONS);
    const ext = makeExt({ read_mode: 'open' }, { listConversations });
    await ext.handle('gmessages__messages', { chat: 'Alice' }, call);
    expect(listConversations).toHaveBeenCalledTimes(1);
  });
});

describe('approval wiring', () => {
  it('exposes an approval block on messages only in approval mode', () => {
    const open = makeExt({ read_mode: 'open' }).tools.find((t) => t.name === 'gmessages__messages');
    expect(open?.approval).toBeUndefined();

    const approval = makeExt({ read_mode: 'approval' }).tools.find((t) => t.name === 'gmessages__messages');
    expect(approval?.approval?.enabled).toBe(true);
  });

  it('filter skips an allow-listed chat and asks otherwise (via warm cache)', async () => {
    const ext = makeExt({ read_mode: 'approval', chats: { c1: { read: 'allow' } } });
    // Warm the cache with a listing fetch.
    await ext.handle('gmessages__chats', {}, call);
    const messages = ext.tools.find((t) => t.name === 'gmessages__messages')!;
    const filter = messages.approval!.filter!;
    expect(filter({ chat: 'Alice' }, { wasApproved: () => false })).toBe('skip');
    expect(filter({ chat: '+14155550000' }, { wasApproved: () => false })).toBe('approve');
    // Unknown chat (cold to the cache) → ask.
    expect(filter({ chat: 'nobody' }, { wasApproved: () => false })).toBe('approve');
  });
});
