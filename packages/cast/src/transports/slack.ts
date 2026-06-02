/**
 * Slack DM transport — Slack direct messages as a synchronous routed transport.
 *
 * Scope: DM-only. Channel participation, @mentions, and slash commands are
 * out of scope and would be handled by a separate "Slack-as-extension" effort.
 *
 * One Bolt App per route entry (one Slack app installation per Cast agent).
 * Each App opens its own Socket Mode WebSocket — no public HTTPS required.
 *
 * Address format: `slack:T{teamId}:U{userId}`. Workspace prefix forward-compats
 * for multi-workspace future; the U-prefixed userId is the canonical Slack
 * user ID and what the API expects.
 *
 * Inbound flow:
 *   Slack DM → Bolt `message` event → filter (DM only, drop self/bot/edits)
 *   → optional team/user allowlist gate → debounced burst → ctx.ingestInbound
 *
 * Outbound flow (mirrors telegram.ts:301-354):
 *   AnyPacket → resolve userId from address → conversations.open (cached)
 *   → chat.postMessage with `mrkdwn: false` for prose, Block Kit for approvals.
 *   `mrkdwn: false` matches Telegram's UX (raw markdown source rendered as
 *   literal text). Converting agent markdown → Slack mrkdwn is not implemented.
 *
 * Approval flow (mirrors telegram.ts:130-146 callback_query pattern):
 *   ApprovalRequestPkt → Block Kit `actions` block with two buttons
 *   (action_ids `cast_approve` / `cast_reject`) carrying `{agent}:{approvalId}`
 *   in `value` → user clicks → action handler → ctx.ingestApprovalResponse
 *   → chat.update edits the original message to ✅/❌.
 */
import fs from 'fs';

import { App, LogLevel } from '@slack/bolt';
import type { AllMiddlewareArgs, BlockAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { z } from 'zod';

/** SlackClient type via Bolt's `App.client` — avoids importing @slack/web-api directly (transitive dep). */
type SlackClient = App['client'];

import type { BusAddress } from '../auth/address.js';
import { MAX_ATTACHMENT_BYTES } from '../config.js';
import type { AnyPacket, Attachment, Evt } from '../types.js';
import { renderLifecyclePhase } from '../conversations/lifecycle-render.js';
import { isDeliverablePacket } from './packet-dispatch.js';

import { defineTransport } from './schema.js';
import type { OutboundContext, Transport, TransportContext } from './schema.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const SlackRouteSchema = z.object({
  /** xoxb-… bot token from the Slack app's "OAuth & Permissions" page. */
  botToken: z.string().regex(/^xoxb-/, 'botToken must start with "xoxb-"'),
  /** xapp-… app-level token with `connections:write` — required for Socket Mode. */
  appToken: z.string().regex(/^xapp-/, 'appToken must start with "xapp-"'),
  /** Canonical agent address from addresses.json. */
  address: z.string(),
  /** Optional channel preset (mirrors telegram/email). */
  channel: z.string().optional(),
  /** Workspace allowlist — restrict ingestion to these team IDs. Empty/omitted = no filter (gateway ACL is the gate). */
  allowedTeamIds: z.array(z.string()).optional(),
  /** Per-user allowlist — restrict ingestion to these user IDs. Empty/omitted = no filter. */
  allowedUserIds: z.array(z.string()).optional(),
  /** Optional override of the bot's own user ID (for self-message filtering). When omitted, discovered via auth.test() at connect(). */
  botUserId: z.string().optional(),
  /** When false, drop preview frames at the transport gate — the bubble
   *  never opens and the durable seal fresh-sends instead of editing. Default
   *  true (live streaming). No admin-form field yet; hand-edit routes.json
   *  to flip. Mirrors `TelegramRouteSchema.streaming`. */
  streaming: z.boolean().default(true),
});
export type SlackRoute = z.infer<typeof SlackRouteSchema>;

const SlackConfigSchema = z.array(SlackRouteSchema).default([]);
type SlackConfig = z.infer<typeof SlackConfigSchema>;

// ---------------------------------------------------------------------------
// Bolt SDK projection schemas — minimal `.passthrough()` projections of the
// Bolt event/API shapes we actually read. We don't model Bolt's full union
// variants; we just declare the fields we depend on. New fields from Bolt
// flow through unchanged.
// ---------------------------------------------------------------------------

const SlackFileSchema = z.object({
  name: z.string().optional(),
  size: z.number().optional(),
  mimetype: z.string().optional(),
  url_private: z.string().optional(),
  url_private_download: z.string().optional(),
}).passthrough();
type SlackFile = z.infer<typeof SlackFileSchema>;

const SlackInboundDmSchema = z.object({
  channel_type: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  team: z.string().optional(),
  text: z.string().optional(),
  files: z.array(SlackFileSchema).optional(),
}).passthrough();

