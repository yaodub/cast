/**
 * Google Messages extension — main class.
 *
 * Read side wired: `gmessages__chats` and `gmessages__messages` over the live
 * dispatcher. Send, watches, and media are not exposed yet (each is an
 * outward-visible act or needs its own approval wiring). Enabling the extension
 * therefore grants read capability only, gated by `read_mode`.
 *
 * There is no local store: Google holds history and renders contact names into
 * the listing, so the tools are live reads. A short conversation cache is kept
 * only so the synchronous approval filter can resolve a chat name without a
 * network round-trip; it is refreshed on every listing fetch.
 */
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import {
  listConversations as libListConversations,
  listMessages as libListMessages,
  sendMessage as libSendMessage,
  uploadMedia as libUploadMedia,
  downloadMedia as libDownloadMedia,
  getFullSizeMedia as libGetFullSizeMedia,
  buildSendPlaintext,
  buildMediaSendPlaintext,
  generateTmpId,
  operationByName,
} from 'gmessages';
import type {
  ClientEvent,
  ConversationSummary,
  InboundAttachment,
  InboundMessage,
  MediaAttachment,
  MediaDeps,
  OperationDispatcher,
  SendParams,
  VerificationPrompt,
} from 'gmessages';

import type {
  ExtensionContext,
  ExtensionInstance,
  Logger,
  ToolCallContext,
  ToolDefinition,
  ToolResult,
} from '@getcast/extension-schema';
import { noopLogger, textResult } from '@getcast/extension-schema';

import type { GmessagesConfig, GmessagesSecrets } from './schemas.js';
import { ConnectionManager, type ConnectionLike } from './connection.js';
import {
  readDecision,
  canRead,
  sendDecision,
  coldSendDecision,
  isPhoneNumber,
  type Decision,
} from './policy.js';
import { toView, resolveConversation, type ConversationView } from './resolver.js';
import { renderConversationLine, renderMessage } from './render.js';
import { withTimeout, mimeFromFilename, safeBasename } from './helpers.js';
import { WatchManager } from './watch-manager.js';

const READY_TIMEOUT_MS = 15_000;
/**
 * How many threads to pull when a name has to be resolved against a fresh listing.
 *
 * Kept modest deliberately. An earlier 200 made every `messages` call fetch the whole inbox before it
 * could do anything else, and paired with a second round trip for the messages themselves that
 * overran the MCP call timeout — every read failed while `chats` (which fetches far fewer) worked.
 * Resolution is cache-first now, so this is the cold path only.
 */
const RESOLVE_FETCH = 50;
/** How deep to look when resolving a message id back to its attachment. */
const ATTACHMENT_LOOKUP_DEPTH = 100;
/** Resolution landed in ~5s when measured; these bound the wait at 12s without hugging that figure. */
const RESOLVE_POLL_INTERVAL_MS = 1_500;
const RESOLVE_POLL_ATTEMPTS = 8;

/**
 * Compose a media send: reference an already-uploaded attachment and issue it.
 *
 * There is no single library function for this — `buildMediaSendPlaintext`
 * builds the bytes and the dispatcher issues them, exactly as `sendMessage`
 * does for text. Kept here as one named seam so it can be faked in tests and
 * previewed without sending.
 */
async function sendMediaMessage(
  ops: OperationDispatcher,
  params: Omit<SendParams, 'text'>,
  media: MediaAttachment,
  tmpId: string,
): Promise<Uint8Array> {
  return ops.issueRaw(operationByName('SEND_MESSAGE'), buildMediaSendPlaintext(params, media, tmpId));
}

/** The library calls the tools make, injectable for tests. */
export interface ReadDeps {
  listConversations: typeof libListConversations;
  listMessages: typeof libListMessages;
  sendMessage: typeof libSendMessage;
  uploadMedia: typeof libUploadMedia;
  downloadMedia: typeof libDownloadMedia;
  getFullSizeMedia: typeof libGetFullSizeMedia;
  sendMediaMessage: typeof sendMediaMessage;
}

