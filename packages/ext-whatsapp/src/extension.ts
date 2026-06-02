/**
 * WhatsApp extension — main class.
 *
 * Orchestrates tools, prompt, handle dispatch, and lifecycle.
 * Delegates connection to ConnectionManager, data to WhatsAppStore
 * (contact-identity model), watches to WatchManager.
 *
 * Tool handlers operate on `contact_id` resolved from name/phone/JID
 * inputs. ACL checks consult every alias of a contact so config entries
 * keyed on either form (PN or LID) match.
 */
import fs from 'fs';
import path from 'path';

import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import { z } from 'zod';

import type {
  ExtensionContext,
  ExtensionInstance,
  Logger,
  ToolCallContext,
  ToolDefinition,
  ToolResult,
} from '@getcast/extension-schema';
import { noopLogger, textResult } from '@getcast/extension-schema';

import type { WhatsAppConfig, WhatsAppSecrets } from './schemas.js';
import { WhatsAppStore } from './store.js';
import { ConnectionManager } from './connection.js';
import { WatchManager } from './watch-manager.js';
import {
  withTimeout,
  formatMessage,
  mimetypeFromExtension,
  buildMediaContent,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Extension class
// ---------------------------------------------------------------------------

type Decision = 'skip' | 'approve' | 'block';

export class WhatsAppExtension implements ExtensionInstance {
  readonly name = 'whatsapp';
  private config: WhatsAppConfig;
  private log: Logger;
  private hasChannel: boolean;

  private store: WhatsAppStore;
  private connection: ConnectionManager;
  private watchManager: WatchManager;

  constructor(ctx: ExtensionContext<WhatsAppConfig, WhatsAppSecrets>) {
    this.config = ctx.config;
    this.log = ctx.log ?? noopLogger;
    this.hasChannel = ctx.hasChannel;

    this.store = new WhatsAppStore({
      dbPath: path.join(ctx.privateDir, 'messages.db'),
      authDir: path.join(ctx.privateDir, 'auth'),
      log: this.log,
    });
    this.connection = new ConnectionManager({
      privateDir: ctx.privateDir,
      store: this.store,
      log: this.log,
      pairingHistoryDepth: ctx.config.pairing_history_depth,
      getMessage: async (key) => {
        const jid = key.remoteJid;
        if (!jid || !key.id) return undefined;
        const contactId = this.store.getContactIdForJid(jid);
        if (contactId == null) return undefined;
        const msg = this.store.getMessageByIdAndContact(key.id, contactId);
        return msg?.message ?? undefined;
      },
    });
    this.watchManager = new WatchManager({
      privateDir: ctx.privateDir,
      deliver: ctx.deliver,
      log: this.log,
      store: this.store,
      config: this.config,
    });
  }

  // =========================================================================
  // Tools
  // =========================================================================

  get tools(): ToolDefinition[] {
    const readApproval = this.config.read_mode === 'approval';
    const sendApproval = this.config.send_mode === 'approval';

    const buildChatFilter = (axis: 'read' | 'send') => (args: Record<string, unknown>): Decision => {
      const chat = typeof args.chat === 'string' ? args.chat : '';
      const cid = this.store.resolveQueryToContactId(chat);
      if (cid == null) return 'skip';
      return axis === 'read' ? this.readDecision(cid) : this.sendDecision(cid);
    };

    const readFilter = buildChatFilter('read');
    const sendFilter = buildChatFilter('send');

    const tools: ToolDefinition[] = [
      {
        name: 'whatsapp__chats',
        description: 'List recent WhatsApp chats. Shows name, last message preview, unread count, and whether it is a group.',
        schema: {
          limit: z.number().int().min(1).max(50).optional()
            .describe('Max chats to return (default 20)'),
        },
      },
      {
        name: 'whatsapp__messages',
        description: 'Read messages from a WhatsApp chat. Accepts a contact name, phone number, or JID. Returns the conversation thread with timestamps and sender names.',
        schema: {
          chat: z.string().describe('Chat name, phone number, or JID'),
          count: z.number().int().min(1).max(100).optional()
            .describe('Number of messages to return (default 20)'),
          query: z.string().optional()
            .describe('Keyword filter — only return messages containing this text'),
        },
        approval: readApproval ? {
          enabled: true,
          preview: (args) => ({ summary: `Read messages from ${this.describeChat(args.chat as string)}` }),
          filter: readFilter,
        } : undefined,
      },
      {
        name: 'whatsapp__download',
        description: 'Download media from a WhatsApp message to staging. Returns the file path for use with the Read tool.',
        schema: {
          message_id: z.string().describe('Message ID from whatsapp__messages output'),
          chat: z.string().describe('Chat name, phone number, or JID containing the message'),
        },
        approval: readApproval ? {
          enabled: true,
          preview: (args) => ({ summary: `Download media from ${this.describeChat(args.chat as string)}` }),
          filter: (args, ctx) => {
            const chat = typeof args.chat === 'string' ? args.chat : '';
            const cid = this.store.resolveQueryToContactId(chat);
            if (cid == null) return 'skip';
            const decision = this.readDecision(cid);
            if (decision !== 'approve') return decision;
            const inherited = ctx.wasApproved(
              ['whatsapp__messages', 'whatsapp__watch', 'whatsapp__download'],
              (priorArgs) => {
                const priorChat = typeof priorArgs.chat === 'string' ? priorArgs.chat : '';
                if (!priorChat) return false;
                return this.store.resolveQueryToContactId(priorChat) === cid;
              },
            );
            return inherited ? 'skip' : 'approve';
          },
        } : undefined,
      },
      {
        name: 'whatsapp__send',
        description: `Send a WhatsApp message. Text by default; attach a file from /staging/out/ for media. ${this.sendModeNote()}`,
        schema: {
          chat: z.string().describe('Chat name, phone number, or JID'),
          text: z.string().optional().describe('Message text (required for text, optional caption for media)'),
          file: z.string().optional().describe('Filename in /staging/out/ to send as media'),
        },
        approval: sendApproval ? {
          enabled: true,
          preview: (args) => {
            const chat = this.describeChat(args.chat as string);
            const text = typeof args.text === 'string' ? args.text : '';
            const file = typeof args.file === 'string' ? args.file : '';
            const snippet = text ? (text.length > 80 ? `${text.slice(0, 80)}…` : text) : `[media: ${file}]`;
            return { summary: `Send to ${chat}: ${snippet}` };
          },
          filter: sendFilter,
        } : undefined,
      },
    ];

    if (this.hasChannel) {
      tools.push(
        {
          name: 'whatsapp__watch',
          description: 'Watch a WhatsApp chat for new messages. Messages are forwarded to your processing channel with instructions. Real-time only.',
          schema: {
            chat: z.string().describe('Chat name, phone number, or JID'),
            instructions: z.string().describe('Instructions for processing incoming messages'),
            id: z.string().optional().describe('Custom watch ID (auto-generated if omitted)'),
          },
          approval: readApproval ? {
            enabled: true,
            preview: (args) => ({
              summary: `Watch ${this.describeChat(args.chat as string)}`,
              details: typeof args.instructions === 'string' ? `Instructions: ${args.instructions}` : undefined,
            }),
            filter: readFilter,
          } : undefined,
        },
        {
          name: 'whatsapp__unwatch',
          description: 'Remove a WhatsApp watch.',
          schema: {
            id: z.string().describe('Watch ID to remove'),
          },
        },
        {
          name: 'whatsapp__list_watches',
          description: 'List all active WhatsApp watches.',
          schema: {},
        },
      );
    }

    return tools;
  }

  // =========================================================================
  // ACL decisions (contact-scoped, iterate every alias)
  // =========================================================================

  private readDecision(contactId: number): Decision {
    for (const jid of this.store.getAliasesForContact(contactId)) {
      const override = this.config.chats[jid]?.read;
      if (override === 'allow') return 'skip';
      if (override === 'deny') return 'block';
    }
    if (this.config.read_mode === 'disabled') return 'block';
    if (this.config.read_mode === 'open') return 'skip';
    return 'approve';
  }

  private sendDecision(contactId: number): Decision {
    for (const jid of this.store.getAliasesForContact(contactId)) {
      const override = this.config.chats[jid]?.send;
      if (override === 'allow') return 'skip';
      if (override === 'deny') return 'block';
    }
    if (this.config.send_mode === 'disabled') return 'block';
    if (this.config.send_mode === 'direct') return 'skip';
    return 'approve';
  }

  private canRead(contactId: number): boolean { return this.readDecision(contactId) !== 'block'; }
  private canSend(contactId: number): boolean { return this.sendDecision(contactId) !== 'block'; }

  // =========================================================================
  // Display helpers
  // =========================================================================

  /**
   * Human-friendly label for an approval preview. Resolves to the contact's
   * materialized display_name. Throws if the query can't be resolved — only
   * reachable if the filter lambda returned 'approve' against an unresolvable
   * input, which is an invariant violation.
   */
  private describeChat(chat: string): string {
    const cid = this.store.resolveQueryToContactId(chat);
    if (cid == null) throw new Error(`describeChat called with unresolvable chat: ${chat}`);
    const row = this.store.resolver.getContact(cid);
    return row?.display_name ?? chat;
  }

  private sendModeNote(): string {
    switch (this.config.send_mode) {
      case 'disabled': return 'Sending is disabled.';
      case 'approval': return 'Sending unclassified chats requires human approval.';
      case 'direct': return 'Sends immediately.';
    }
  }

  /** Name for a sender_contact_id, for use in message rendering. */
  private senderName(msg: WAMessage): string {
    if (msg.key.fromMe) return 'You';
    const participant = msg.key.participant;
    const senderJid = participant ?? msg.key.remoteJid ?? '';
    const cid = senderJid ? this.store.getContactIdForJid(senderJid) : null;
    if (cid != null) {
      const row = this.store.resolver.getContact(cid);
      if (row?.display_name) return row.display_name;
    }
    return msg.pushName ?? senderJid ?? 'Unknown';
  }

  // =========================================================================
  // Prompt section
  // =========================================================================

  get promptSection(): string {
    const lines = [
      '## WhatsApp',
      '',
      'Use WhatsApp tools to read and interact with WhatsApp messages.',
      '',
      '**Workflow: chats → messages → act.**',
      '1. `whatsapp__chats` lists recent chats with previews.',
      '2. `whatsapp__messages` reads a conversation by name, phone, or JID.',
      '   - If the name is ambiguous, the tool returns matches — ask the user to clarify.',
      '3. Messages show media as placeholders: `[image]`, `[voice note]`, `[document: file.pdf]`.',
      '   Use `whatsapp__download` with the message ID to download media to `/staging/in/`.',
    ];

    const readLabel = ({ disabled: 'disabled', approval: 'approval-gated', open: 'open' } as const)[this.config.read_mode];
    const sendLabel = ({ disabled: 'disabled', approval: 'approval-gated', direct: 'direct' } as const)[this.config.send_mode];
    lines.push(
      '',
      `**Reading:** ${readLabel}.`,
      this.config.read_mode === 'approval'
        ? '- Reading an unclassified chat asks the user for permission. Downloading media from a just-approved chat auto-inherits that approval.'
        : this.config.read_mode === 'disabled'
          ? '- All reads are blocked.'
          : '- Reads are unrestricted (except blocked chats).',
    );
    lines.push(
      '',
      `**Sending:** ${sendLabel}.`,
      this.config.send_mode === 'disabled'
        ? '- `whatsapp__send` is blocked.'
        : this.config.send_mode === 'approval'
          ? '- Sending to an unclassified chat asks the user for permission. Allowlisted chats send immediately.'
          : '- Sends go out immediately. Exercise judgment — confirm with the user when in doubt.',
      '- To send media, first write the file to `/staging/out/`, then pass the filename.',
    );

    if (this.hasChannel) {
      lines.push(
        '', '**Watches:** Use `whatsapp__watch` to monitor a chat. Messages are forwarded to your processing channel.',
        '- Watches are always real-time. When new messages arrive, they are delivered immediately.',
        '- Use `whatsapp__list_watches` to see active watches and `whatsapp__unwatch` to remove them.',
      );
    } else {
      lines.push('', '**Watches are not available** — no processing channel is configured.');
    }

    return lines.join('\n');
  }

  // =========================================================================
  // Handle dispatch
  // =========================================================================

  async handle(
    toolName: string,
    args: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    switch (toolName) {
      case 'whatsapp__chats': return this.handleChats(args);
      case 'whatsapp__messages': return this.handleMessages(args);
      case 'whatsapp__download': return this.handleDownload(args, call);
      case 'whatsapp__send': return this.handleSend(args, call);
      case 'whatsapp__watch': return this.watchManager.handleWatch(args, call, this.connection);
      case 'whatsapp__unwatch': return this.watchManager.handleUnwatch(args);
      case 'whatsapp__list_watches': return this.watchManager.handleListWatches();
      default: return textResult(`Unknown tool: ${toolName}`, true);
    }
  }

  // =========================================================================
  // Tool handlers
  // =========================================================================

  private async handleChats(args: Record<string, unknown>): Promise<ToolResult> {
    const err = await this.ensureReady();
    if (err) return err;

    const limit = typeof args.limit === 'number' ? args.limit : 20;
    const contacts = this.store.listContacts(limit);

    const readable = contacts.filter(c => this.canRead(c.contact_id));
    if (readable.length === 0 && this.config.read_mode === 'disabled') {
      return textResult('Reading is disabled.', true);
    }

    const lines = readable.map(c => {
      const tag = c.is_group ? ' (group)' : '';
      const unread = c.unread_count > 0 ? ` [${c.unread_count} unread]` : '';
      return `${c.display_name ?? `contact-${c.contact_id}`}${tag}${unread}`;
    });
    return textResult(lines.join('\n') || 'No chats yet.');
  }

  private async handleMessages(args: Record<string, unknown>): Promise<ToolResult> {
    const err = await this.ensureReady();
    if (err) return err;

    const chatArg = String(args.chat ?? '');
    const count = typeof args.count === 'number' ? args.count : 20;
    const query = typeof args.query === 'string' ? args.query : undefined;

    const resolved = this.resolveChat(chatArg);
    if (resolved.error) return resolved.error;
    const contactId = resolved.contactId;

    if (!this.canRead(contactId)) {
      return textResult('Access to this chat is restricted.', true);
    }

    const msgs = this.store.getMessagesByContact(contactId, count);
    if (msgs.length === 0) return textResult('No messages available for this chat yet.');

    let formatted = msgs.map(m => {
      const sender = this.senderName(m);
      return formatMessage(m, sender);
    });

    if (query) {
      const q = query.toLowerCase();
      formatted = formatted.filter(f => f.text.toLowerCase().includes(q));
      if (formatted.length === 0) return textResult(`No messages matching "${query}" in this chat.`);
    }

    const lines = formatted.map(f => {
      const ts = f.timestamp > 0
        ? new Date(f.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')
        : '';
      return `[${ts}] ${f.sender}: ${f.text}${f.hasMedia ? ` (ID: ${f.id})` : ''}`;
    });
    return textResult(lines.join('\n'));
  }

  private async handleDownload(args: Record<string, unknown>, call: ToolCallContext): Promise<ToolResult> {
    const err = await this.ensureReady();
    if (err) return err;

    const messageId = String(args.message_id ?? '');
    const resolved = this.resolveChat(String(args.chat ?? ''));
    if (resolved.error) return resolved.error;
    const contactId = resolved.contactId;

    if (!this.canRead(contactId)) {
      return textResult('Access to this chat is restricted.', true);
    }

    let msg = this.store.getMediaMessage(messageId);
    if (!msg) msg = this.store.getMessageByIdAndContact(messageId, contactId);
    if (!msg) return textResult('Message not found or no longer in buffer.', true);

    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      const docName = msg.message?.documentMessage?.fileName;
      const ext = msg.message?.documentMessage?.mimetype
        ? `.${msg.message.documentMessage.mimetype.split('/')[1]}`
        : '';
      const filename = docName ?? `media_${messageId.slice(0, 12)}${ext || '.bin'}`;

      fs.mkdirSync(call.stagingDir, { recursive: true });
      fs.writeFileSync(path.join(call.stagingDir, filename), buffer);
      return textResult(`Downloaded to /staging/in/${filename}. Use the Read tool to view it.`);
    } catch (e) {
      this.log.warn({ messageId, err: e }, 'whatsapp__download failed');
      return textResult(
        `Media download failed — the file may have expired. ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
    }
  }

  private async handleSend(args: Record<string, unknown>, call: ToolCallContext): Promise<ToolResult> {
    const err = await this.ensureReady();
    if (err) return err;

    const text = typeof args.text === 'string' ? args.text : undefined;
    const file = typeof args.file === 'string' ? args.file : undefined;
    if (!text && !file) return textResult('Provide at least text or file to send.', true);

    const resolved = this.resolveChat(String(args.chat ?? ''));
    if (resolved.error) return resolved.error;
    const contactId = resolved.contactId;

    if (!this.canSend(contactId)) {
      return textResult('Sending to this chat is disabled.', true);
    }

    const sock = this.connection.socket;
    if (!sock) return textResult('WhatsApp not connected.', true);

    const routingJid = this.store.getPreferredJid(contactId);
    if (!routingJid) return textResult('No routable address for this contact.', true);

    try {
      if (file) {
        const filePath = path.join(call.stagingOutDir, file);
        if (!fs.existsSync(filePath)) return textResult(`File not found: /staging/out/${file}`, true);
        const buffer = fs.readFileSync(filePath);
        const mimetype = mimetypeFromExtension(file);
        const content = buildMediaContent(buffer, path.basename(file), mimetype, text);
        await sock.sendMessage(routingJid, content);
      } else {
        await sock.sendMessage(routingJid, { text: text! });
      }
      return textResult('Message sent.');
    } catch (e) {
      this.log.warn({ routingJid, err: e }, 'whatsapp__send failed');
      return textResult(
        `Send failed: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
    }
  }

  // =========================================================================
  // Shared helpers
  // =========================================================================

  private async ensureReady(): Promise<ToolResult | null> {
    if (!this.connection.isPaired()) {
      return textResult('WhatsApp not paired. Link a device in the admin panel first.', true);
    }
    try {
      await withTimeout(this.connection.ready, 15_000, 'WhatsApp not ready — connection timeout');
      return null;
    } catch {
      return textResult('WhatsApp not ready — connection timeout. Try again in a moment.', true);
    }
  }

  /** Resolve a chat query (name / phone / JID) to a contact_id. */
  private resolveChat(query: string): { contactId: number; error?: undefined } | { contactId?: undefined; error: ToolResult } {
    if (!query) return { error: textResult('Chat argument required.', true) };
    const cid = this.store.resolveQueryToContactId(query);
    if (cid != null) return { contactId: cid };

    // No single match — check for ambiguity
    const matches = this.store.resolveQueryMatches(query);
    if (matches.length === 0) return { error: textResult(`No chat found matching "${query}".`, true) };
    if (matches.length > 1) {
      const lines = matches.map(m => `${m.name} — ${m.jid}${m.isGroup ? ' (group)' : ''}`).join('\n');
      return {
        error: textResult(`Multiple chats match "${query}". Please specify:\n\n${lines}`, true),
      };
    }
    return { contactId: matches[0]!.contactId };
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async onAgentStart(): Promise<void> {
    this.watchManager.start();
    await this.connection.connect();
  }

  onAgentStop(): void {
    this.watchManager.stop();
    this.connection.disconnect();
    this.store.close();
  }

  // =========================================================================
  // Public service API (used by admin router and direct service consumers)
  // =========================================================================

  listChatsResolved(limit?: number): Array<{ jid: string; name: string; isGroup: boolean }> {
    return this.store.listContactsResolved(limit).map(c => ({
      jid: c.jid, name: c.name, isGroup: c.isGroup,
    }));
  }

  async pair(phoneNumber: string): Promise<string> {
    return this.connection.pair(phoneNumber);
  }

  isConnected(): boolean { return this.connection.isConnected(); }
  isPaired(): boolean { return this.connection.isPaired(); }
}
