import fs from 'fs';

import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import { z } from 'zod';

import type { BusAddress } from '../auth/address.js';
import type { AnyPacket } from '../gateway/packets.js';
import type { Attachment, Evt } from '../types.js';
import { renderLifecyclePhase } from '../conversations/lifecycle-render.js';
import { isDeliverablePacket } from './packet-dispatch.js';
import { MAX_ATTACHMENT_BYTES } from '../config.js';
import { defineTransport } from './schema.js';
import type { OutboundContext, Transport, TransportContext } from './schema.js';

const TELEGRAM_MAX_LENGTH = 4096;
const DEBOUNCE_MS = 1000;
// Lifecycle/typing surfaces are suppressed unless the user has interacted in
// this chat recently. Without this, scheduled-task fires leave permanent
// "Waking up…" debris above an unprompted reply.
const RECENT_USER_ACTIVITY_WINDOW_MS = 60_000;
// Preview streams that go this long without an edit are GC'd. Load-bearing
// for Phase 1 refinements 4+5 (producer leaks past container kill or
// participant disconnect): the host stops the actual frame flow long before
// 60s, so any entry stale this long is a dead bubble we should release. The
// seal-edit code path also drops the entry on its own — this only catches
// the cases where the seal never arrives.
const STREAM_WATCHDOG_MS = 60_000;

// ---------------------------------------------------------------------------
// Config schema (replaces TelegramRoute from gateway/routes.ts)
// ---------------------------------------------------------------------------

export const TelegramRouteSchema = z.object({
  address: z.string(),
  channel: z.string().optional(),
  token: z.string(),
  /** When false, drop preview frames at the transport gate — the bubble
   *  never opens and the durable seal fresh-sends instead of editing. Default
   *  true (live streaming). No admin-form field yet; hand-edit routes.json
   *  to flip. Useful for chats where the edit-in-place UX is unwanted or
   *  where Telegram rate limits make live edits flaky. */
  streaming: z.boolean().default(true),
});
export type TelegramRoute = z.infer<typeof TelegramRouteSchema>;

const TelegramConfigSchema = z.array(TelegramRouteSchema).default([]);
type TelegramConfig = z.infer<typeof TelegramConfigSchema>;

interface BotEntry {
  bot: Bot;
  token: string;
  agentAddress: string;
  channel?: string;
  /** Mirrors `TelegramRouteSchema.streaming`. False suppresses preview
   *  delivery + skips edit-in-place; the durable seal fresh-sends. */
  streaming: boolean;
}

interface PendingBurst {
  texts: string[];
  attachments: Attachment[];
  sender: string;
  senderName: string;
  agentAddress: string;
  channel?: string;
  timer: ReturnType<typeof setTimeout>;
}

interface TelegramBinding {
  token: string;
  address: BusAddress;
  channel?: string;
  streaming: boolean;
}

/**
 * In-flight preview stream — one bubble being edited in place. Keyed by
 * `streamId` in `TelegramTransport.streams` so concurrent streams (rare but
 * possible if two participants drive the same agent) don't collide. The
 * matching durable `conversation` packet carries the same `streamId` and
 * triggers `sealStream`, which edits the final text into the existing
 * message + drops the entry.
 */
interface StreamEntry {
  chatId: number;
  messageId: number;
  /** Last text sent to Telegram — dedup gate so we never call editMessageText
   *  with content that matches what's already there (the API errors otherwise). */
  lastText: string;
  /** 60s GC timer. Refreshed on every successful edit. */
  watchdog: ReturnType<typeof setTimeout>;
  /** Tombstone for async races: an edit may resolve after disconnect drops the
   *  entry. Code paths that await must re-check this before mutating state. */
  disposed: boolean;
}

/**
 * Telegram transport — creates Bot instances from gateway bindings.
 * Each bot is owned by exactly one agent. Inbound messages route through
 * the gateway; outbound messages find the bot by agent address.
 */
class TelegramTransport implements Transport {
  name = 'telegram';

