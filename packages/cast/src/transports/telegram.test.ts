/**
 * Unit tests for the Telegram transport's edit-in-place streaming surface
 * (§3.6) + 60s watchdog. Replaces the live-bot dogfood (§3.10): we can't
 * meaningfully reproduce real 429 cascades or mid-stream chat-deletes from
 * code, but we CAN pin the state-machine and error-classifier branches.
 *
 * Approach: stub `bot.api` on the constructed transport's BotEntry so every
 * sendMessage / editMessageText call is captured, no network. Assertions are
 * on the captured call sequences — observable behavior, not private state.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GrammyError } from 'grammy';
import type { Bot } from 'grammy';
import type { Message, Update, UserFromGetMe } from 'grammy/types';

import { serializeMessageContext, telegram } from './telegram.js';
import { conversationPkt, previewTextPkt } from '../gateway/packets.js';
import type { TransportContext, Transport } from './schema.js';
import type { BusAddress } from '../auth/address.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
const AGENT_ADDR = 'a:agent-123';
const CHAT_ID = 42;
const PARTICIPANT = `tg:${CHAT_ID}`;

interface BotApiStub {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  setMyCommands: ReturnType<typeof vi.fn>;
  /** grammy's handleUpdate reads bot.api.config.installedTransformers() when
   *  constructing the per-update Api — stub it so inbound tests can inject
   *  updates through the real middleware pipeline. */
  config: { installedTransformers: () => unknown[] };
}

interface TransportInternals {
  tokenToBotEntry: Map<string, { bot: { api: BotApiStub; stop: ReturnType<typeof vi.fn> } }>;
  agentToEntry: Map<string, { bot: { api: BotApiStub; stop: ReturnType<typeof vi.fn> } }>;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeCtx(): TransportContext {
  return {
    ingestInbound: vi.fn(),
    ingestApprovalResponse: vi.fn(),
    // Identity passthrough — we don't exercise the IdP path here.
    resolveAddress: (a: string) => a as unknown as BusAddress,
    listSystemCommands: () => [],
    log: makeLogger(),
  };
}

function notModifiedError(): GrammyError {
  return new GrammyError(
    'Bad Request: message is not modified',
    { ok: false, error_code: 400, description: 'Bad Request: message is not modified' },
    'editMessageText',
    {},
  );
}

function rateLimitError(): GrammyError {
  return new GrammyError(
    'Too Many Requests: retry after 5',
    { ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' },
    'editMessageText',
    {},
  );
}

function chatDeletedError(): GrammyError {
  return new GrammyError(
    'Bad Request: message to edit not found',
    { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' },
    'editMessageText',
    {},
  );
}

interface Harness {
  transport: Transport;
  api: BotApiStub;
  botStop: ReturnType<typeof vi.fn>;
  ctx: TransportContext;
}

function makeHarness(opts: { streaming?: boolean } = {}): Harness {
  const ctx = makeCtx();
  const transport = telegram.create(ctx, [
    { address: AGENT_ADDR, token: FAKE_TOKEN, streaming: opts.streaming ?? true },
  ]);
  if (!transport) throw new Error('telegram.create returned null — fixture broken');

  // Replace the real grammy Bot's api with a stub. Construction already
  // happened with the real Bot; we just swap the api object reference. The
  // tokenToBotEntry map is private; we reach in via a type assertion that's
  // local to this test fixture.
  const api: BotApiStub = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    setMyCommands: vi.fn().mockResolvedValue(true),
    config: { installedTransformers: () => [] },
  };
  const botStop = vi.fn();
  const internals = transport as unknown as TransportInternals;
  for (const entry of internals.tokenToBotEntry.values()) {
    (entry.bot as unknown as { api: BotApiStub; stop: typeof botStop }).api = api;
    (entry.bot as unknown as { api: BotApiStub; stop: typeof botStop }).stop = botStop;
  }
  return { transport, api, botStop, ctx };
}

function preview(streamId: string, text: string) {
  return previewTextPkt(AGENT_ADDR, PARTICIPANT, text, streamId, 'default');
}

function seal(text: string, streamId?: string) {
  return conversationPkt(AGENT_ADDR, PARTICIPANT, text, undefined, undefined, undefined, undefined, streamId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelegramTransport — preview streaming', () => {
  let h: Harness;

  beforeEach(() => { h = makeHarness(); });

  it('first preview frame creates the bubble via sendMessage', async () => {
    await h.transport.send(preview('strm-1', 'partial response'), { agentAddress: AGENT_ADDR });
    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.api.sendMessage).toHaveBeenCalledWith(CHAT_ID, 'partial response');
    expect(h.api.editMessageText).not.toHaveBeenCalled();
  });

  it('subsequent preview frame edits in place via editMessageText', async () => {
    await h.transport.send(preview('strm-1', 'partial'), { agentAddress: AGENT_ADDR });
    await h.transport.send(preview('strm-1', 'partial response'), { agentAddress: AGENT_ADDR });
    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.api.editMessageText).toHaveBeenCalledTimes(1);
    expect(h.api.editMessageText).toHaveBeenCalledWith(CHAT_ID, 100, 'partial response');
  });

  it('preview with identical text to last is silently skipped (dedup)', async () => {
    await h.transport.send(preview('strm-1', 'same text'), { agentAddress: AGENT_ADDR });
    await h.transport.send(preview('strm-1', 'same text'), { agentAddress: AGENT_ADDR });
    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.api.editMessageText).not.toHaveBeenCalled();
  });