/** Test-only overrides; production constructs the real connection and library reads. */
export interface GmessagesOverrides {
  connection?: ConnectionLike;
  reads?: ReadDeps;
  /** Poll delay. Injected so the resolve wait is testable without real time passing. */
  sleep?: (ms: number) => Promise<void>;
}

export class GmessagesExtension implements ExtensionInstance {
  readonly name = 'gmessages';
  private config: GmessagesConfig;
  private log: Logger;

  private connection: ConnectionLike;
  private reads: ReadDeps;
  private watchManager: WatchManager;

  /** Last listing, for the synchronous approval filter. Refreshed on every fetch. */
  private cache: ConversationView[] = [];
  private sleep: (ms: number) => Promise<void>;

  constructor(ctx: ExtensionContext<GmessagesConfig, GmessagesSecrets>, overrides?: GmessagesOverrides) {
    this.config = ctx.config;
    this.log = ctx.log ?? noopLogger;
    this.sleep = overrides?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.watchManager = new WatchManager({
      privateDir: ctx.privateDir,
      deliver: ctx.deliver,
      log: this.log,
      config: this.config,
      resolve: (query) => this.resolveLive(query),
      ownParticipantId: () => this.connection.ownParticipantId(),
    });
    this.connection =
      overrides?.connection ??
      new ConnectionManager({
        privateDir: ctx.privateDir,
        log: this.log,
        onEvent: (event: ClientEvent) => this.watchManager.onEvent(event),
      });
    this.reads = overrides?.reads ?? {
      listConversations: libListConversations,
      listMessages: libListMessages,
      sendMessage: libSendMessage,
      uploadMedia: libUploadMedia,
      downloadMedia: libDownloadMedia,
      getFullSizeMedia: libGetFullSizeMedia,
      sendMediaMessage,
    };
  }

  /** Exposed so a fake connection's events can be driven in tests. */
  get watches(): WatchManager {
    return this.watchManager;
  }

  // =========================================================================
  // Tools
  // =========================================================================

