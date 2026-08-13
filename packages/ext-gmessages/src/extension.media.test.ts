/**
 * Media-slice tests — the extension↔library seam for attachments.
 *
 * The library's upload/download is the trusted boundary and is faked. What is
 * under test is this layer: mime resolution, staging-path handling, the
 * message→attachment lookup that exists because there is no local store, and
 * whether the gate lets an attachment out.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { ConversationSummary, InboundMessage, InboundAttachment, Client } from 'gmessages';

import { GmessagesExtension, type ReadDeps } from './extension.js';
import type { ConnectionLike } from './connection.js';
import { GmessagesConfigSchema, type GmessagesConfig } from './schemas.js';
import type { ExtensionContext, ToolCallContext } from '@getcast/extension-schema';

const CONVERSATIONS: ConversationSummary[] = [
  { conversationId: 'c1', type: 1, kind: 'rcs', participants: ['Alice Chen'], raw: {} as never },
];

function attachment(over: Partial<InboundAttachment> = {}): InboundAttachment {
  return {
    mediaId: 'media-1',
    key: new Uint8Array(32),
    mimeType: 'image/jpeg',
    sizeBytes: 3n,
    fileName: 'photo.jpg',
    partId: 'p1',
    ...over,
  };
}

function message(over: Partial<InboundMessage> = {}): InboundMessage {
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

function fakeConnection(withMedia = true): ConnectionLike {
  return {
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    pair: vi.fn(),
    isPaired: () => true,
    isConnected: () => true,
    ownParticipantId: () => 'me',
    deadReason: () => null,
    ready: Promise.resolve(),
    socket: {
      operations: {},
      media: withMedia ? ({ mediaUrl: 'https://x/upload' } as never) : null,
    } as unknown as Client,
  };
}

describe('media', () => {
  let dir: string;
  let call: ToolCallContext;

  function makeExt(
    config: Partial<GmessagesConfig>,
    reads: Partial<ReadDeps> = {},
    connection?: ConnectionLike,
  ) {
    const ctx = {
      config: GmessagesConfigSchema.parse(config),
      privateDir: path.join(dir, 'private'),
      deliver: vi.fn(),
    } as unknown as ExtensionContext<GmessagesConfig, never>;
    const deps: ReadDeps = {
      listConversations: vi.fn(async () => CONVERSATIONS),
      listMessages: vi.fn(async () => [message({ attachments: [attachment()] })]),
      sendMessage: vi.fn(async () => new Uint8Array()),
      uploadMedia: vi.fn(async () => ({ mediaId: 'up1', key: new Uint8Array(32), sizeBytes: 4n })),
      downloadMedia: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' })),
      getFullSizeMedia: vi.fn(async () => message({ attachments: [attachment()] })),
      sendMediaMessage: vi.fn(async () => new Uint8Array()),
      ...reads,
    };
    return {
      ext: new GmessagesExtension(ctx, {
        connection: connection ?? fakeConnection(),
        reads: deps,
        sleep: async () => {},
      }),
      deps,
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-media-'));
    call = {
      stagingDir: path.join(dir, 'in'),
      stagingOutDir: path.join(dir, 'out'),
    } as ToolCallContext;
    fs.mkdirSync(call.stagingOutDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // -------------------------------------------------------------------------

  describe('gmessages__download', () => {
    it('resolves the message, decrypts with the wire key, and writes to staging', async () => {
      const { ext, deps } = makeExt({ read_mode: 'open' });
      const res = await ext.handle('gmessages__download', { chat: 'Alice', message_id: 'm1' }, call);

      expect(res.isError).toBeFalsy();
      expect(res.content[0]!.text).toContain('/staging/in/gm-m1-0-photo.jpg');
      // The key must come off the message, not be invented.
      const [, mediaId, key] = (deps.downloadMedia as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(mediaId).toBe('media-1');
      expect(key).toEqual(new Uint8Array(32));
      expect(fs.readFileSync(path.join(call.stagingDir, 'gm-m1-0-photo.jpg'))).toEqual(Buffer.from([1, 2, 3]));
    });

    it('reports a message it cannot find rather than downloading something else', async () => {
      const { ext, deps } = makeExt({ read_mode: 'open' });
      const res = await ext.handle('gmessages__download', { chat: 'Alice', message_id: 'nope' }, call);
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('not found');
      expect(deps.downloadMedia).not.toHaveBeenCalled();
    });

    // Direction is irrelevant and worth pinning: outbound and inbound behave identically, because what
    // decides it is whether the media has been RESOLVED, not who sent it.
    for (const [label, statusCode] of [['outbound', 1], ['inbound', 100]] as const) {
      it(`resolves an unresolved ${label} attachment instead of failing`, async () => {
        const unresolved = attachment({ mediaId: '', key: new Uint8Array(), partId: 'part-7' });
        // Measured: the reply echoes the part STILL EMPTY and the handle appears on a later read.
        // A fake that returns it resolved would test a protocol that does not exist.
        let reads = 0;
        const { ext, deps } = makeExt({ read_mode: 'open' }, {
          listMessages: vi.fn(async () => [
            message({
              statusCode,
              attachments: [reads++ === 0 ? unresolved : attachment({ partId: 'part-7' })],
            }),
          ]),
          getFullSizeMedia: vi.fn(async () => message({ attachments: [unresolved] })),
        });
        const res = await ext.handle('gmessages__download', { chat: 'Alice', message_id: 'm1' }, call);

        expect(res.isError).toBeFalsy();
        // Resolved by message id AND part id — a message can carry several parts.
        expect(deps.getFullSizeMedia).toHaveBeenCalledWith(expect.anything(), 'm1', 'part-7');
        // …and the handle used for the download is the one resolution produced, not the empty one.
        const [, mediaId] = (deps.downloadMedia as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(mediaId).toBe('media-1');
      });
    }

    it('resolves the attachment that was ASKED FOR, not whichever comes back first', async () => {
      // The bug this pins: resolve by part id, then take attachments[0] from the reply. With two
      // attachments that silently downloads the wrong one and reports success — worse than any error.
      const first = attachment({ mediaId: '', key: new Uint8Array(), partId: 'part-A' });
      const second = attachment({ mediaId: '', key: new Uint8Array(), partId: 'part-B' });
      let reads = 0;
      const { ext, deps } = makeExt({ read_mode: 'open' }, {
        listMessages: vi.fn(async () => [
          message({
            attachments:
              reads++ === 0
                ? [first, second]
                : [
                    attachment({ mediaId: 'wrong-media', partId: 'part-A' }),
                    attachment({ mediaId: 'right-media', partId: 'part-B' }),
                  ],
          }),
        ]),
        getFullSizeMedia: vi.fn(async () => message({ attachments: [first, second] })),
      });

      const res = await ext.handle(
        'gmessages__download',
        { chat: 'Alice', message_id: 'm1', index: 1 },
        call,
      );
      expect(res.isError).toBeFalsy();
      expect(deps.getFullSizeMedia).toHaveBeenCalledWith(expect.anything(), 'm1', 'part-B');
      const [, mediaId] = (deps.downloadMedia as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(mediaId).toBe('right-media');
    });

    it('downloads a later attachment by index', async () => {
      const { ext, deps } = makeExt({ read_mode: 'open' }, {
        listMessages: vi.fn(async () => [
          message({
            attachments: [
              attachment({ mediaId: 'first', fileName: 'a.jpg' }),
              attachment({ mediaId: 'second', fileName: 'b.jpg' }),
            ],
          }),
        ]),
      });
      const res = await ext.handle(
        'gmessages__download',
        { chat: 'Alice', message_id: 'm1', index: 1 },
        call,
      );
      expect(res.content[0]!.text).toContain('gm-m1-1-b.jpg');
      const [, mediaId] = (deps.downloadMedia as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(mediaId).toBe('second');
    });

    it('gives each attachment its own filename, even when the relay names them identically', async () => {
      // Every inbound photo arrives as "Attachment0". Naming the staged file after that meant the
      // second download overwrote the first and the agent reported two images while holding one.
      const both = [
        attachment({ mediaId: 'a', partId: 'pa', fileName: 'Attachment0' }),
        attachment({ mediaId: 'b', partId: 'pb', fileName: 'Attachment0' }),
      ];
      const { ext } = makeExt({ read_mode: 'open' }, {
        listMessages: vi.fn(async () => [message({ attachments: both })]),
      });

      await ext.handle('gmessages__download', { chat: 'Alice', message_id: 'm1', index: 0 }, call);
      await ext.handle('gmessages__download', { chat: 'Alice', message_id: 'm1', index: 1 }, call);

      const staged = fs.readdirSync(call.stagingDir).sort();
      expect(staged).toHaveLength(2);
      // "Attachment0" carries no extension, so the mime-derived one is used instead — which also
      // matters downstream, since the Read tool needs it to treat the file as an image.
      expect(staged).toEqual(['gm-m1-0.jpeg', 'gm-m1-1.jpeg']);
    });

    it('gives attachments on DIFFERENT messages distinct filenames', async () => {
      // The case actually reported: two images arrived as two separate messages, one attachment each,
      // both named "Attachment0" by the relay — so the second download overwrote the first and the
      // agent believed it held two images while holding one. The earlier multi-attachment test does
      // NOT cover this: it varies the index, whereas here the index is 0 both times and only the
      // message id differs.
      const { ext } = makeExt({ read_mode: 'open' }, {
        listMessages: vi.fn(async () => [
          message({ messageId: '19631', attachments: [attachment({ mediaId: 'a', fileName: 'Attachment0' })] }),
          message({ messageId: '19633', attachments: [attachment({ mediaId: 'b', fileName: 'Attachment0' })] }),
        ]),
      });

      await ext.handle('gmessages__download', { chat: 'Alice', message_id: '19631' }, call);
      await ext.handle('gmessages__download', { chat: 'Alice', message_id: '19633' }, call);

      const staged = fs.readdirSync(call.stagingDir).sort();
      expect(staged).toEqual(['gm-19631-0.jpeg', 'gm-19633-0.jpeg']);
    });

    it('reports an out-of-range index with the count, rather than silently using the first', async () => {
      const { ext, deps } = makeExt({ read_mode: 'open' });
      const res = await ext.handle(
        'gmessages__download',
        { chat: 'Alice', message_id: 'm1', index: 5 },
        call,
      );
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('1 attachment(s)');
      expect(deps.downloadMedia).not.toHaveBeenCalled();
    });

    it('does not resolve when the attachment already has a handle', async () => {
      const { ext, deps } = makeExt({ read_mode: 'open' });
      await ext.handle('gmessages__download', { chat: 'Alice', message_id: 'm1' }, call);
      expect(deps.getFullSizeMedia).not.toHaveBeenCalled();
    });

    it('gives up cleanly when the media never resolves', async () => {
      const { ext, deps } = makeExt({ read_mode: 'open' }, {
        // Never gains a handle, however many times it is re-read.
        listMessages: vi.fn(async () => [
          message({ attachments: [attachment({ mediaId: '', key: new Uint8Array(), partId: 'p9' })] }),
        ]),
        getFullSizeMedia: vi.fn(async () => message({ attachments: [] })),
      });
      const res = await ext.handle('gmessages__download', { chat: 'Alice', message_id: 'm1' }, call);
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('still being fetched');
      expect(deps.downloadMedia).not.toHaveBeenCalled();
    });

    it('refuses to resolve without a part id', async () => {
      const { ext, deps } = makeExt({ read_mode: 'open' }, {
        listMessages: vi.fn(async () => [
          message({ attachments: [attachment({ mediaId: '', partId: '' })] }),
        ]),
      });
      const res = await ext.handle('gmessages__download', { chat: 'Alice', message_id: 'm1' }, call);
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('no part id');
      expect(deps.getFullSizeMedia).not.toHaveBeenCalled();
    });

    it('refuses when reading the conversation is denied', async () => {
      const { ext, deps } = makeExt({ read_mode: 'open', chats: { c1: { read: 'deny' } } });
      const res = await ext.handle('gmessages__download', { chat: 'Alice', message_id: 'm1' }, call);
      expect(res.isError).toBe(true);
      expect(deps.downloadMedia).not.toHaveBeenCalled();
    });

    it('falls back to a generated name when the relay supplied none', async () => {
      const { ext } = makeExt({ read_mode: 'open' }, {
        listMessages: vi.fn(async () => [message({ attachments: [attachment({ fileName: '' })] })]),
      });
      const res = await ext.handle('gmessages__download', { chat: 'Alice', message_id: 'm1' }, call);
      expect(res.content[0]!.text).toContain('/staging/in/gm-m1-0.jpeg');
    });
  });

  describe('gmessages__send with a file', () => {
    const writeFile = (name: string, bytes = Buffer.from([9, 9, 9, 9])) =>
      fs.writeFileSync(path.join(dir, 'out', name), bytes);

    it('uploads then sends, passing the upload handle straight through', async () => {
      writeFile('pic.jpg');
      const { ext, deps } = makeExt({ send_mode: 'direct' });
      const res = await ext.handle('gmessages__send', { chat: 'Alice', file: 'pic.jpg' }, call);

      expect(res.isError).toBeFalsy();
      expect(deps.uploadMedia).toHaveBeenCalledTimes(1);
      // Mime is derived from the filename, not guessed at send time.
      const [, bytes, mime] = (deps.uploadMedia as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(mime).toBe('image/jpeg');
      expect(bytes).toEqual(new Uint8Array([9, 9, 9, 9]));

      const [, params, media] = (deps.sendMediaMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(params).toEqual({ conversationId: 'c1', participantId: 'me' });
      expect(media).toEqual({
        mediaId: 'up1',
        key: new Uint8Array(32),
        sizeBytes: 4n,
        fileName: 'pic.jpg',
        mimeType: 'image/jpeg',
      });
      // A media send must not also go out as a text send.
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('does not upload when sending is disabled', async () => {
      writeFile('pic.jpg');
      const { ext, deps } = makeExt({ send_mode: 'disabled' });
      const res = await ext.handle('gmessages__send', { chat: 'Alice', file: 'pic.jpg' }, call);
      expect(res.isError).toBe(true);
      expect(deps.uploadMedia).not.toHaveBeenCalled();
    });

    it('does not upload for a deny-listed conversation', async () => {
      writeFile('pic.jpg');
      const { ext, deps } = makeExt({ send_mode: 'direct', chats: { c1: { send: 'deny' } } });
      const res = await ext.handle('gmessages__send', { chat: 'Alice', file: 'pic.jpg' }, call);
      expect(res.isError).toBe(true);
      expect(deps.uploadMedia).not.toHaveBeenCalled();
    });

    it('refuses a type the relay format table does not carry', async () => {
      writeFile('notes.xyz');
      const { ext, deps } = makeExt({ send_mode: 'direct' });
      const res = await ext.handle('gmessages__send', { chat: 'Alice', file: 'notes.xyz' }, call);
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('supported type');
      expect(deps.uploadMedia).not.toHaveBeenCalled();
    });

    it('refuses a missing file', async () => {
      const { ext, deps } = makeExt({ send_mode: 'direct' });
      const res = await ext.handle('gmessages__send', { chat: 'Alice', file: 'ghost.jpg' }, call);
      expect(res.isError).toBe(true);
      expect(deps.uploadMedia).not.toHaveBeenCalled();
    });

    it('cannot be walked out of the staging directory', async () => {
      // A traversal argument is reduced to its basename, so it resolves inside
      // staging and simply does not exist.
      const { ext, deps } = makeExt({ send_mode: 'direct' });
      const res = await ext.handle(
        'gmessages__send',
        { chat: 'Alice', file: '../../../etc/hosts' },
        call,
      );
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('/staging/out/hosts');
      expect(deps.uploadMedia).not.toHaveBeenCalled();
    });

    it('reports a session with no media endpoint instead of crashing', async () => {
      writeFile('pic.jpg');
      const { ext, deps } = makeExt({ send_mode: 'direct' }, {}, fakeConnection(false));
      const res = await ext.handle('gmessages__send', { chat: 'Alice', file: 'pic.jpg' }, call);
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('Media is not available');
      expect(deps.uploadMedia).not.toHaveBeenCalled();
    });

    it('names the file in the approval preview', async () => {
      const { ext } = makeExt({ send_mode: 'approval' });
      await ext.handle('gmessages__chats', {}, call);
      const tool = ext.tools.find((t) => t.name === 'gmessages__send')!;
      const preview = tool.approval!.preview({ chat: 'Alice', file: 'pic.jpg', text: 'look' });
      // An approver must see WHAT is leaving, not just the caption.
      expect(preview.summary).toContain('[file: pic.jpg]');
      expect(preview.summary).toContain('look');
    });
  });
});