  it('empty preview is silently skipped (no bubble created)', async () => {
    await h.transport.send(preview('strm-1', ''), { agentAddress: AGENT_ADDR });
    expect(h.api.sendMessage).not.toHaveBeenCalled();
    expect(h.api.editMessageText).not.toHaveBeenCalled();
  });

  it('initial preview > 4096 chars is truncated on send', async () => {
    const huge = 'x'.repeat(5000);
    await h.transport.send(preview('strm-1', huge), { agentAddress: AGENT_ADDR });
    const sentText = h.api.sendMessage.mock.calls[0]![1] as string;
    expect(sentText.length).toBe(4096);
  });
});

describe('TelegramTransport — seal handoff', () => {
  let h: Harness;

  beforeEach(() => { h = makeHarness(); });

  it('seal with matching streamId edits the existing message (no fresh sendMessage)', async () => {
    await h.transport.send(preview('strm-1', 'partial'), { agentAddress: AGENT_ADDR });
    await h.transport.send(seal('partial response final', 'strm-1'), { agentAddress: AGENT_ADDR });
    expect(h.api.sendMessage).toHaveBeenCalledTimes(1); // only the initial preview
    expect(h.api.editMessageText).toHaveBeenCalledTimes(1);
    expect(h.api.editMessageText).toHaveBeenCalledWith(CHAT_ID, 100, 'partial response final');
  });

  it('seal with matching streamId whose text equals lastText skips the edit (dedup)', async () => {
    await h.transport.send(preview('strm-1', 'final'), { agentAddress: AGENT_ADDR });
    await h.transport.send(seal('final', 'strm-1'), { agentAddress: AGENT_ADDR });
    expect(h.api.editMessageText).not.toHaveBeenCalled();
  });

  it('seal without streamId fresh-sends via sendMessage (no edit attempted)', async () => {
    await h.transport.send(seal('plain reply'), { agentAddress: AGENT_ADDR });
    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.api.sendMessage).toHaveBeenCalledWith(CHAT_ID, 'plain reply');
    expect(h.api.editMessageText).not.toHaveBeenCalled();
  });

  it('seal with streamId but no matching stream entry falls back to fresh send', async () => {
    // No preview fired — seal arrives with a streamId that has no in-flight entry.
    await h.transport.send(seal('reply', 'ghost-stream-id'), { agentAddress: AGENT_ADDR });
    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.api.editMessageText).not.toHaveBeenCalled();
  });

  it('seal text > 4096 settles the bubble to chunk1 and fresh-sends only the tail', async () => {
    await h.transport.send(preview('strm-1', 'partial'), { agentAddress: AGENT_ADDR });
    const huge = 'y'.repeat(5000);
    await h.transport.send(seal(huge, 'strm-1'), { agentAddress: AGENT_ADDR });
    // The streamed bubble is settled to chunk1 via editMessageText (one edit).
    expect(h.api.editMessageText).toHaveBeenCalledTimes(1);
    const [, msgId, headText] = h.api.editMessageText.mock.calls[0]! as [number, number, string];
    expect(msgId).toBe(100);
    expect(headText.length).toBeLessThanOrEqual(4096);
    // sendMessage = 1 initial preview + 1 tail chunk (5000 - chunk1 leaves ~900 chars).
    expect(h.api.sendMessage).toHaveBeenCalledTimes(2);
    const tailText = h.api.sendMessage.mock.calls[1]![1] as string;
    // Tail does NOT duplicate chunk1 — no overlap at the boundary.
    expect(tailText).not.toBe(headText);
    expect(headText + tailText).toBe(huge);
  });

  it('seal text > 4096 with head-edit failure falls back to caller chunked fresh-send', async () => {
    h.api.editMessageText.mockRejectedValueOnce(chatDeletedError());
    await h.transport.send(preview('strm-1', 'partial'), { agentAddress: AGENT_ADDR });
    const huge = 'y'.repeat(5000);
    await h.transport.send(seal(huge, 'strm-1'), { agentAddress: AGENT_ADDR });
    // Head edit attempted and failed → sealStream returned false → caller
    // chunked-fresh-send took over. sendMessage = 1 preview + 2 chunks.
    expect(h.api.editMessageText).toHaveBeenCalledTimes(1);
    expect(h.api.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('seal text > 4096 with chunk1 matching lastText skips edit but still sends tail', async () => {
    // Pre-seed the bubble with the exact text that will become chunk1. chunkText
    // breaks at the last newline before 4096; with no newlines, that's char 4096.
    const huge = 'y'.repeat(5000);
    const expectedHead = 'y'.repeat(4096);
    await h.transport.send(preview('strm-1', expectedHead), { agentAddress: AGENT_ADDR });
    h.api.editMessageText.mockClear();
    h.api.sendMessage.mockClear();
    await h.transport.send(seal(huge, 'strm-1'), { agentAddress: AGENT_ADDR });
    // Dedup: chunk1 === lastText, so no edit. Tail is one fresh sendMessage.
    expect(h.api.editMessageText).not.toHaveBeenCalled();
    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('seal after seal-cleared stream behaves as fresh (entry was dropped at seal)', async () => {
    await h.transport.send(preview('strm-1', 'partial'), { agentAddress: AGENT_ADDR });
    await h.transport.send(seal('done', 'strm-1'), { agentAddress: AGENT_ADDR });
    // Now another preview with the same streamId — should re-create, not edit.
    await h.transport.send(preview('strm-1', 'reborn'), { agentAddress: AGENT_ADDR });
    // sendMessage: 1 (preview) + 1 (reborn preview) = 2; editMessageText: 1 (seal edit).
    expect(h.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.api.editMessageText).toHaveBeenCalledTimes(1);
  });
});

describe('TelegramTransport — error handling', () => {
  let h: Harness;

  beforeEach(() => { h = makeHarness(); });

  it('400 "message is not modified" on edit is silent (no error log, stream preserved)', async () => {
    h.api.editMessageText.mockRejectedValueOnce(notModifiedError());
    await h.transport.send(preview('strm-1', 'first'), { agentAddress: AGENT_ADDR });
    await h.transport.send(preview('strm-1', 'second'), { agentAddress: AGENT_ADDR });
    // The edit attempt failed-silently; another preview should still try to edit.
    await h.transport.send(preview('strm-1', 'third'), { agentAddress: AGENT_ADDR });
    expect(h.api.editMessageText).toHaveBeenCalledTimes(2);
    // No warn logged for "not modified".
    const warnCalls = (h.ctx.log.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.find((c) => String(c[1] ?? c[0]).includes('failed'))).toBeUndefined();
  });

  it('429 rate-limit on edit is debug-logged and skipped; next frame retries (entry preserved)', async () => {
    h.api.editMessageText.mockRejectedValueOnce(rateLimitError());
    await h.transport.send(preview('strm-1', 'first'), { agentAddress: AGENT_ADDR });
    await h.transport.send(preview('strm-1', 'second'), { agentAddress: AGENT_ADDR });
    // 429 fired — should NOT have dropped the entry. Next preview should edit again.
    await h.transport.send(preview('strm-1', 'third'), { agentAddress: AGENT_ADDR });
    expect(h.api.editMessageText).toHaveBeenCalledTimes(2);
    expect(h.api.sendMessage).toHaveBeenCalledTimes(1); // never re-created the bubble
  });

  it('persistent 4xx on edit (e.g. chat deleted) drops the entry; next frame fresh-sends', async () => {
    h.api.editMessageText.mockRejectedValueOnce(chatDeletedError());
    await h.transport.send(preview('strm-1', 'first'), { agentAddress: AGENT_ADDR });
    await h.transport.send(preview('strm-1', 'second'), { agentAddress: AGENT_ADDR });
    // Edit failed → entry dropped. Next preview should sendMessage again, not edit.
    await h.transport.send(preview('strm-1', 'third'), { agentAddress: AGENT_ADDR });
    expect(h.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.api.editMessageText).toHaveBeenCalledTimes(1);
  });
});

describe('TelegramTransport — watchdog GC', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('60s without an edit drops the entry; next preview behaves as fresh', async () => {
    const h = makeHarness();
    await h.transport.send(preview('strm-1', 'first'), { agentAddress: AGENT_ADDR });
    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);

    // Advance past the watchdog (STREAM_WATCHDOG_MS = 60000)
    vi.advanceTimersByTime(60_001);

    await h.transport.send(preview('strm-1', 'much later'), { agentAddress: AGENT_ADDR });
    // Watchdog dropped the entry → fresh sendMessage, no edit.
    expect(h.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.api.editMessageText).not.toHaveBeenCalled();
  });

  it('an edit within the window refreshes the watchdog', async () => {
    const h = makeHarness();
    await h.transport.send(preview('strm-1', 'first'), { agentAddress: AGENT_ADDR });
    vi.advanceTimersByTime(30_000); // half-way through window
    await h.transport.send(preview('strm-1', 'mid-stream'), { agentAddress: AGENT_ADDR });
    // Edit refreshed the watchdog — another 30s passes, total elapsed since last
    // edit is 30s, still well within the 60s window.
    vi.advanceTimersByTime(30_000);
    await h.transport.send(preview('strm-1', 'still alive'), { agentAddress: AGENT_ADDR });
    expect(h.api.sendMessage).toHaveBeenCalledTimes(1); // entry still alive, no re-create
    expect(h.api.editMessageText).toHaveBeenCalledTimes(2);
  });
});

describe('TelegramTransport — disconnect', () => {
  it('disconnect() tombstones all entries + stops the bot', async () => {
    const h = makeHarness();
    await h.transport.send(preview('strm-1', 'first'), { agentAddress: AGENT_ADDR });
    await h.transport.disconnect();
    expect(h.botStop).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Inbound reply/forward framing
// ---------------------------------------------------------------------------

const BOT_ID = 999;
const BOT_INFO: UserFromGetMe = {
  id: BOT_ID,
  is_bot: true,
  first_name: 'Cast',
  username: 'cast_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};
const SENDER = { id: 1111, is_bot: false as const, first_name: 'Alex' };
const JANE = { id: 2222, is_bot: false as const, first_name: 'Jane', last_name: 'Doe', username: 'jdoe' };
// 2025-01-01T00:00:00Z — pins the "originally sent" date rendering.
const ORIGIN_DATE = 1735689600;

// Update-level inbound messages are Message & Update.NonChannel (non-channel
// chat, `from` guaranteed) — the type handleUpdate accepts.
type UpdateMessage = NonNullable<Update['message']>;

function inboundMsg(overrides: Partial<UpdateMessage> = {}): UpdateMessage {
  return {
    message_id: 7,
    date: 1750000000,
    chat: { id: CHAT_ID, type: 'private', first_name: 'Alex' },
    from: SENDER,
    ...overrides,
  };
}

type ReplyTarget = NonNullable<Message['reply_to_message']>;

function replyTarget(overrides: Partial<ReplyTarget> = {}): ReplyTarget {
  return {
    message_id: 3,
    date: 1749990000,
    chat: { id: CHAT_ID, type: 'private', first_name: 'Alex' },
    reply_to_message: undefined,
    ...overrides,
  };
}

describe('serializeMessageContext — reply/forward framing', () => {
  it('returns empty string for a plain message', () => {
    expect(serializeMessageContext(inboundMsg({ text: 'hi' }), BOT_ID)).toBe('');
  });

  it('frames a forward from a user with name, username, and original date', () => {
    const msg = inboundMsg({
      text: 'check this out',
      forward_origin: { type: 'user', date: ORIGIN_DATE, sender_user: JANE },
    });
    expect(serializeMessageContext(msg, BOT_ID)).toBe('[Forwarded from Jane Doe (@jdoe), originally sent 2025-01-01]');
  });

  it('frames a forward from a hidden user by display name only', () => {
    const msg = inboundMsg({
      text: 'fwd',
      forward_origin: { type: 'hidden_user', date: ORIGIN_DATE, sender_user_name: 'Anon Person' },
    });
    expect(serializeMessageContext(msg, BOT_ID)).toBe('[Forwarded from Anon Person, originally sent 2025-01-01]');
  });

  it('frames a forward from a channel by title', () => {
    const msg = inboundMsg({
      text: 'fwd',
      forward_origin: {
        type: 'channel',
        date: ORIGIN_DATE,
        chat: { id: -1001, type: 'channel', title: 'News Wire' },
        message_id: 55,
      },
    });
    expect(serializeMessageContext(msg, BOT_ID)).toBe('[Forwarded from channel "News Wire", originally sent 2025-01-01]');
  });

  it('reply to the bot\'s own message reads "your message"', () => {
    const msg = inboundMsg({
      text: 'sounds good',
      reply_to_message: replyTarget({ from: BOT_INFO, text: 'I propose we do X' }),
    });
    expect(serializeMessageContext(msg, BOT_ID)).toBe('[Replying to your message: "I propose we do X"]');
  });

  it('reply to another participant names them', () => {
    const msg = inboundMsg({
      text: 'agreed',
      reply_to_message: replyTarget({ from: JANE, text: 'shall we ship it?' }),
    });
    expect(serializeMessageContext(msg, BOT_ID)).toBe('[Replying to Jane Doe (@jdoe): "shall we ship it?"]');
  });

  it('prefers the native partial quote over the full replied-to text', () => {
    const msg = inboundMsg({
      text: 'do this one',
      reply_to_message: replyTarget({ from: BOT_INFO, text: 'Option A: foo. Option B: bar. Option C: baz.' }),
      quote: { text: 'Option B: bar.', position: 14, is_manual: true },
    });
    expect(serializeMessageContext(msg, BOT_ID)).toBe('[Replying to your message: "Option B: bar."]');
  });

  it('truncates long reply snippets to 500 chars with ellipsis', () => {
    const msg = inboundMsg({
      text: 'ok',
      reply_to_message: replyTarget({ from: JANE, text: 'z'.repeat(600) }),
    });
    const out = serializeMessageContext(msg, BOT_ID);
    expect(out).toBe(`[Replying to Jane Doe (@jdoe): "${'z'.repeat(500)}…"]`);
  });

  it('reply to a media-only message falls back to a type tag', () => {
    const msg = inboundMsg({
      text: 'nice shot',
      reply_to_message: replyTarget({
        from: JANE,
        photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 100, height: 100 }],
      }),
    });
    expect(serializeMessageContext(msg, BOT_ID)).toBe('[Replying to Jane Doe (@jdoe)\'s photo]');
  });

  it('reply to captioned media uses the caption as the snippet', () => {
    const msg = inboundMsg({
      text: 'love it',
      reply_to_message: replyTarget({
        from: JANE,
        photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 100, height: 100 }],
        caption: 'sunset from the roof',
      }),
    });
    expect(serializeMessageContext(msg, BOT_ID)).toBe('[Replying to Jane Doe (@jdoe): "sunset from the roof"]');
  });

  it('external reply (message in another chat) frames the origin + quote', () => {
    const msg = inboundMsg({
      text: 'thoughts?',
      external_reply: {
        origin: {
          type: 'channel',
          date: ORIGIN_DATE,
          chat: { id: -1001, type: 'channel', title: 'News Wire' },
          message_id: 12,
        },
      },
      quote: { text: 'markets rallied today', position: 0 },
    });
    expect(serializeMessageContext(msg, BOT_ID)).toBe('[Replying to a message from channel "News Wire": "markets rallied today"]');
  });
});

describe('TelegramTransport — inbound reply/forward integration', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /**
   * Drive the real grammy middleware pipeline without network: register the
   * transport's handlers via the private setupBot, seed botInfo so
   * handleUpdate doesn't try getMe, inject the update, then advance past the
   * inbound debounce window so the burst flushes into ingestInbound.
   */
  async function deliver(h: Harness, message: UpdateMessage): Promise<void> {
    // Private-member reach-in, local to this fixture (same pattern as
    // TransportInternals above).
    const internals = h.transport as unknown as {
      tokenToBotEntry: Map<string, { bot: Bot }>;
      setupBot(entry: unknown): void;
    };
    const entry = internals.tokenToBotEntry.get(FAKE_TOKEN)!;
    entry.bot.botInfo = BOT_INFO;
    internals.setupBot(entry);
    await entry.bot.handleUpdate({ update_id: 1, message });
    vi.advanceTimersByTime(1001); // DEBOUNCE_MS + 1
  }

  function ingestedText(h: Harness): string {
    const calls = (h.ctx.ingestInbound as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    return calls[0]![2] as string;
  }

  it('prepends the reply frame to the typed text', async () => {
    const h = makeHarness();
    await deliver(h, inboundMsg({
      text: 'sounds good',
      reply_to_message: replyTarget({ from: BOT_INFO, text: 'I propose we do X' }),
    }));
    expect(ingestedText(h)).toBe('[Replying to your message: "I propose we do X"]\nsounds good');
  });

  it('prepends the forward frame ahead of forwarded text', async () => {
    const h = makeHarness();
    await deliver(h, inboundMsg({
      text: 'the original post body',
      forward_origin: { type: 'user', date: ORIGIN_DATE, sender_user: JANE },
    }));
    expect(ingestedText(h)).toBe('[Forwarded from Jane Doe (@jdoe), originally sent 2025-01-01]\nthe original post body');
  });

  it('commands skip the frame — a reply carrying /whoami stays a bare command', async () => {
    const h = makeHarness();
    await deliver(h, inboundMsg({
      text: '/whoami',
      reply_to_message: replyTarget({ from: BOT_INFO, text: 'earlier reply' }),
    }));
    expect(ingestedText(h)).toBe('/whoami');
  });
});

describe('TelegramTransport — streaming disabled (route config)', () => {
  it('preview frames are dropped at the gate — no sendMessage, no editMessageText', async () => {
    const h = makeHarness({ streaming: false });
    await h.transport.send(preview('strm-1', 'first chunk'), { agentAddress: AGENT_ADDR });
    await h.transport.send(preview('strm-1', 'second chunk'), { agentAddress: AGENT_ADDR });
    expect(h.api.sendMessage).not.toHaveBeenCalled();
    expect(h.api.editMessageText).not.toHaveBeenCalled();
  });

  it('seal with streamId fresh-sends (no stream entry exists, falls through to chunked send)', async () => {
    const h = makeHarness({ streaming: false });
    await h.transport.send(preview('strm-1', 'partial'), { agentAddress: AGENT_ADDR });
    await h.transport.send(seal('the full final reply', 'strm-1'), { agentAddress: AGENT_ADDR });
    // No edit ever — streaming was off, no entry was created for sealStream to find.
    expect(h.api.editMessageText).not.toHaveBeenCalled();
    // Seal fresh-sends the full text via the chunked path.
    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.api.sendMessage).toHaveBeenCalledWith(CHAT_ID, 'the full final reply');
  });

  it('streaming=true (default) baseline still streams — confirms the toggle is the only gate', async () => {
    const h = makeHarness({ streaming: true });
    await h.transport.send(preview('strm-1', 'first'), { agentAddress: AGENT_ADDR });
    await h.transport.send(preview('strm-1', 'first then second'), { agentAddress: AGENT_ADDR });
    expect(h.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.api.editMessageText).toHaveBeenCalledTimes(1);
  });
});