  get tools(): ToolDefinition[] {
    const readApproval = this.config.read_mode === 'approval';

    const readFilter = (args: Record<string, unknown>): Decision => {
      const cid = this.resolveFromCache(String(args.chat ?? ''));
      // Cold cache can't apply a per-chat override; ask, which is the safe default
      // and only reachable in approval mode anyway.
      if (cid == null) return 'approve';
      return readDecision(this.config, cid);
    };

    return [
      {
        name: 'gmessages__chats',
        description:
          'List recent Google Messages conversations. Shows the display name (Google renders saved contacts by name), whether it is a group, SMS vs RCS, and the conversation id.',
        schema: {
          limit: z.number().int().min(1).max(50).optional().describe('Max conversations (default 25)'),
        },
      },
      {
        name: 'gmessages__messages',
        description:
          'Read messages from a Google Messages conversation. Accepts a contact name, label, phone number, or conversation id. Returns the thread with timestamps and senders.',
        schema: {
          chat: z.string().describe('Conversation name, label, phone number, or conversation id'),
          count: z.number().int().min(1).max(100).optional().describe('Messages to return (default 25)'),
          query: z.string().optional().describe('Keyword filter — only messages containing this text'),
        },
        approval: readApproval
          ? {
              enabled: true,
              preview: (args) => ({ summary: `Read messages from ${this.describeChat(String(args.chat ?? ''))}` }),
              filter: readFilter,
            }
          : undefined,
      },
      {
        name: 'gmessages__download',
        description:
          'Download an attachment from a message to staging. Returns the file path for use with the Read tool.',
        schema: {
          chat: z.string().describe('Conversation name, label, or id containing the message'),
          message_id: z.string().describe('Message id from gmessages__messages output'),
          index: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe('Which attachment, when a message carries more than one (default 0)'),
        },
        approval: readApproval
          ? {
              enabled: true,
              preview: (args) => ({
                summary: `Download attachment from ${this.describeChat(String(args.chat ?? ''))}`,
              }),
              filter: (args, ctx) => {
                const decision = readFilter(args);
                if (decision !== 'approve') return decision;
                // Downloading from a thread just approved for reading inherits
                // that approval — the attachment was already listed in it.
                const cid = this.resolveFromCache(String(args.chat ?? ''));
                const inherited = ctx.wasApproved(
                  ['gmessages__messages', 'gmessages__watch', 'gmessages__download'],
                  (prior) => {
                    const priorChat = typeof prior.chat === 'string' ? prior.chat : '';
                    return !!priorChat && cid != null && this.resolveFromCache(priorChat) === cid;
                  },
                );
                return inherited ? 'skip' : 'approve';
              },
            }
          : undefined,
      },
      {
        name: 'gmessages__send',
        description: `Send a message — text, or a file from /staging/out/. ${this.sendModeNote()}`,
        schema: {
          chat: z
            .string()
            .describe('Conversation name, label, or id. An E.164 number (+1…) starts a new thread.'),
          text: z.string().optional().describe('Message text (required unless sending a file)'),
          file: z.string().optional().describe('Filename in /staging/out/ to send as an attachment'),
        },
        approval: {
          // Always installed, unlike reads. The FILTER draws the distinctions:
          // it returns 'skip' for a direct-mode existing thread (no prompt) but
          // still 'approve' for a cold send, which no global mode may silence.
          // Gating on send_mode here would remove the machinery that enforces
          // that exception.
          enabled: true,
          preview: (args) => this.sendPreview(args),
          filter: (args) => this.sendFilter(args),
        },
      },
      {
        name: 'gmessages__watch',
        description:
          "Watch a conversation for new messages. New messages return to this conversation with the `instructions` you pass (write them standalone — they run without this conversation's history).",
        schema: {
          chat: z.string().describe('Conversation name, label, or id'),
          instructions: z.string().describe('Instructions for processing incoming messages'),
          id: z.string().optional().describe('Custom watch id (auto-generated if omitted)'),
        },
        approval: readApproval
          ? {
              enabled: true,
              preview: (args) => ({
                summary: `Watch ${this.describeChat(String(args.chat ?? ''))}`,
                details:
                  typeof args.instructions === 'string' ? `Instructions: ${args.instructions}` : undefined,
              }),
              filter: readFilter,
            }
          : undefined,
      },
      {
        name: 'gmessages__unwatch',
        description: 'Remove a watch created by this conversation.',
        schema: { id: z.string().describe('Watch id to remove') },
      },
      {
        name: 'gmessages__list_watches',
        description: "List this conversation's active watches.",
        schema: {},
      },
    ];
  }

  // =========================================================================
  // Prompt section
  // =========================================================================

  /**
   * Injected into the system prompt every turn, so it stays short and says only
   * what changes behaviour: the workflow, the two protocol facts an agent gets
   * wrong by default (SMS never reports delivery; groups show raw sender ids),
   * and what the current modes actually permit.
   */
  get promptSection(): string {
    const lines = [
      '## Google Messages (SMS/RCS)',
      '',
      '**Workflow: chats → messages → act.**',
      '1. `gmessages__chats` lists conversations — display name, group tag, SMS/RCS, and the conversation id.',
      '2. `gmessages__messages` reads one, by name, label, or id. An ambiguous name returns the matches — ask the user which.',
      '3. Media shows as `[media: image/jpeg] (id: …)`. Use `gmessages__download` with that id to fetch it to `/staging/in/`.',
      '   - Download works even for media the server has not fetched yet; the tool resolves it first. A first download of an old attachment may take a moment longer.',
      '',
      '**Two things that are easy to get wrong:**',
      '- **SMS threads never report delivery** past "accepted" — only RCS reports delivered/read. Never wait for a delivery receipt on an SMS thread; none is coming.',
      '- **In group threads the sender is a raw participant id**, not a name. Do not guess who it is.',
    ];

    const readLabel = { disabled: 'disabled', approval: 'approval-gated', open: 'open' }[this.config.read_mode];
    lines.push('', `**Reading:** ${readLabel}.`);
    if (this.config.read_mode === 'approval') {
      lines.push('- Reading a conversation asks the user for permission unless it is allowlisted.');
    } else if (this.config.read_mode === 'disabled') {
      lines.push('- All reads are blocked.');
    }

    lines.push('', `**Sending:** ${this.sendModeNote()}`);
    if (this.config.send_mode !== 'disabled') {
      lines.push(
        '- A send is IRREVERSIBLE — SMS cannot be unsent. The user sees the exact message before it goes out when approval applies.',
        '- You can only send to a conversation that already exists. There is no way to message a number for the first time; say so rather than trying.',
        '- Confirm the send happened by reading the thread back, not from the tool result.',
        '- To send a file, write it to `/staging/out/` first, then pass the filename. On an SMS thread it goes as MMS, which is size-limited and may be recompressed.',
      );
    }

    lines.push(
      '',
      '**Watches:** `gmessages__watch` monitors a conversation; new messages return to this conversation carrying your `instructions`.',
      "- Write those instructions standalone — they run without this conversation's history.",
      '- `gmessages__list_watches` and `gmessages__unwatch` manage the ones created here.',
    );

    return lines.join('\n');
  }