/** Payload portion of `app.action` middleware args — `args.body` shape we read. */
const SlackActionBodySchema = z.object({
  user: z.object({
    id: z.string().optional(),
    team_id: z.string().optional(),
  }).passthrough().optional(),
  team: z.object({ id: z.string().optional() }).passthrough().optional(),
  channel: z.object({ id: z.string().optional() }).passthrough().optional(),
  message: z.object({ ts: z.string().optional() }).passthrough().optional(),
}).passthrough();

const SlackActionElementSchema = z.object({
  value: z.string().optional(),
}).passthrough();

const SlackUserInfoResponseSchema = z.object({
  user: z.object({
    name: z.string().optional(),
    real_name: z.string().optional(),
    profile: z.object({
      real_name: z.string().optional(),
      display_name: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const SlackChannelOpenResponseSchema = z.object({
  channel: z.object({ id: z.string().optional() }).passthrough().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SlackBinding {
  botToken: string;
  appToken: string;
  address: BusAddress;
  channel?: string;
  allowedTeamIds?: string[];
  allowedUserIds?: string[];
  botUserId?: string;
  streaming: boolean;
}

interface SlackAppEntry {
  app: App;
  client: SlackClient;
  agentAddress: string;
  botToken: string;
  channel?: string;
  /** Discovered at connect() via auth.test (or empty if discovery failed). */
  teamId: string;
  /** Discovered at connect() via auth.test, or pre-set from config. */
  botUserId: string;
  allowedTeamIds?: Set<string>;
  allowedUserIds?: Set<string>;
  /** userId → DM channel id. DM channels are immortal per (bot, user) pair, so no eviction. */
  dmChannelCache: Map<string, string>;
  /** Mirrors `SlackRouteSchema.streaming`. False suppresses preview
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

/**
 * In-flight preview stream — one bubble being edited in place via `chat.update`.
 * Keyed by `streamId` in `SlackTransport.streams`. The matching durable
 * `conversation` packet carries the same `streamId` and triggers `sealStream`,
 * which edits the final text into the existing message + drops the entry.
 * Mirrors the Telegram model (`telegram.ts:75-86`) — Slack is simpler because
 * `chat.update` no-ops on identical text instead of erroring.
 */
interface StreamEntry {
  channelId: string;
  /** Slack message id — the `ts` returned by `chat.postMessage`. */
  ts: string;
  /** Last text we sent — dedup gate, avoids burning a rate-limit slot on no-op edits. */
  lastText: string;
  /** 60s GC timer. Refreshed on every successful edit. */
  watchdog: ReturnType<typeof setTimeout>;
  /** Tombstone for async races: an edit may resolve after disconnect drops the
   *  entry. Code paths that await must re-check this before mutating state. */
  disposed: boolean;
}

const INBOUND_DEBOUNCE_MS = 800;
/** Slack's chat.postMessage hard limit is ~40k chars; Block Kit section text caps at 3000. We use the plain `text:` field, chunked at 3500 to stay safely under either. */
const SLACK_MAX_TEXT_CHARS = 3500;
/** Preview/seal edits go through `chat.update` with the plain `text:` field,
 *  whose API limit is ~40,000 chars. We cap at 39,000 for headroom (matches
 *  Hermes' `MAX_MESSAGE_LENGTH`). Higher than `SLACK_MAX_TEXT_CHARS` because
 *  we want the streamed bubble to render as one block; the post-chunking
 *  fallback at 3500 only kicks in when the seal can't fit even at 39k. */
const SLACK_STREAM_MAX_LENGTH = 39_000;
/** Stale-stream GC — see telegram.ts:22-28 for the rationale (producer leaks
 *  past container kill / participant disconnect). */
const STREAM_WATCHDOG_MS = 60_000;
const RECONNECT_DELAY_MS = 5_000;
// Lifecycle messages are suppressed unless the user has interacted in this
// DM recently. Without this, scheduled-task fires would post permanent
// "Waking up…" debris above an unprompted reply.
const RECENT_USER_ACTIVITY_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Transport class
// ---------------------------------------------------------------------------

class SlackTransport implements Transport {
  name = 'slack';

  private agentToEntry = new Map<string, SlackAppEntry>();
  private pendingBursts = new Map<string, PendingBurst>();
  /** userId → cached display name. No eviction (workspace user count bounded). */
  private userInfoCache = new Map<string, string>();
  private lastUserMessageAt = new Map<string, number>();
  private retryTimers: ReturnType<typeof setTimeout>[] = [];
  /** In-flight preview streams keyed by streamId. See StreamEntry. */
  private streams = new Map<string, StreamEntry>();
  private connected = false;

  constructor(private ctx: TransportContext, bindings: SlackBinding[]) {
    for (const b of bindings) {
      const app = new App({
        token: b.botToken,
        appToken: b.appToken,
        socketMode: true,
        logLevel: LogLevel.WARN,
      });
      this.agentToEntry.set(b.address, {
        app,
        client: app.client,
        agentAddress: b.address,
        botToken: b.botToken,
        channel: b.channel,
        teamId: '',
        botUserId: b.botUserId ?? '',
        allowedTeamIds: b.allowedTeamIds ? new Set(b.allowedTeamIds) : undefined,
        allowedUserIds: b.allowedUserIds ? new Set(b.allowedUserIds) : undefined,
        dmChannelCache: new Map(),
        streaming: b.streaming,
      });
    }
  }

  async connect(): Promise<void> {
    for (const entry of this.agentToEntry.values()) {
      // Don't await — startEntry handles its own retry on failure, just like
      // telegram.ts:107-122. connect() resolves immediately so a transient
      // Slack outage at startup doesn't keep the whole transport offline.
      this.startEntry(entry).catch(() => { /* logged inside */ });
    }
    this.connected = true;
  }

  /** Start one Bolt app: discover identity, wire handlers, open Socket Mode. Retries on failure. */
  private async startEntry(entry: SlackAppEntry): Promise<void> {
    try {
      const auth = await entry.client.auth.test();
      entry.teamId = (auth.team_id as string | undefined) ?? '';
      if (!entry.botUserId) entry.botUserId = (auth.user_id as string | undefined) ?? '';

      this.setupApp(entry);
      await entry.app.start();
      this.ctx.log.info(
        { agentAddress: entry.agentAddress, teamId: entry.teamId, botUserId: entry.botUserId },
        'Slack transport connected',
      );
    } catch (err) {
      this.ctx.log.warn(
        { agentAddress: entry.agentAddress, err },
        'Slack app start failed — retrying in 5s',
      );
      const timer = setTimeout(() => {
        this.retryTimers = this.retryTimers.filter((t) => t !== timer);
        this.startEntry(entry).catch(() => { /* logged inside */ });
      }, RECONNECT_DELAY_MS);
      this.retryTimers.push(timer);
    }
  }

  private setupApp(entry: SlackAppEntry): void {
    const { app } = entry;

    app.error(async (err) => {
      this.ctx.log.error({ agentAddress: entry.agentAddress, err }, 'Slack app error (non-fatal)');
    });

    // ---- Inbound DM messages ----
    app.message(async ({ message }) => {
      // Bolt's `message` is a deep discriminated union (~12 subtype variants).
      // Validate via SlackInboundDmSchema rather than re-derive Bolt's union;
      // unknown fields pass through, missing fields fail filters cleanly.
      const parsed = SlackInboundDmSchema.safeParse(message);
      if (!parsed.success) {
        this.ctx.log.warn({ agentAddress: entry.agentAddress, issues: parsed.error.issues }, 'Slack inbound DM failed schema parse');
        return;
      }
      const m = parsed.data;

      // Filter 1: DMs only.
      if (m.channel_type !== 'im') return;
      // Filter 2: drop self / bot messages.
      const userId = m.user;
      if (!userId || userId === entry.botUserId) return;
      if (m.bot_id) return;
      // Filter 3: drop edits/deletes; accept bare messages and file_share.
      if (m.subtype && m.subtype !== 'file_share') return;
      // Filter 4: optional allowlist gates (gateway ACL is the real gate).
      const teamId = m.team ?? entry.teamId;
      if (entry.allowedTeamIds && !entry.allowedTeamIds.has(teamId)) return;
      if (entry.allowedUserIds && !entry.allowedUserIds.has(userId)) return;

      // Slack team IDs already start with "T" and user IDs with "U" — don't double-prefix.
      const sender = `slack:${teamId}:${userId}`;
      // Record user activity for the lifecycle recency gate.
      this.lastUserMessageAt.set(`${entry.botToken}:${sender}`, Date.now());
      const text = m.text ?? '';
      const files = m.files;

      // Resolve sender name (cached) and download files (size-gated) in parallel.
      // Fire-and-forget — flushBurst waits for both via Promise.all.
      Promise.all([
        this.resolveSenderName(entry, userId),
        files?.length ? this.downloadSlackFiles(entry.botToken, files) : Promise.resolve([] as Attachment[]),
      ])
        .then(([senderName, attachments]) => {
          if (!text && attachments.length === 0) return;
          this.debounceInbound(sender, senderName, entry.agentAddress, text, entry.channel, attachments);
        })
        .catch((err) => {
          this.ctx.log.warn({ agentAddress: entry.agentAddress, err }, 'Slack inbound processing failed');
          if (text) this.debounceInbound(sender, userId, entry.agentAddress, text, entry.channel, []);
        });
    });

    // ---- Approval buttons ----
    // Two action_ids dispatched on the same handler shape — mirrors the
    // single callback_query handler in telegram.ts:130-146. We keep Bolt's
    // middleware-args type for `args.ack()` and `args.client.*`; payload
    // fields go through Zod projection so we don't depend on the deep
    // union shape Bolt declares for `BlockAction`.
    const handleAction = (decision: 'approved' | 'rejected') =>
      async (args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs): Promise<void> => {
        await args.ack();

        const actionEl = SlackActionElementSchema.safeParse(args.action);
        const body = SlackActionBodySchema.safeParse(args.body);
        if (!actionEl.success || !body.success) {
          this.ctx.log.warn({ agentAddress: entry.agentAddress }, 'Slack action payload failed schema parse');
          return;
        }
        const value = actionEl.data.value ?? '';
        const sep = value.lastIndexOf(':');
        if (sep < 0) return;
        const agentAddress = value.slice(0, sep);
        const approvalId = value.slice(sep + 1);

        const userId = body.data.user?.id;
        if (!userId) return;
        const teamId = body.data.team?.id ?? body.data.user?.team_id ?? entry.teamId;
        // Slack team IDs already start with "T" and user IDs with "U" — don't double-prefix.
        const sender = `slack:${teamId}:${userId}`;

        this.ctx.ingestApprovalResponse(sender, agentAddress, { id: approvalId, decision });

        const label = decision === 'approved' ? '✅ Approved' : '❌ Rejected';
        const channelId = body.data.channel?.id;
        const messageTs = body.data.message?.ts;
        if (channelId && messageTs) {
          try {
            await args.client.chat.update({
              channel: channelId,
              ts: messageTs,
              text: `${label} (${approvalId})`,
              blocks: [],
            });
          } catch { /* message may be too old to edit */ }
        }
      };

    app.action('cast_approve', handleAction('approved'));
    app.action('cast_reject', handleAction('rejected'));
  }

  /** Lazily fetch and cache a Slack user's display name. Falls back to userId on failure. */
  private async resolveSenderName(entry: SlackAppEntry, userId: string): Promise<string> {
    const cached = this.userInfoCache.get(userId);
    if (cached) return cached;
    try {
      const res = await entry.client.users.info({ user: userId });
      const parsed = SlackUserInfoResponseSchema.safeParse(res);
      const user = parsed.success ? parsed.data.user : undefined;
      const profile = user?.profile;
      const name =
        profile?.real_name
        || profile?.display_name
        || user?.real_name
        || user?.name
        || userId;
      this.userInfoCache.set(userId, name);
      return name;
    } catch (err) {
      this.ctx.log.debug({ userId, err }, 'users.info failed — falling back to userId');
      return userId;
    }
  }

  /** Download Slack file_share files. Size-gated against MAX_ATTACHMENT_BYTES BEFORE the HTTP fetch. */
  private async downloadSlackFiles(botToken: string, files: SlackFile[]): Promise<Attachment[]> {
    const out: Attachment[] = [];
    for (const f of files) {
      if (f.size && f.size > MAX_ATTACHMENT_BYTES) {
        this.ctx.log.warn(
          { filename: f.name, size: f.size, limit: MAX_ATTACHMENT_BYTES },
          'Skipping oversized Slack file',
        );
        continue;
      }
      const url = f.url_private_download ?? f.url_private;
      if (!url) continue;
      const declaredMime = f.mimetype ?? 'application/octet-stream';
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
        if (!res.ok) {
          this.ctx.log.warn({ filename: f.name, status: res.status }, 'Slack file download failed');
          continue;
        }
        // Slack returns HTTP 200 with an HTML login page (not 401/403) when the
        // bot lacks `files:read` scope. Detect by Content-Type mismatch — if we
        // asked for image/png and got text/html, the bytes are not the file.
        const responseMime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
        if (declaredMime && responseMime && !mimeTypesCompatible(declaredMime, responseMime)) {
          this.ctx.log.error(
            { filename: f.name, declaredMime, responseMime, hint: 'Bot likely missing files:read scope. Add it in OAuth & Permissions and reinstall.' },
            'Slack file download returned unexpected Content-Type — bytes discarded',
          );
          continue;
        }
        const data = Buffer.from(await res.arrayBuffer());
        out.push({
          filename: f.name ?? 'file',
          mimeType: declaredMime,
          data,
          filesize: data.length,
        });
      } catch (err) {
        this.ctx.log.warn({ filename: f.name, err }, 'Slack file fetch threw');
      }
    }
    return out;
  }

  private debounceInbound(
    sender: string,
    senderName: string,
    agentAddress: string,
    text: string,
    channel: string | undefined,
    attachments: Attachment[],
  ): void {
    const key = `${sender}|${agentAddress}|${channel ?? ''}`;
    const existing = this.pendingBursts.get(key);
    if (existing) {
      if (text) existing.texts.push(text);
      existing.attachments.push(...attachments);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flushBurst(key), INBOUND_DEBOUNCE_MS);
    } else {
      this.pendingBursts.set(key, {
        texts: text ? [text] : [],
        attachments: [...attachments],
        sender,
        senderName,
        agentAddress,
        channel,
        timer: setTimeout(() => this.flushBurst(key), INBOUND_DEBOUNCE_MS),
      });
    }
  }

  private flushBurst(key: string): void {
    const burst = this.pendingBursts.get(key);
    if (!burst) return;
    this.pendingBursts.delete(key);
    const merged = burst.texts.join('\n');
    if (!merged && burst.attachments.length === 0) return;
    this.ctx.ingestInbound(
      burst.sender,
      burst.agentAddress,
      merged,
      burst.senderName,
      { channel: burst.channel },
      burst.attachments.length > 0 ? burst.attachments : undefined,
    );
  }

  /** Parse "slack:T{teamId}:U{userId}" → "U{userId}" (the form Slack APIs expect).
   *  Slack's natural team IDs start with "T" and user IDs with "U" — both are
   *  carried through the address as-is, no double-prefixing. */
  private parseUserAddress(participantAddress: string): string | undefined {
    const match = participantAddress.match(/^slack:T[A-Za-z0-9]+:(U[A-Za-z0-9]+)$/);
    if (!match) return undefined;
    return match[1];
  }

  /** Open (or get cached) DM channel id for a user. DM channels are immortal per (bot, user). */
  private async openDmChannel(entry: SlackAppEntry, userId: string): Promise<string | undefined> {
    const cached = entry.dmChannelCache.get(userId);
    if (cached) return cached;
    try {
      const res = await entry.client.conversations.open({ users: userId });
      const parsed = SlackChannelOpenResponseSchema.safeParse(res);
      const channelId = parsed.success ? parsed.data.channel?.id : undefined;
      if (channelId) entry.dmChannelCache.set(userId, channelId);
      return channelId;
    } catch (err) {
      this.ctx.log.warn({ userId, err }, 'conversations.open failed');
      return undefined;
    }
  }

  ownsParticipant(participantAddress: string): boolean {
    return participantAddress.startsWith('slack:');
  }

  isConnected(): boolean {
    return this.connected && this.agentToEntry.size > 0;
  }

  async send(pkt: AnyPacket, ctx: OutboundContext): Promise<void> {
    if (!isDeliverablePacket(pkt)) return;

    const userId = this.parseUserAddress(pkt.to);
    if (!userId) {
      this.ctx.log.warn({ to: pkt.to }, 'Cannot parse Slack user ID from participant address');
      return;
    }
    const entry = this.agentToEntry.get(ctx.agentAddress);
    if (!entry) {
      this.ctx.log.warn({ to: pkt.to, agentAddress: ctx.agentAddress }, 'No Slack app for agent');
      return;
    }

    const channelId = await this.openDmChannel(entry, userId);
    if (!channelId) return;

    // Preview text: edit-in-place bubble keyed by streamId. The host-side
    // gateway already coalesced to the latest text for this streamId before
    // calling us, so we only see "the current snapshot" per drain. When
    // `streaming` is disabled on this route's config, drop the frame at the
    // gate — the seal will fresh-send (no stream entry → sealStream returns
    // false → caller chunks normally).
    if (pkt.type === 'preview') {
      if (!entry.streaming) return;
      await this.handlePreview(entry.client, channelId, pkt.streamId, pkt.text);
      return;
    }

    if (pkt.type === 'approval_request') {
      const headline = `*Approval needed*\n${pkt.summary}${pkt.details ? `\n${pkt.details}` : ''}`;
      await entry.client.chat.postMessage({
        channel: channelId,
        text: `Approval needed: ${pkt.summary}`, // notification fallback
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: headline } },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                action_id: 'cast_approve',
                text: { type: 'plain_text', text: '✅ Approve' },
                value: `${ctx.agentAddress}:${pkt.approvalId}`,
              },
              {
                type: 'button',
                action_id: 'cast_reject',
                style: 'danger',
                text: { type: 'plain_text', text: '❌ Reject' },
                value: `${ctx.agentAddress}:${pkt.approvalId}`,
              },
            ],
          },
        ],
      });
      return;
    }

    if (pkt.type === 'approval_ack') {
      const icon = pkt.decision === 'approved' ? '✅' : pkt.decision === 'rejected' ? '❌' : '⏰';
      const label = pkt.decision[0]!.toUpperCase() + pkt.decision.slice(1);
      await entry.client.chat.postMessage({
        channel: channelId,
        text: `${icon} ${label}: ${pkt.summary}`,
        mrkdwn: false,
      });
      return;
    }

    // ConversationPkt
    if (pkt.text) {
      // Durable conversation packets carrying a streamId terminate an in-flight
      // preview. Edit the final text into the existing bubble + drop the entry
      // so attachments and subsequent messages flow normally.
      const sealed = pkt.type === 'conversation' && pkt.streamId
        ? await this.sealStream(entry.client, pkt.streamId, pkt.text)
        : false;
      if (!sealed) {
        for (const chunk of chunkText(pkt.text, SLACK_MAX_TEXT_CHARS)) {
          await entry.client.chat.postMessage({
            channel: channelId,
            text: chunk,
            mrkdwn: false,
          });
        }
      }
    }

    if (pkt.attachments?.length) {
      for (const att of pkt.attachments) {
        if (!att.hostPath) continue;
        try {
          await entry.client.files.uploadV2({
            channel_id: channelId,
            file: fs.createReadStream(att.hostPath),
            filename: att.filename,
          });
        } catch (err) {
          this.ctx.log.warn({ filename: att.filename, err }, 'Slack file upload failed');
        }
      }
    }
  }

  async sendEvent(evt: Evt): Promise<void> {
    // Slack DMs have no native "bot is typing" indicator, so `typing` events
    // are dropped. Lifecycle phases surface as italic mrkdwn messages, gated
    // by recent user activity to avoid permanent debris in DM history when
    // the user isn't watching (e.g. scheduled-task fires).
    if (evt.type !== 'lifecycle') return;
    const text = renderLifecyclePhase(evt.data);
    if (text === undefined) return;

    const userId = this.parseUserAddress(evt.to);
    if (!userId) return;
    const entry = this.agentToEntry.get(evt.from);
    if (!entry) return;
    if (!this.recentlyActive(entry.botToken, evt.to)) return;

    const channelId = await this.openDmChannel(entry, userId);
    if (!channelId) return;

    try {
      await entry.client.chat.postMessage({ channel: channelId, text });
    } catch (err) {
      this.ctx.log.debug({ userId, err }, 'Failed to send Slack lifecycle message');
    }
  }

  private recentlyActive(botToken: string, participantAddress: string): boolean {
    const ts = this.lastUserMessageAt.get(`${botToken}:${participantAddress}`);
    return ts !== undefined && Date.now() - ts < RECENT_USER_ACTIVITY_WINDOW_MS;
  }

  // ---------------------------------------------------------------------------
  // Preview streams — edit-in-place bubbles via chat.update.
  // Mirrors the Telegram model (telegram.ts:449-573); Slack's edit API has no
  // "not modified" error class and accepts up to ~40k chars in a single edit,
  // so this path is structurally simpler.
  // ---------------------------------------------------------------------------

  private async handlePreview(
    client: SlackClient,
    channelId: string,
    streamId: string,
    text: string,
  ): Promise<void> {
    // Empty text — nothing to render. Common at stream open before the first
    // textblock chunk arrives.
    if (!text) return;

    const existing = this.streams.get(streamId);
    if (!existing) {
      // First frame for this stream — create the bubble.
      const initialText = text.length > SLACK_STREAM_MAX_LENGTH ? text.slice(0, SLACK_STREAM_MAX_LENGTH) : text;
      try {
        const sent = await client.chat.postMessage({
          channel: channelId,
          text: initialText,
          mrkdwn: false,
        });
        const ts = sent.ts;
        if (!ts) {
          this.ctx.log.warn({ channelId, streamId }, 'Slack preview send returned no ts');
          return;
        }
        const stream: StreamEntry = {
          channelId,
          ts,
          lastText: initialText,
          watchdog: this.armWatchdog(streamId),
          disposed: false,
        };
        this.streams.set(streamId, stream);
      } catch (err) {
        this.ctx.log.warn({ channelId, streamId, err }, 'Slack preview send failed');
      }
      return;
    }

    if (existing.disposed) return;

    // Subsequent frame — edit in place.
    const editText = text.length > SLACK_STREAM_MAX_LENGTH ? text.slice(0, SLACK_STREAM_MAX_LENGTH) : text;
    if (editText === existing.lastText) return; // dedup — avoids burning a rate-limit slot

    try {
      await client.chat.update({
        channel: existing.channelId,
        ts: existing.ts,
        text: editText,
      });
      if (existing.disposed) return;
      existing.lastText = editText;
      this.refreshWatchdog(existing, streamId);
    } catch (err) {
      if (isSlackRateLimitError(err)) {
        // The next coalesced tick will catch up. We could lift Hermes-style
        // adaptive backoff (double the edit interval per strike) if dogfood
        // surfaces sustained throttling on a single stream.
        this.ctx.log.debug({ streamId, err }, 'Slack edit rate-limited (will retry on next frame)');
        return;
      }
      // Persistent error (message deleted by user, channel archived, …): drop
      // the entry so the seal-path falls back to a fresh send rather than
      // editing a dead message.
      this.ctx.log.warn({ streamId, err }, 'Slack preview edit failed; dropping stream');
      this.dropStream(streamId);
    }
  }

  /**
   * Edit the final text into an in-flight stream's bubble, then drop the entry.
   * Returns `true` if the seal was applied in-place (caller skips the chunked
   * fresh-send path); `false` if no in-flight stream exists OR the edit failed
   * (caller fresh-sends so the user isn't left with a stale partial preview).
   */
  private async sealStream(client: SlackClient, streamId: string, text: string): Promise<boolean> {
    const entry = this.streams.get(streamId);
    if (!entry || entry.disposed) return false;

    // If the final text exceeds what fits in a single chat.update, drop the
    // bubble and let the caller's chunked fresh-send handle it. Consistent
    // with Telegram's overflow behavior (telegram.ts:526-528).
    if (text.length > SLACK_STREAM_MAX_LENGTH) {
      this.dropStream(streamId);
      return false;
    }

    try {
      if (text !== entry.lastText) {
        await client.chat.update({
          channel: entry.channelId,
          ts: entry.ts,
          text,
        });
      }
      this.dropStream(streamId);
      return true;
    } catch (err) {
      // Edit failed (message deleted, channel archived, transient error). Drop
      // the entry and signal `false` so the caller fresh-sends the full text
      // rather than leaving the user with a stale partial.
      this.ctx.log.warn({ streamId, err }, 'Slack seal edit failed; falling back to fresh send');
      this.dropStream(streamId);
      return false;
    }
  }

  private armWatchdog(streamId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const entry = this.streams.get(streamId);
      if (!entry) return;
      this.ctx.log.debug({ streamId }, 'Slack stream watchdog fired; dropping stale entry');
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

  async disconnect(): Promise<void> {
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers = [];
    // Tombstone any in-flight preview streams. Their final bubble state on
    // the Slack side is whatever was last edited in — acceptable as long
    // as the host sealed-packet path doesn't try to edit a dead channel
    // after disconnect (the `disposed` flag guards the await re-entry).
    for (const entry of this.streams.values()) {
      clearTimeout(entry.watchdog);
      entry.disposed = true;
    }
    this.streams.clear();
    // Flush in-flight bursts so we don't drop user input mid-shutdown.
    for (const burst of this.pendingBursts.values()) {
      clearTimeout(burst.timer);
      const merged = burst.texts.join('\n');
      if (merged || burst.attachments.length > 0) {
        this.ctx.ingestInbound(
          burst.sender,
          burst.agentAddress,
          merged,
          burst.senderName,
          { channel: burst.channel },
          burst.attachments.length > 0 ? burst.attachments : undefined,
        );
      }
    }
    this.pendingBursts.clear();
    for (const entry of this.agentToEntry.values()) {
      try { await entry.app.stop(); } catch (err) {
        this.ctx.log.warn({ agentAddress: entry.agentAddress, err }, 'Slack app stop threw');
      }
    }
    this.connected = false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Loose Content-Type compatibility check for the Slack file-download path.
 *
 * Slack returns HTTP 200 with a `text/html` login page when the bot lacks
 * `files:read` scope (instead of an HTTP 401/403). We need to catch that case
 * by comparing the response Content-Type against the file's declared mimetype
 * from the message event.
 *
 * Compatible if: top-level types match (both `image/*`, both `application/*`,
 * etc.), or if the response is the generic `application/octet-stream` (servers
 * sometimes serve binary files this way regardless of declared type).
 */
function mimeTypesCompatible(declared: string, response: string): boolean {
  if (response === 'application/octet-stream') return true;
  const declaredTop = declared.split('/')[0];
  const responseTop = response.split('/')[0];
  return declaredTop === responseTop;
}

/**
 * Slack rate-limit detection. Bolt forwards `@slack/web-api` errors unchanged,
 * but we deliberately don't import @slack/web-api here (transitive dep — see
 * the `SlackClient` typedef at the top). Duck-type instead: the SDK's
 * `WebAPIRateLimitedError` carries `code === 'slack_webapi_rate_limited_error'`,
 * and inline 429 responses surface as `data.error === 'ratelimited'`.
 */
function isSlackRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; data?: { error?: string } };
  return e.code === 'slack_webapi_rate_limited_error' || e.data?.error === 'ratelimited';
}

/** Chunk at newline boundaries when possible (mirrors telegram.ts:509-523). */
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

// ---------------------------------------------------------------------------
// defineTransport export
// ---------------------------------------------------------------------------

const SLACK_SETUP = `
Cast connects as a Slack app via Socket Mode (no public HTTPS endpoint required). You'll need two tokens — a workspace bot token (\`xoxb-…\`) and an app-level token (\`xapp-…\`) — both minted at [api.slack.com/apps](https://api.slack.com/apps).

There are two paths: paste a manifest (one shot) or click through each setting manually. The manifest is faster when offered, but the modal that exposes it isn't always visible — if you only see "Create New App" with a name field, use the manual path.

### Path A — From a manifest

At [api.slack.com/apps?new_app=1](https://api.slack.com/apps?new_app=1), in the **Create New App** modal, choose **From a manifest**, select your workspace, and paste:

\`\`\`yaml
display_information:
  name: Cast
  description: Personal AI assistant
features:
  bot_user:
    display_name: Cast
    always_online: true
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:history
      - im:read
      - im:write
      - users:read
      - files:read
      - files:write
settings:
  event_subscriptions:
    bot_events:
      - message.im
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
  token_rotation_enabled: false
\`\`\`

The \`messages_tab_read_only_enabled: false\` line is critical — without it the bot's DM input is disabled ("Sending messages to this app has been turned off").

After creating the app, jump to **Step 6** below.

### Path B — Manual setup

**Order matters.** Steps 1–2 (app-level token then Socket Mode) must come before steps 4–5. Otherwise Slack will demand a public HTTPS Request URL for events and interactivity, which Cast does not provide.

1. **Settings → Basic Information → App-Level Tokens → Generate Token** — add scope \`connections:write\`. Save the \`xapp-…\` token.
2. **Settings → Socket Mode** — toggle on. *(Required before steps 4–5 — events and interactivity flow over this WebSocket instead of an HTTPS endpoint.)*
3. **Features → OAuth & Permissions → Bot Token Scopes** — add \`chat:write\`, \`im:history\`, \`im:read\`, \`im:write\`, \`users:read\`, \`files:read\`, \`files:write\`. *(Without \`files:read\`, image attachments fail silently — Slack returns an HTML login page instead of the file bytes.)*
4. **Features → Event Subscriptions** — enable, then under *Subscribe to bot events* add \`message.im\`. Save. *(Request URL field should be hidden or marked "not required" — that confirms Socket Mode is on.)*
5. **Features → Interactivity & Shortcuts** — toggle on. Save. *(Same: no Request URL because Socket Mode handles it.)*
6. **Features → App Home** — set an App Display Name if empty. **Then under *Show Tabs*, enable the Messages Tab AND check "Allow users to send Slash commands and messages from the messages tab".** Without this checkbox, the bot's DM input is disabled.
7. **Settings → Install App → Install to Workspace** — approve. Save the \`xoxb-…\` Bot User OAuth Token from the OAuth & Permissions page.

### Notes

Keep **token rotation off** — Cast does not implement Slack's refresh-token dance. If you see a "Refresh Token" alongside the bot token, rotation is on; toggle it off (OAuth & Permissions → bottom of page → Token Rotation) and reinstall.

Cast subscribes only to \`message.im\` — the bot ignores @mentions in channels and shared spaces. The Slack transport is DM-only.

To run multiple Cast agents from one Slack workspace, create one Slack app per agent (each gets its own bot identity and token pair) and add one route entry per app, each pointing to its own agent address.
`.trim();

const SLACK_MASK = '••••';
function maskSlackToken(token: string): string {
  return token.length <= 8 ? SLACK_MASK : SLACK_MASK + token.slice(-4);
}

export const slack = defineTransport<SlackConfig>({
  name: 'slack',
  addressPrefix: 'slack',
  configSchema: SlackConfigSchema,
  admin: {
    displayLabel: 'Slack',
    fields: [
      {
        key: 'botToken',
        type: 'password',
        label: 'Bot Token (xoxb-…)',
        placeholder: 'xoxb-...',
        secret: true,
      },
      {
        key: 'appToken',
        type: 'password',
        label: 'App Token (xapp-…)',
        placeholder: 'xapp-...',
        secret: true,
      },
    ],
    summarize: (entry) => maskSlackToken((entry as SlackRoute).botToken),
    setupInstructions: SLACK_SETUP,
  },
  create: (ctx, routes) => {
    if (routes.length === 0) return null;

    // Duplicate bot-token check (mirrors email.ts:566-571).
    const seen = new Set<string>();
    for (const r of routes) {
      if (seen.has(r.botToken)) {
        ctx.log.warn({ address: r.address }, 'Duplicate Slack bot token across routes — undefined behavior');
      }
      seen.add(r.botToken);
    }

    const bindings: SlackBinding[] = [];
    for (const r of routes) {
      const canonical = ctx.resolveAddress(r.address);
      if (!canonical) {
        ctx.log.warn({ address: r.address }, 'Slack route references unregistered address — skipping');
        continue;
      }
      bindings.push({
        botToken: r.botToken,
        appToken: r.appToken,
        address: canonical,
        channel: r.channel,
        allowedTeamIds: r.allowedTeamIds,
        allowedUserIds: r.allowedUserIds,
        botUserId: r.botUserId,
        streaming: r.streaming,
      });
    }
    if (bindings.length === 0) return null;
    return new SlackTransport(ctx, bindings);
  },
});
