/**
 * Send-slice tests — the EXTENSION↔LIBRARY seam, not the protocol.
 *
 * `sendMessage` is oracle-verified and live-proven; what is unproven is whether
 * this extension's gate wraps it correctly. So these tests assert what the
 * extension decides and what it hands the library — including the exact request
 * bytes from `buildSendPlaintext`, which is a stronger check of this layer than
 * transmitting would be, because it isolates the decision from the network.
 *
 * No live sends. Nothing here can reach Google.
 */
import { describe, it, expect, vi } from 'vitest';

import { buildSendPlaintext } from 'gmessages';
import type { ConversationSummary, InboundMessage, Client } from 'gmessages';

import { GmessagesExtension, type ReadDeps } from './extension.js';
import type { ConnectionLike } from './connection.js';
import { GmessagesConfigSchema, type GmessagesConfig } from './schemas.js';
import type { ExtensionContext, ToolCallContext } from '@getcast/extension-schema';

const CONVERSATIONS: ConversationSummary[] = [
  { conversationId: 'c1', type: 1, kind: 'rcs', participants: ['Alice Chen'], raw: {} as never },
  { conversationId: 'c2', type: 1, kind: 'sms', participants: ['+14155550000'], raw: {} as never },
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

function makeExt(config: Partial<GmessagesConfig>, reads: Partial<ReadDeps> = {}) {
  const ctx = {
    config: GmessagesConfigSchema.parse(config),
    privateDir: '/tmp/unused-send',
    deliver: vi.fn(async () => ({ ok: true as const, result: null })),
  } as unknown as ExtensionContext<GmessagesConfig, never>;
  const deps: ReadDeps = {
    listConversations: vi.fn(async () => CONVERSATIONS),
    listMessages: vi.fn(async () => [] as InboundMessage[]),
    sendMessage: vi.fn(async () => new Uint8Array()),
    uploadMedia: vi.fn(async () => ({ mediaId: 'up1', key: new Uint8Array(32), sizeBytes: 1n })),
    downloadMedia: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' })),
    getFullSizeMedia: vi.fn(async () => ({}) as unknown as InboundMessage),
    sendMediaMessage: vi.fn(async () => new Uint8Array()),
    ...reads,
  };
  return { ext: new GmessagesExtension(ctx, { connection: fakeConnection(), reads: deps }), deps };
}

const call = {} as ToolCallContext;
const sendTool = (ext: GmessagesExtension) => ext.tools.find((t) => t.name === 'gmessages__send')!;
const noHistory = { wasApproved: () => false };

// ---------------------------------------------------------------------------

describe('send gate — what reaches the library', () => {
  it('does not call sendMessage when sending is disabled', async () => {
    const { ext, deps } = makeExt({ send_mode: 'disabled' });
    const res = await ext.handle('gmessages__send', { chat: 'Alice', text: 'hi' }, call);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Sending is disabled.');
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('does not call sendMessage for a deny-listed conversation', async () => {
    const { ext, deps } = makeExt({ send_mode: 'direct', chats: { c1: { send: 'deny' } } });
    const res = await ext.handle('gmessages__send', { chat: 'Alice', text: 'hi' }, call);
    expect(res.isError).toBe(true);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('passes the resolved conversation, text, and own participant id through', async () => {
    const { ext, deps } = makeExt({ send_mode: 'direct' });
    const res = await ext.handle('gmessages__send', { chat: 'Alice', text: 'hello' }, call);
    expect(res.isError).toBeFalsy();
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    const [, params] = (deps.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(params).toEqual({ conversationId: 'c1', text: 'hello', participantId: 'me' });
  });

  it('refuses an ambiguous target rather than picking one', async () => {
    const ambiguous: ConversationSummary[] = [
      { conversationId: 'c1', type: 1, kind: 'rcs', participants: ['Alice Chen'], raw: {} as never },
      { conversationId: 'c3', type: 1, kind: 'rcs', participants: ['Alice Wong'], raw: {} as never },
    ];
    const { ext, deps } = makeExt({ send_mode: 'direct' }, {
      listConversations: vi.fn(async () => ambiguous),
    });
    const res = await ext.handle('gmessages__send', { chat: 'Alice', text: 'hi' }, call);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Multiple conversations match');
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a cold number with a pointer, rather than opening a thread', async () => {
    // v1 withholds the capability even though the policy for it exists.
    const { ext, deps } = makeExt({ send_mode: 'direct' });
    const res = await ext.handle('gmessages__send', { chat: '+19995551234', text: 'hi' }, call);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('not supported yet');
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('requires non-empty text', async () => {
    const { ext, deps } = makeExt({ send_mode: 'direct' });
    const res = await ext.handle('gmessages__send', { chat: 'Alice', text: '' }, call);
    expect(res.isError).toBe(true);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});

describe('approval seam', () => {
  it('installs the gate in every mode, so the cold-send exception survives', () => {
    for (const mode of ['disabled', 'approval', 'direct'] as const) {
      const { ext } = makeExt({ send_mode: mode });
      expect(sendTool(ext).approval?.enabled).toBe(true);
    }
  });

  it('skips approval for a direct-mode existing thread but asks for a cold number', async () => {
    const { ext } = makeExt({ send_mode: 'direct' });
    await ext.handle('gmessages__chats', {}, call); // warm the resolution cache
    const filter = sendTool(ext).approval!.filter!;
    expect(filter({ chat: 'Alice' }, noHistory)).toBe('skip');
    // The invariant: no global mode silences first contact.
    expect(filter({ chat: '+19995551234' }, noHistory)).toBe('approve');
  });

  it('asks in approval mode and blocks a denied thread', async () => {
    const { ext } = makeExt({ send_mode: 'approval', chats: { c2: { send: 'deny' } } });
    await ext.handle('gmessages__chats', {}, call);
    const filter = sendTool(ext).approval!.filter!;
    expect(filter({ chat: 'Alice' }, noHistory)).toBe('approve');
    expect(filter({ chat: '+14155550000' }, noHistory)).toBe('block');
  });

  it('previews the recipient, the text, and the EXACT bytes that would go out', async () => {
    const { ext } = makeExt({ send_mode: 'approval' });
    await ext.handle('gmessages__chats', {}, call);
    const preview = sendTool(ext).approval!.preview({ chat: 'Alice', text: 'hello' });

    expect(preview.summary).toBe('Send to Alice Chen: hello');
    expect(preview.details).toMatch(/^Exact request: \d+ bytes/);

    // The strongest form of this assertion: the previewed bytes must equal what
    // the library's own builder produces for the resolved target. If the gate
    // ever previewed one thing and sent another, this fails.
    const hex = preview.details!.split('\n')[1]!;
    const expected = buildSendPlaintext(
      { conversationId: 'c1', text: 'hello', participantId: 'me' },
      'tmp_preview',
    );
    expect(hex).toBe(Buffer.from(expected).toString('hex'));
    // And the authorising human can see the text in what they are shown.
    expect(Buffer.from(hex, 'hex').toString('utf8')).toContain('hello');
  });

  it('marks an unresolved cold target as NEW in the preview', async () => {
    const { ext } = makeExt({ send_mode: 'approval' });
    await ext.handle('gmessages__chats', {}, call);
    const preview = sendTool(ext).approval!.preview({ chat: '+19995551234', text: 'hi' });
    expect(preview.summary).toContain('NEW conversation');
  });
});