  private sendModeNote(): string {
    switch (this.config.send_mode) {
      case 'disabled':
        return 'Sending is disabled.';
      case 'approval':
        return 'Sending requires human approval.';
      case 'direct':
        return 'Sends immediately to existing threads; a first message to a new number still requires approval.';
    }
  }

  /**
   * The approval decision for a send. Cold targets (an E.164 with no existing
   * thread) route through `coldSendDecision`, which no global mode can silence.
   */
  private sendFilter(args: Record<string, unknown>): Decision {
    const chat = String(args.chat ?? '');
    const cid = this.resolveFromCache(chat);
    if (cid) return sendDecision(this.config, cid);
    if (isPhoneNumber(chat)) return coldSendDecision(this.config, chat.trim());
    // Unresolved and not a number: ask. The handler will fail it anyway.
    return 'approve';
  }

  /**
   * What the human sees before authorising a send.
   *
   * `details` carries the exact request bytes from `buildSendPlaintext` — the
   * library's preview seam (docs/AGENTS.md): the same builder the send uses,
   * called without a dispatcher, so approval IS the dry-run.
   */
  private sendPreview(args: Record<string, unknown>): { summary: string; details?: string } {
    const chat = String(args.chat ?? '');
    const text = String(args.text ?? '');
    const file = typeof args.file === 'string' ? safeBasename(args.file) : '';
    const cid = this.resolveFromCache(chat);
    const target = cid ? this.describeChat(chat) : `${chat} (NEW conversation)`;
    const body = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    // Name the file explicitly — an approver authorising an attachment needs to
    // know WHAT is leaving, and the bytes below only describe a text send.
    const snippet = file ? (body ? `[file: ${file}] ${body}` : `[file: ${file}]`) : body;

    let details: string | undefined;
    if (cid && !file) {
      try {
        const bytes = buildSendPlaintext(
          { conversationId: cid, text, participantId: this.connection.ownParticipantId() },
          'tmp_preview',
        );
        details = `Exact request: ${bytes.length} bytes\n${Buffer.from(bytes).toString('hex')}`;
      } catch {
        // A builder refusal (empty text/id) surfaces in the handler with a
        // better message; the preview should not fail the approval.
      }
    }
    return { summary: `Send to ${target}: ${snippet}`, ...(details ? { details } : {}) };
  }

  async handle(
    toolName: string,
    args: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    switch (toolName) {
      case 'gmessages__chats':
        return this.handleChats(args);
      case 'gmessages__messages':
        return this.handleMessages(args);
      case 'gmessages__send':
        return this.handleSend(args, call);
      case 'gmessages__download':
        return this.handleDownload(args, call);
      case 'gmessages__watch':
        return this.watchManager.handleWatch(args, call);
      case 'gmessages__unwatch':
        return this.watchManager.handleUnwatch(args, call);
      case 'gmessages__list_watches':
        return this.watchManager.handleListWatches(call);
      default:
        return textResult(`Unknown tool: ${toolName}`, true);
    }
  }

  // =========================================================================
  // Handlers
  // =========================================================================