  private tokenToBotEntry = new Map<string, BotEntry>();
  private agentToEntry = new Map<string, BotEntry>();
  private pendingBursts = new Map<string, PendingBurst>();
  private lastUserMessageAt = new Map<string, number>();
  private retryTimers: ReturnType<typeof setTimeout>[] = [];
  /** In-flight preview streams keyed by streamId. See StreamEntry. */
  private streams = new Map<string, StreamEntry>();
  private ctx: TransportContext;
  private botCommands: Array<{ command: string; description: string }>;

  constructor(ctx: TransportContext, bindings: TelegramBinding[]) {
    this.ctx = ctx;

    // Build Telegram bot command menu from system commands.
    // Telegram only allows [a-z0-9_] in command names, so convert hyphens.
    // /pair is gateway-handled (not in dispatcher) — include it explicitly.
    this.botCommands = [
      ...ctx.listSystemCommands().map((cmd) => ({
        command: cmd.command.slice(1).replace(/-/g, '_'),
        description: cmd.description.replace(/^\/\S+\s+—\s*/, ''),
      })),
      { command: 'pair', description: 'Pair with an agent using a code' },
    ];

    for (const { token, address, channel, streaming } of bindings) {
      const bot = new Bot(token);
      const entry: BotEntry = { bot, token, agentAddress: address, channel, streaming };
      this.tokenToBotEntry.set(token, entry);
      this.agentToEntry.set(address, entry);
    }
  }

  get botCount(): number {
    return this.tokenToBotEntry.size;
  }

  async connect(): Promise<void> {
    for (const [, entry] of this.tokenToBotEntry) {
      this.setupBot(entry);
      if (this.botCommands.length > 0) {
        entry.bot.api.setMyCommands(this.botCommands).catch((err) => {
          this.ctx.log.warn({ agentAddress: entry.agentAddress, err }, 'Failed to register Telegram commands');
        });
      }
      this.startPolling(entry);
    }
  }

  /** Start polling with auto-restart on failure (e.g. 409 conflict during deploys). */
  private startPolling(entry: BotEntry): void {
    entry.bot.start({
      onStart: () => {
        this.ctx.log.info({ agentAddress: entry.agentAddress }, 'Telegram bot started (long polling)');
      },
    }).catch((err) => {
      // grammy's polling loop exits on unrecoverable errors (e.g. 409 conflict
      // when a previous instance's getUpdates hasn't timed out). Restart after delay.
      this.ctx.log.warn({ agentAddress: entry.agentAddress, err }, 'Telegram polling stopped, restarting in 5s');
      const timer = setTimeout(() => {
        this.retryTimers = this.retryTimers.filter((t) => t !== timer);
        this.startPolling(entry);
      }, 5_000);
      this.retryTimers.push(timer);
    });
  }