  private async handleChats(args: Record<string, unknown>): Promise<ToolResult> {
    const limit = typeof args.limit === 'number' ? args.limit : 25;
    try {
      const ops = await this.dispatcher();
      const views = await this.fetchViews(ops, limit);
      const readable = views.filter((v) => canRead(this.config, v.conversationId));
      if (readable.length === 0) {
        if (this.config.read_mode === 'disabled') return textResult('Reading is disabled.', true);
        return textResult('No conversations.');
      }
      return textResult(readable.map(renderConversationLine).join('\n'));
    } catch (err) {
      return this.notReady(err);
    }
  }

  private async handleMessages(args: Record<string, unknown>): Promise<ToolResult> {
    const chat = String(args.chat ?? '');
    const count = typeof args.count === 'number' ? args.count : 25;
    const query = typeof args.query === 'string' ? args.query.toLowerCase() : undefined;
    if (chat === '') return textResult('A chat is required.', true);

    try {
      const ops = await this.dispatcher();
      const resolved = await this.resolveChat(ops, chat);
      if (resolved.ambiguous) {
        const lines = resolved.ambiguous.map(renderConversationLine).join('\n');
        return textResult(`Multiple conversations match "${chat}". Please specify:\n\n${lines}`, true);
      }
      if (!resolved.match) return textResult(`No conversation matching "${chat}".`, true);

      const view = resolved.match;
      if (!canRead(this.config, view.conversationId)) {
        return textResult('Access to this conversation is restricted.', true);
      }

      const msgs = await this.reads.listMessages(ops, view.conversationId, { count });
      if (msgs.length === 0) return textResult('No messages in this conversation yet.');

      const ownParticipantId = this.connection.ownParticipantId();
      let lines = msgs.map((m) => renderMessage(m, { ownParticipantId, view }));
      if (query) {
        lines = lines.filter((l) => l.toLowerCase().includes(query));
        if (lines.length === 0) return textResult(`No messages matching "${args.query}".`);
      }
      return textResult(lines.join('\n'));
    } catch (err) {
      return this.notReady(err);
    }
  }

  /**
   * Send a text.
   *
   * The approval gate has already run by the time this executes; these checks
   * are the hard-policy backstop (a 'block' must hold even if the gate is
   * misconfigured, and the framework never asks about a blocked call).
   *
   * Cold send is deliberately NOT implemented: resolution is restricted to
   * existing conversations, so v1 cannot open a thread with someone the account
   * has never messaged. The policy for it exists (`coldSendDecision`) and the
   * filter honours it, but the capability is withheld until it is asked for.
   */
  private async handleSend(args: Record<string, unknown>, call: ToolCallContext): Promise<ToolResult> {
    const chat = String(args.chat ?? '');
    const text = String(args.text ?? '');
    const file = typeof args.file === 'string' ? safeBasename(args.file) : '';
    if (chat === '') return textResult('A chat is required.', true);
    if (text === '' && file === '') return textResult('Provide text or a file to send.', true);
    if (this.config.send_mode === 'disabled') {
      return textResult('Sending is disabled.', true);
    }

    try {
      const ops = await this.dispatcher();
      const resolved = await this.resolveChat(ops, chat);
      if (resolved.ambiguous) {
        const lines = resolved.ambiguous.map(renderConversationLine).join('\n');
        return textResult(`Multiple conversations match "${chat}". Please specify:\n\n${lines}`, true);
      }
      if (!resolved.match) {
        return textResult(
          isPhoneNumber(chat)
            ? `No existing conversation with ${chat}. Starting a new thread is not supported yet — message them from the phone once first.`
            : `No conversation matching "${chat}".`,
          true,
        );
      }

      const view = resolved.match;
      if (sendDecision(this.config, view.conversationId) === 'block') {
        return textResult('Sending to this conversation is not allowed.', true);
      }

      const participantId = this.connection.ownParticipantId();

      if (file) {
        const media = this.connection.socket?.media;
        if (!media) return textResult('Media is not available on this session.', true);

        const filePath = path.join(call.stagingOutDir, file);
        if (!fs.existsSync(filePath)) return textResult(`File not found: /staging/out/${file}`, true);
        const mimeType = mimeFromFilename(file);
        if (!mimeType) {
          return textResult(
            `Cannot determine a supported type for "${file}". Send a common image, audio, video, or document format.`,
            true,
          );
        }

        const bytes = new Uint8Array(fs.readFileSync(filePath));
        // Uploading is NOT outward-visible — it parks encrypted bytes on
        // Google's server and nobody is notified. Only the send below, already
        // past the gate, makes it visible to anyone.
        const uploaded = await this.reads.uploadMedia(media, bytes, mimeType);
        await this.reads.sendMediaMessage(
          ops,
          { conversationId: view.conversationId, participantId },
          { ...uploaded, fileName: file, mimeType },
          generateTmpId(),
        );
        return textResult(`Sent ${file} to ${view.label}.`);
      }

      await this.reads.sendMessage(
        ops,
        { conversationId: view.conversationId, text, participantId },
        generateTmpId(),
      );
      // The relay echoes no id back, so a send is confirmed by reading the
      // thread rather than by this response (api/send.ts).
      return textResult(`Sent to ${view.label}.`);
    } catch (err) {
      return this.notReady(err);
    }
  }

  /**
   * Download an attachment to staging.
   *
   * There is no local message store, so the message id is resolved by
   * re-reading the thread — Google holds the history, and the attachment's
   * mediaId and decryption key ride on the message itself.
   */
  private async handleDownload(args: Record<string, unknown>, call: ToolCallContext): Promise<ToolResult> {
    const chat = String(args.chat ?? '');
    const messageId = String(args.message_id ?? '');
    if (chat === '' || messageId === '') return textResult('A chat and message_id are required.', true);

    try {
      const ops = await this.dispatcher();
      const resolved = await this.resolveChat(ops, chat);
      if (!resolved.match) return textResult(`No conversation matching "${chat}".`, true);
      const view = resolved.match;
      if (!canRead(this.config, view.conversationId)) {
        return textResult('Access to this conversation is restricted.', true);
      }

      const media = this.connection.socket?.media;
      if (!media) return textResult('Media is not available on this session.', true);

      const messages = await this.reads.listMessages(ops, view.conversationId, {
        count: ATTACHMENT_LOOKUP_DEPTH,
      });
      const message = messages.find((m) => m.messageId === messageId);
      if (!message) {
        return textResult(
          `Message ${messageId} not found in the last ${ATTACHMENT_LOOKUP_DEPTH} messages of this conversation.`,
          true,
        );
      }
      if (message.attachments.length === 0) {
        return textResult('That message carries no attachment.', true);
      }
      // A message can carry SEVERAL attachments — that is precisely why resolution needs a part id
      // alongside the message id. Defaulting to the first is fine; silently substituting it for the
      // one that was asked for is not.
      const index = typeof args.index === 'number' ? args.index : 0;
      let attachment = message.attachments[index];
      if (!attachment) {
        return textResult(
          `That message has ${message.attachments.length} attachment(s); index ${index} is out of range.`,
          true,
        );
      }

      // An attachment arrives with no media id and no key until its media has been RESOLVED. Doing
      // that is a request, not a wait, so do it here rather than reporting a failure the agent can
      // do nothing about — resolving is what Google's own client does when a person opens an image.
      if (!attachment.mediaId) {
        if (!attachment.partId) {
          return textResult('That attachment cannot be resolved — it carries no part id.', true);
        }
        const wanted = attachment.partId;
        // Fire and WAIT. Resolution is asynchronous: measured, the reply echoes the requested part
        // still empty, an immediate re-read shows the same, and the handle appears about five
        // seconds later. Reading the reply is what made a call that had actually succeeded report
        // failure — so the reply is ignored and the thread is re-read until the handle shows up.
        await this.reads.getFullSizeMedia(ops, messageId, wanted);
        const match = await this.awaitResolved(ops, view.conversationId, messageId, wanted);
        if (!match?.mediaId) {
          // Failure path only. Distinguishes "the part vanished from the thread" from "it is still
          // there but never gained a handle" — different problems, and the tool result cannot say
          // which for whoever has to fix it.
          this.log.warn(
            { messageId, partId: wanted, stillPresent: match !== undefined, waitedMs: RESOLVE_POLL_INTERVAL_MS * RESOLVE_POLL_ATTEMPTS },
            'gmessages: media did not resolve within the wait',
          );
          return textResult(
            `That ${attachment.mimeType || 'attachment'} is still being fetched from the server. Try again shortly.`,
            true,
          );
        }
        attachment = match;
      }

      const { bytes, mimeType } = await this.reads.downloadMedia(
        media,
        attachment.mediaId,
        attachment.key,
      );
      // The staged name is built from the message id and index, NOT from `fileName`. The relay's
      // filename is advisory and routinely duplicated — every inbound photo arrives as "Attachment0",
      // so two attachments on one message both landed on the same path and the second silently
      // overwrote the first. Any original name is kept as a readable suffix, never as the identity.
      const fallbackExt = mimeType.includes('/') ? `.${mimeType.split('/')[1]}` : '.bin';
      const supplied = safeBasename(attachment.fileName || '');
      const suffix = supplied && supplied.includes('.') ? `-${supplied}` : fallbackExt;
      const name = `gm-${safeBasename(messageId)}-${index}${suffix}`;
      fs.mkdirSync(call.stagingDir, { recursive: true });
      fs.writeFileSync(path.join(call.stagingDir, name), bytes);
      return textResult(`Downloaded to /staging/in/${name} (${mimeType}). Use the Read tool to view it.`);
    } catch (err) {
      return this.notReady(err);
    }
  }