  private setupBot(entry: BotEntry): void {
    entry.bot.catch((err) => {
      this.ctx.log.error({ agentAddress: entry.agentAddress, err }, 'Telegram bot error (non-fatal)');
    });

    // Approval callback buttons (Approve / Reject)
    entry.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const match = data.match(/^(apv|rej):(.+):(\w+)$/);
      if (!match) return;

      const [, action, agentAddress, approvalId] = match;
      const decision = action === 'apv' ? 'approved' as const : 'rejected' as const;
      const sender = `tg:${ctx.callbackQuery.from.id}`;

      this.ctx.ingestApprovalResponse(sender, agentAddress!, { id: approvalId!, decision });

      const label = decision === 'approved' ? '✅ Approved' : '❌ Rejected';
      try {
        await ctx.editMessageText(`${label} (${approvalId})`);
      } catch { /* message may be too old to edit */ }
      await ctx.answerCallbackQuery({ text: label });
    });

    entry.bot.on('message', (ctx) => {
      const msg = ctx.message;
      let text = msg.text || msg.caption || '';

      // Skip bot's own messages
      if (msg.from?.is_bot) return;

      // Record user activity for the lifecycle/typing recency gate.
      if (msg.from?.id !== undefined) {
        this.lastUserMessageAt.set(`${entry.token}:tg:${msg.from.id}`, Date.now());
      }

      // Serialize structured message types that aren't text or downloadable media.
      const { text: structuredText, attachments: structuredAttachments } = serializeStructuredContent(msg);
      if (structuredText) text = text ? `${text}\n${structuredText}` : structuredText;

      // Detect media — download asynchronously, then debounce
      const mediaPromise = this.extractMedia(entry.token, ctx.api, msg);

      const sender = msg.from
        ? `tg:${msg.from.id}`
        : 'tg:unknown';
      const senderName =
        msg.from
          ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || sender
          : 'Unknown';

      // Normalize Telegram command format:
      //   /set_name → /set-name  (Telegram uses underscores; we normalize to hyphens)
      //   /whoami@BotName → /whoami  (Telegram appends @bot in menus)
      text = text.replace(/^\/([a-z0-9_]+)(@\w+)?/, (_m, cmd: string) => '/' + cmd.replace(/_/g, '-'));

      if (mediaPromise) {
        mediaPromise.then((attachments) => {
          if (structuredAttachments.length) attachments.push(...structuredAttachments);
          this.debounceInbound(sender, senderName, entry.agentAddress, text, entry.channel, attachments);
        }).catch((err) => {
          this.ctx.log.warn({ agentAddress: entry.agentAddress, err }, 'Failed to download Telegram media');
          if (text) this.debounceInbound(sender, senderName, entry.agentAddress, text, entry.channel, structuredAttachments);
        });
      } else {
        if (!text && structuredAttachments.length === 0) return;
        this.debounceInbound(sender, senderName, entry.agentAddress, text, entry.channel, structuredAttachments.length > 0 ? structuredAttachments : []);
      }
    });
  }

  /** Extract and download media from a Telegram message. Returns null if no media. */
  private extractMedia(token: string, api: Bot['api'], msg: Message): Promise<Attachment[]> | null {
    // Determine file_id, mime_type, and filename from message media
    let fileId: string | undefined;
    let mimeType = 'application/octet-stream';
    let filename: string | undefined;

    if (msg.photo && msg.photo.length > 0) {
      // Photos: array of PhotoSize, last is highest resolution. Always JPEG.
      const best = msg.photo[msg.photo.length - 1]!;
      fileId = best.file_id;
      mimeType = 'image/jpeg';
      filename = 'photo.jpg';
    } else if (msg.document) {
      fileId = msg.document.file_id;
      mimeType = msg.document.mime_type || 'application/octet-stream';
      filename = msg.document.file_name;
    } else if (msg.voice) {
      fileId = msg.voice.file_id;
      mimeType = msg.voice.mime_type || 'audio/ogg';
      filename = 'voice.ogg';
    } else if (msg.audio) {
      fileId = msg.audio.file_id;
      mimeType = msg.audio.mime_type || 'audio/mpeg';
      filename = msg.audio.file_name || 'audio.mp3';
    } else if (msg.video) {
      fileId = msg.video.file_id;
      mimeType = msg.video.mime_type || 'video/mp4';
      filename = msg.video.file_name || 'video.mp4';
    } else if (msg.video_note) {
      fileId = msg.video_note.file_id;
      mimeType = 'video/mp4';
      filename = 'video_note.mp4';
    } else if (msg.sticker) {
      fileId = msg.sticker.file_id;
      mimeType = msg.sticker.is_video ? 'video/webm' : msg.sticker.is_animated ? 'application/x-tgsticker' : 'image/webp';
      filename = 'sticker.' + (msg.sticker.is_video ? 'webm' : msg.sticker.is_animated ? 'tgs' : 'webp');
    }

    if (!fileId) return null;

    const finalFilename = filename || 'file';
    return this.downloadTelegramFile(token, api, fileId).then((data) => [{
      filename: finalFilename,
      mimeType,
      data,
      filesize: data.length,
    }]);
  }

  private async downloadTelegramFile(token: string, api: Bot['api'], fileId: string): Promise<Buffer> {
    const file = await api.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram getFile returned no file_path');
    if (file.file_size && file.file_size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`File too large (${(file.file_size / 1_048_576).toFixed(1)}MB, limit ${MAX_ATTACHMENT_BYTES / 1_048_576}MB)`);
    }
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Collect rapid-fire messages from the same sender and flush as one
   * concatenated message after a silence window.
   */
  private debounceInbound(sender: string, senderName: string, agentAddress: string, text: string, channel?: string, attachments?: Attachment[]): void {
    const key = `${sender}:${agentAddress}`;
    const existing = this.pendingBursts.get(key);

    if (existing) {
      if (text) existing.texts.push(text);
      if (attachments?.length) existing.attachments.push(...attachments);
      existing.senderName = senderName; // use latest name
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flushBurst(key), DEBOUNCE_MS);
      return;
    }

    this.pendingBursts.set(key, {
      texts: text ? [text] : [],
      attachments: attachments ?? [],
      sender,
      senderName,
      agentAddress,
      channel,
      timer: setTimeout(() => this.flushBurst(key), DEBOUNCE_MS),
    });
  }

  private flushBurst(key: string): void {
    const burst = this.pendingBursts.get(key);
    if (!burst) return;
    this.pendingBursts.delete(key);

    const merged = burst.texts.join('\n');
    if (!merged && burst.attachments.length === 0) return;
    this.ctx.ingestInbound(
      burst.sender, burst.agentAddress, merged, burst.senderName,
      { channel: burst.channel },
      burst.attachments.length > 0 ? burst.attachments : undefined,
    );
  }

  /** Parse a participant address like "tg:12345" → chat ID number. */
  private parseChatId(participantAddress: string): number | undefined {
    const match = participantAddress.match(/^tg:(-?\d+)$/);
    if (!match) return undefined;
    return parseInt(match[1]!, 10); // regex guarantees group 1
  }

  async send(pkt: AnyPacket, ctx: OutboundContext): Promise<void> {
    if (!isDeliverablePacket(pkt)) return;

    const chatId = this.parseChatId(pkt.to);
    if (chatId === undefined) {
      this.ctx.log.warn({ to: pkt.to }, 'Cannot parse Telegram chat ID from participant address');
      return;
    }

    const botEntry = this.agentToEntry.get(ctx.agentAddress);
    if (!botEntry) {
      this.ctx.log.warn({ to: pkt.to, agentAddress: ctx.agentAddress }, 'No Telegram bot for agent');
      return;
    }
    const bot = botEntry.bot;

    // Preview text: edit-in-place bubble keyed by streamId. The host-side
    // gateway already coalesced to the latest text for this streamId before
    // calling us, so we only see "the current snapshot" per drain. PreviewPkt
    // currently has only `kind: 'text'`; future kinds (tool_call, progress)
    // will need separate arms here. When `streaming` is disabled on this
    // route's config, drop the frame at the gate — the seal will fresh-send
    // (no stream entry → sealStream returns false → caller chunks normally).
    if (pkt.type === 'preview') {
      if (!botEntry.streaming) return;
      await this.handlePreview(bot, chatId, pkt.streamId, pkt.text);
      return;
    }

    if (pkt.type === 'approval_request') {
      const text = `❓ *Approval needed*\n${pkt.summary}${pkt.details ? '\n' + pkt.details : ''}`;
      const keyboard = new InlineKeyboard()
        .text('✅ Approve', `apv:${ctx.agentAddress}:${pkt.approvalId}`)
        .text('❌ Reject', `rej:${ctx.agentAddress}:${pkt.approvalId}`);
      await bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
      return;
    }

    if (pkt.type === 'approval_ack') {
      const icon = pkt.decision === 'approved' ? '✅' : pkt.decision === 'rejected' ? '❌' : '⏰';
      const label = pkt.decision.charAt(0).toUpperCase() + pkt.decision.slice(1);
      await bot.api.sendMessage(chatId, `${icon} ${label}: ${pkt.summary}`);
      return;
    }

    if (pkt.text) {
      // Durable conversation packets carrying a streamId terminate an in-flight
      // preview. Edit the final text into the existing message + drop the entry
      // so attachments + subsequent messages flow normally.
      const sealed = pkt.type === 'conversation' && pkt.streamId
        ? await this.sealStream(bot, pkt.streamId, pkt.text)
        : false;
      if (!sealed) {
        const chunks = chunkText(pkt.text, TELEGRAM_MAX_LENGTH);
        for (const chunk of chunks) {
          await bot.api.sendMessage(chatId, chunk);
        }
      }
    }

    if (pkt.attachments?.length) {
      for (const att of pkt.attachments) {
        if (!att.hostPath) continue;
        const file = new InputFile(fs.createReadStream(att.hostPath), att.filename);
        if (att.mimeType.startsWith('image/') && att.mimeType !== 'image/gif') {
          await bot.api.sendPhoto(chatId, file);
        } else if (att.mimeType.startsWith('audio/')) {
          await bot.api.sendAudio(chatId, file);
        } else if (att.mimeType.startsWith('video/')) {
          await bot.api.sendVideo(chatId, file);
        } else {
          await bot.api.sendDocument(chatId, file);
        }
      }
    }
  }

  isConnected(): boolean {
    return this.tokenToBotEntry.size > 0;
  }

  ownsParticipant(participantAddress: string): boolean {
    return participantAddress.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    // Cancel any pending polling retries
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers = [];
    // Flush any pending debounced messages before stopping
    for (const [key, burst] of this.pendingBursts) {
      clearTimeout(burst.timer);
      this.flushBurst(key);
    }
    // Tombstone any in-flight preview streams. Their final bubble state on
    // the Telegram side is whatever was last edited in — acceptable as long
    // as the host sealed-packet path doesn't try to edit a dead chat after
    // disconnect (the `disposed` flag guards the await re-entry).
    for (const [, entry] of this.streams) {
      clearTimeout(entry.watchdog);
      entry.disposed = true;
    }
    this.streams.clear();
    for (const [, entry] of this.tokenToBotEntry) {
      entry.bot.stop();
    }
  }

  // ---------------------------------------------------------------------------
  // Preview streams — edit-in-place bubbles, mirrors §3.5b WebUI per-streamId model
  // ---------------------------------------------------------------------------

  private async handlePreview(bot: Bot, chatId: number, streamId: string, text: string): Promise<void> {
    // Empty text — nothing to render. Common at stream open before the first
    // textblock chunk arrives.
    if (!text) return;

    const existing = this.streams.get(streamId);
    if (!existing) {
      // First frame for this stream — create the bubble.
      const initialText = text.length > TELEGRAM_MAX_LENGTH ? text.slice(0, TELEGRAM_MAX_LENGTH) : text;
      try {
        const sent = await bot.api.sendMessage(chatId, initialText);
        // Race: another concurrent stream could have raced us on the same
        // streamId (rare; would imply a bus bug). Last-writer-wins.
        const entry: StreamEntry = {
          chatId,
          messageId: sent.message_id,
          lastText: initialText,
          watchdog: this.armWatchdog(streamId),
          disposed: false,
        };
        this.streams.set(streamId, entry);
      } catch (err) {
        this.ctx.log.warn({ chatId, streamId, err }, 'Telegram preview send failed');
      }
      return;
    }

    if (existing.disposed) return;

    // Subsequent frame — edit in place.
    const editText = text.length > TELEGRAM_MAX_LENGTH ? text.slice(0, TELEGRAM_MAX_LENGTH) : text;
    if (editText === existing.lastText) return; // dedup — Telegram errors on no-change edits

    try {
      await bot.api.editMessageText(existing.chatId, existing.messageId, editText);
      if (existing.disposed) return;
      existing.lastText = editText;
      this.refreshWatchdog(existing, streamId);
    } catch (err) {
      if (isNotModifiedError(err)) return; // defensive — dedup above usually catches it
      if (is429Error(err)) {
        // grammy auto-retries 429 internally where possible; for edits we just
        // skip this frame. The next coalesced tick will catch up.
        this.ctx.log.debug({ streamId, err }, 'Telegram edit rate-limited (will retry on next frame)');
        return;
      }
      // Persistent 4xx (message deleted by user, chat blocked, …): drop the
      // entry so the seal-path falls back to a fresh send rather than editing
      // a dead message.
      this.ctx.log.warn({ streamId, err }, 'Telegram preview edit failed; dropping stream');
      this.dropStream(streamId);
    }
  }

  /**
   * Edit the final text into an in-flight stream's message, then drop the
   * entry. Returns `true` if the seal was applied in-place (caller should
   * skip the chunked fresh-send path); `false` if no in-flight stream exists
   * OR the edit failed for a non-trivial reason (caller should fresh-send so
   * the user isn't left with a stale partial preview on screen).
   */
  private async sealStream(bot: Bot, streamId: string, text: string): Promise<boolean> {
    const entry = this.streams.get(streamId);
    if (!entry || entry.disposed) return false;

    // For overflow, settle the in-place bubble to chunk1 and fresh-send the
    // tail. Falling all the way back to the caller's chunked-send path would
    // re-render chunk1 in a fresh bubble alongside the already-streamed one,
    // duplicating the head of the reply.
    const chunks = text.length > TELEGRAM_MAX_LENGTH
      ? chunkText(text, TELEGRAM_MAX_LENGTH)
      : [text];
    const head = chunks[0]!; // chunkText invariant: ≥1 chunk; caller guards on pkt.text
    const tail = chunks.slice(1);

    try {
      if (head !== entry.lastText) {
        await bot.api.editMessageText(entry.chatId, entry.messageId, head);
      }
    } catch (err) {
      if (!isNotModifiedError(err)) {
        // Edit failed (message deleted, chat blocked, transient error). Drop
        // the entry and signal `false` so the caller fresh-sends the full
        // text rather than leaving the user with a stale partial.
        this.ctx.log.warn({ streamId, err }, 'Telegram seal edit failed; falling back to fresh send');
        this.dropStream(streamId);
        return false;
      }
      // not-modified — preview already shows chunk1; proceed to tail.
    }

    // Head settled. A failure on a tail chunk is logged but does NOT trigger
    // the caller's chunked fallback — chunk1 is already on screen and a full
    // replay would reintroduce the duplication this method exists to prevent.
    for (const chunk of tail) {
      try {
        await bot.api.sendMessage(entry.chatId, chunk);
      } catch (err) {
        this.ctx.log.warn({ streamId, err }, 'Telegram seal tail chunk send failed');
        break;
      }
    }

    this.dropStream(streamId);
    return true;
  }

  private armWatchdog(streamId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const entry = this.streams.get(streamId);
      if (!entry) return;
      this.ctx.log.debug({ streamId }, 'Telegram stream watchdog fired; dropping stale entry');
      this.dropStream(streamId);
    }, STREAM_WATCHDOG_MS);
  }

  private refreshWatchdog(entry: StreamEntry, streamId: string): void {
    clearTimeout(entry.watchdog);
    entry.watchdog = this.armWatchdog(streamId);
  }

  private dropStream(streamId: string): void {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    clearTimeout(entry.watchdog);
    entry.disposed = true;
    this.streams.delete(streamId);
  }

  async sendEvent(evt: Evt): Promise<void> {
    if (evt.type === 'lifecycle') {
      const text = renderLifecyclePhase(evt.data);
      if (text === undefined) return;

      const chatId = this.parseChatId(evt.to);
      if (chatId === undefined) return;
      const entry = this.agentToEntry.get(evt.from);
      if (!entry) return;
      if (!this.recentlyActive(entry.token, evt.to)) return;

      try {
        await entry.bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      } catch (err) {
        this.ctx.log.debug({ chatId, err }, 'Failed to send lifecycle message');
      }
      return;
    }

    if (evt.type !== 'typing') return;

    const chatId = this.parseChatId(evt.to);
    if (chatId === undefined) return;

    const entry = this.agentToEntry.get(evt.from);
    if (!entry) return;
    if (!this.recentlyActive(entry.token, evt.to)) return;

    try {
      await entry.bot.api.sendChatAction(chatId, 'typing');
    } catch (err) {
      this.ctx.log.debug({ chatId, err }, 'Failed to send Telegram typing indicator');
    }
  }

  private recentlyActive(token: string, participantAddress: string): boolean {
    const ts = this.lastUserMessageAt.get(`${token}:${participantAddress}`);
    return ts !== undefined && Date.now() - ts < RECENT_USER_ACTIVITY_WINDOW_MS;
  }
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