  // =========================================================================
  // Resolution + fetch
  // =========================================================================

  /**
   * Resolve a chat argument, doing as little network work as possible.
   *
   * Order matters for latency, not just correctness. A tool call has a hard deadline at the MCP
   * layer, and a `messages` call already owes one round trip for the messages themselves — so
   * spending another on a full listing every time is what pushed reads past that deadline.
   *
   *   1. Cache — free. Warm after any `chats` call, which is what the agent does first anyway.
   *   2. Bare conversation id — free. `listMessages` takes an id, so an id needs no listing at all;
   *      the label is filled in from cache when known and falls back to the id when not.
   *   3. Fresh listing — the cold path, and the only one that costs a round trip.
   */
  private async resolveChat(
    ops: OperationDispatcher,
    query: string,
  ): Promise<
    { match: ConversationView; ambiguous?: undefined } | { match?: undefined; ambiguous?: readonly ConversationView[] }
  > {
    const cached = resolveConversation(query, this.cache);
    if (cached.match) return { match: cached.match };
    if (cached.ambiguous) return { ambiguous: cached.ambiguous };

    // An id the listing has not been asked about is still a usable target.
    const bare = query.trim();
    if (/^\d+$/.test(bare)) {
      return {
        match: { conversationId: bare, label: this.config.labels[bare] ?? bare, kind: 'unknown', participants: [], isGroup: false },
      };
    }

    const views = await this.fetchViews(ops, RESOLVE_FETCH);
    const fresh = resolveConversation(query, views);
    if (fresh.match) return { match: fresh.match };
    return fresh.ambiguous ? { ambiguous: fresh.ambiguous } : {};
  }

  /**
   * Re-read a thread until one part's media handle appears, or give up.
   *
   * `GET_FULL_SIZE_MEDIA` returns before the media is actually resolved, so the only way to know it
   * worked is to look again. Bounded because a tool call has a deadline at the MCP layer and because
   * a resolve that never lands should report rather than hang; matched on PART ID, never position,
   * since the message can carry several and returning the wrong one is worse than returning none.
   */
  private async awaitResolved(
    ops: OperationDispatcher,
    conversationId: string,
    messageId: string,
    partId: string,
  ): Promise<InboundAttachment | undefined> {
    let last: InboundAttachment | undefined;
    for (let attempt = 0; attempt < RESOLVE_POLL_ATTEMPTS; attempt++) {
      await this.sleep(RESOLVE_POLL_INTERVAL_MS);
      const msgs = await this.reads.listMessages(ops, conversationId, {
        count: ATTACHMENT_LOOKUP_DEPTH,
      });
      last = msgs
        .find((m) => m.messageId === messageId)
        ?.attachments.find((a) => a.partId === partId);
      if (last?.mediaId) return last;
    }
    return last;
  }