const TELEGRAM_SETUP = `
Telegram bot tokens are minted by **BotFather**, an in-app bot you DM:

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send \`/newbot\`.
3. Pick a display name (anything).
4. Pick a username ending in \`bot\` (e.g. \`my_assistant_bot\`).
5. BotFather replies with your token in the form \`123456:ABC-DEF…\`. Paste it below.

Privacy mode is on by default — bots in groups only see messages directed at them. Fine for DM-style use; no change needed.

Cast manages the BotFather command menu (\`/setcommands\`) automatically — no manual setup.
`.trim();

const MASK = '••••';
function maskTelegramToken(token: string): string {
  return token.length <= 8 ? MASK : MASK + token.slice(-4);
}

export const telegram = defineTransport<TelegramConfig>({
  name: 'telegram',
  addressPrefix: 'tg',
  configSchema: TelegramConfigSchema,
  admin: {
    displayLabel: 'Telegram',
    fields: [
      {
        key: 'token',
        type: 'password',
        label: 'Bot Token',
        placeholder: '123456:ABC-DEF...',
        secret: true,
      },
    ],
    summarize: (entry) => maskTelegramToken((entry as TelegramRoute).token),
    setupInstructions: TELEGRAM_SETUP,
  },
  create: (ctx, routes) => {
    const bindings: TelegramBinding[] = [];
    for (const r of routes) {
      const canonicalAddress = ctx.resolveAddress(r.address);
      if (!canonicalAddress) {
        ctx.log.warn({ address: r.address }, 'Telegram route references unregistered address — skipping');
        continue;
      }
      bindings.push({ token: r.token, address: canonicalAddress, channel: r.channel, streaming: r.streaming });
    }
    if (bindings.length === 0) return null;
    return new TelegramTransport(ctx, bindings);
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize Telegram structured message types (contact, location, venue, poll, dice)
 * into text + optional attachments. These types have no file_id so they bypass extractMedia().
 */
function serializeStructuredContent(msg: Message): { text: string; attachments: Attachment[] } {
  const parts: string[] = [];
  const attachments: Attachment[] = [];

  if (msg.contact) {
    const c = msg.contact;
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
    const lines = [`[Shared Contact: ${name}]`];
    if (c.phone_number) lines.push(`Phone: ${c.phone_number}`);
    parts.push(lines.join('\n'));

    if (c.vcard) {
      attachments.push({
        filename: `${name.replace(/\s+/g, '_') || 'contact'}.vcf`,
        mimeType: 'text/vcard',
        data: Buffer.from(c.vcard, 'utf-8'),
        filesize: Buffer.byteLength(c.vcard, 'utf-8'),
      });
    }
  }

  if (msg.location && !msg.venue) {
    const loc = msg.location;
    const line = `[Shared Location: ${loc.latitude}, ${loc.longitude}]`;
    parts.push(loc.live_period ? `${line} (live, ${loc.live_period}s)` : line);
  }

  if (msg.venue) {
    const v = msg.venue;
    const loc = v.location;
    const lines = [`[Shared Venue: "${v.title}"]`];
    if (v.address) lines.push(`Address: ${v.address}`);
    if (loc) lines.push(`Coordinates: ${loc.latitude}, ${loc.longitude}`);
    parts.push(lines.join('\n'));
  }

  if (msg.poll) {
    const p = msg.poll;
    const lines = [`[Poll: "${p.question}"]`];
    for (let i = 0; i < p.options.length; i++) {
      const opt = p.options[i];
      const count = opt.voter_count ? ` (${opt.voter_count} votes)` : '';
      lines.push(`${i + 1}. ${opt.text}${count}`);
    }
    if (p.is_closed) lines.push('(closed)');
    parts.push(lines.join('\n'));
  }

  if (msg.dice) {
    parts.push(`[Dice: ${msg.dice.emoji} rolled ${msg.dice.value}]`);
  }

  return { text: parts.join('\n'), attachments };
}

/**
 * Telegram returns 400 "Bad Request: message is not modified" when
 * editMessageText is called with content identical to what's already there.
 * We dedup before the call, but defend against it anyway — race conditions
 * with concurrent edits, or edge cases like Telegram-side whitespace
 * normalization, can land here.
 */
function isNotModifiedError(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  if (err.error_code !== 400) return false;
  return err.description.toLowerCase().includes('not modified');
}

/** 429 rate-limit response from Bot API. */
function is429Error(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 429;
}

function chunkText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let breakIdx = remaining.lastIndexOf('\n', maxLen);
    if (breakIdx <= 0) breakIdx = maxLen;
    chunks.push(remaining.slice(0, breakIdx));
    remaining = remaining.slice(breakIdx).replace(/^\n/, '');
  }
  return chunks;
}