  /** Live resolution for the watch manager, which has no dispatcher of its own. */
  private async resolveLive(
    query: string,
  ): Promise<
    { match: ConversationView; ambiguous?: undefined } | { match?: undefined; ambiguous?: readonly ConversationView[] }
  > {
    return this.resolveChat(await this.dispatcher(), query);
  }

  /** Fetch a listing, refresh the cache, return the views. */
  private async fetchViews(ops: OperationDispatcher, count: number): Promise<ConversationView[]> {
    const summaries: readonly ConversationSummary[] = await this.reads.listConversations(ops, { count });
    const views = summaries.map((s) => toView(s, this.config.labels));
    this.cache = views;
    return views;
  }

  /** Synchronous resolution against the last-fetched listing (for approval filter/preview). */
  private resolveFromCache(query: string): string | null {
    return resolveConversation(query, this.cache).match?.conversationId ?? null;
  }

  /** Human label for an approval preview — the cached match's label, or the raw query. */
  private describeChat(query: string): string {
    return resolveConversation(query, this.cache).match?.label ?? query;
  }

  // =========================================================================
  // Connection plumbing
  // =========================================================================

  private async dispatcher(): Promise<OperationDispatcher> {
    if (!this.connection.isPaired()) throw new Error('Google Messages not paired. Pair in the admin panel first.');
    // A terminally-dead connection would otherwise sit out the full ready
    // timeout and report a bare "timeout", hiding the actual fix (re-pair).
    const dead = this.connection.deadReason();
    if (dead) throw new Error(dead);
    await withTimeout(this.connection.ready, READY_TIMEOUT_MS, 'Google Messages not ready — connection timeout.');
    const deadAfterWait = this.connection.deadReason();
    if (deadAfterWait) throw new Error(deadAfterWait);
    const socket = this.connection.socket;
    if (!socket) throw new Error('Google Messages not connected.');
    return socket.operations;
  }

  private notReady(err: unknown): ToolResult {
    const message = err instanceof Error ? err.message : String(err);
    return textResult(message, true);
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async onAgentStart(): Promise<void> {
    this.watchManager.start();
    this.connection.start();
  }

  async onAgentStop(): Promise<void> {
    this.watchManager.stop();
    await this.connection.stop();
  }

  // =========================================================================
  // Public service API (admin router and direct service consumers)
  // =========================================================================

  isPaired(): boolean {
    return this.connection.isPaired();
  }

  isConnected(): boolean {
    return this.connection.isConnected();
  }

  async pair(
    cookies: string,
    onVerification: (prompt: VerificationPrompt) => void | Promise<void>,
  ): Promise<VerificationPrompt> {
    return this.connection.pair(cookies, onVerification);
  }

  /**
   * Live conversation inventory for the admin policy picker. Fetches fresh and
   * refreshes the cache; returns [] when not connected (policy editing must not
   * require a live connection).
   */
  async refreshConversations(limit = RESOLVE_FETCH): Promise<
    Array<{ conversationId: string; label: string; kind: 'sms' | 'rcs' | 'unknown' }>
  > {
    try {
      const ops = await this.dispatcher();
      const views = await this.fetchViews(ops, limit);
      return views.map((v) => ({ conversationId: v.conversationId, label: v.label, kind: v.kind }));
    } catch {
      return [];
    }
  }

  /** The last-known listing (cache), for a synchronous admin read. */
  listConversationsResolved(): Array<{
    conversationId: string;
    label: string;
    kind: 'sms' | 'rcs' | 'unknown';
  }> {
    return this.cache.map((v) => ({ conversationId: v.conversationId, label: v.label, kind: v.kind }));
  }
}
