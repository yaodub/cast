/**
 * WhatsApp extension — watch manager.
 *
 * Watches are per-contact (not per-JID) so addressing changes don't break
 * them. Persists to watches.json.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import type { WAMessage } from '@whiskeysockets/baileys';

import type { ExtensionContext, Logger, ToolCallContext, ToolResult } from '@getcast/extension-schema';
import { textResult } from '@getcast/extension-schema';

import type { WhatsAppConfig } from './schemas.js';
import type { WhatsAppStore } from './store.js';
import type { ConnectionManager } from './connection.js';
import { formatMessage } from './helpers.js';

// ---------------------------------------------------------------------------
// Watch type
// ---------------------------------------------------------------------------

const WatchSchema = z.object({
  id: z.string(),
  contactId: z.number().int(),
  chatName: z.string(),
  instructions: z.string(),
  target: z.string(),
  createdAt: z.string(),
});
type Watch = z.infer<typeof WatchSchema>;

// ---------------------------------------------------------------------------
// WatchManager
// ---------------------------------------------------------------------------

export class WatchManager {
  private watches = new Map<string, Watch>();
  private readonly watchesPath: string;
  private deliver: ExtensionContext['deliver'];
  private log: Logger;
  private store: WhatsAppStore;
  private config: WhatsAppConfig;

  constructor(opts: {
    privateDir: string;
    deliver: ExtensionContext['deliver'];
    log: Logger;
    store: WhatsAppStore;
    config: WhatsAppConfig;
  }) {
    this.watchesPath = path.join(opts.privateDir, 'watches.json');
    this.deliver = opts.deliver;
    this.log = opts.log;
    this.store = opts.store;
    this.config = opts.config;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.loadWatches();
    this.store.onNewMessages = (contactId, messages) => this.handleNewMessages(contactId, messages);
  }

  stop(): void {
    this.store.onNewMessages = null;
  }

  // =========================================================================
  // Tool handlers
  // =========================================================================

  handleWatch(
    args: Record<string, unknown>,
    call: ToolCallContext,
    connection: ConnectionManager,
  ): ToolResult {
    if (!connection.isPaired()) return textResult('WhatsApp not paired.', true);

    const chatArg = String(args.chat ?? '');
    const instructions = String(args.instructions ?? '');
    const customId = typeof args.id === 'string' ? args.id : undefined;

    if (!instructions) return textResult('Instructions are required.', true);

    const contactId = this.store.resolveQueryToContactId(chatArg);
    if (contactId == null) {
      const matches = this.store.resolveQueryMatches(chatArg);
      if (matches.length === 0) return textResult(`No chat found matching "${chatArg}".`, true);
      const lines = matches.map(m => `${m.name} — ${m.jid}${m.isGroup ? ' (group)' : ''}`).join('\n');
      return textResult(`Multiple chats match "${chatArg}". Please specify:\n\n${lines}`, true);
    }

    // Hard-policy backstop — ACL checked against every alias of the contact.
    if (!this.contactReadable(contactId)) {
      return textResult('Access to this chat is restricted.', true);
    }

    if (!call.participant) return textResult('Watches require a participant context.', true);

    const contact = this.store.resolver.getContact(contactId);
    const chatName = contact?.display_name ?? `contact-${contactId}`;
    const id = customId ?? `watch_${crypto.randomBytes(4).toString('hex')}`;
    const watch: Watch = {
      id,
      contactId,
      chatName,
      instructions,
      target: call.participant,
      createdAt: new Date().toISOString(),
    };

    this.watches.set(id, watch);
    this.persistWatches();

    return textResult(`Watch "${id}" created for ${chatName}. New messages will be forwarded with your instructions.`);
  }

  handleUnwatch(args: Record<string, unknown>): ToolResult {
    const id = String(args.id ?? '');
    if (!this.watches.has(id)) return textResult(`Watch "${id}" not found.`, true);
    this.watches.delete(id);
    this.persistWatches();
    return textResult(`Watch "${id}" removed.`);
  }

  handleListWatches(): ToolResult {
    if (this.watches.size === 0) return textResult('No active watches.');
    const lines = [...this.watches.values()].map(w =>
      `ID: ${w.id}\n  Chat: ${w.chatName}\n  Instructions: ${w.instructions}\n  Created: ${w.createdAt}`,
    );
    return textResult(lines.join('\n\n'));
  }

  // =========================================================================
  // Internal — message matching + delivery
  // =========================================================================

  private handleNewMessages(contactId: number, messages: WAMessage[]): void {
    const matching = [...this.watches.values()].filter(w => w.contactId === contactId);
    if (matching.length === 0) return;

    if (!this.contactReadable(contactId)) return;

    const formatted = messages
      .map(m => {
        const senderName = this.resolveSenderName(m);
        return formatMessage(m, senderName);
      })
      .map(f => {
        const ts = f.timestamp > 0
          ? new Date(f.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')
          : '';
        return `[${ts}] ${f.sender}: ${f.text}`;
      })
      .join('\n');

    for (const watch of matching) {
      const text = [
        `New WhatsApp messages in "${watch.chatName}":`,
        '',
        formatted,
        '',
        `Watch instructions: ${watch.instructions}`,
      ].join('\n');

      this.deliver(text, { replyTo: watch.target }).catch(err => {
        this.log.warn({ watchId: watch.id, err }, 'Watch delivery failed');
      });
    }
  }

  private resolveSenderName(msg: WAMessage): string {
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

  /**
   * Watch-delivery ACL. Differs from the tool-call `readDecision`: once a
   * watch has been installed (approved at install-time), subsequent deliveries
   * do not re-prompt, so `approval` mode is treated as permissive here. Only
   * 'deny' overrides or `read_mode === 'disabled'` block delivery.
   */
  private contactReadable(contactId: number): boolean {
    for (const jid of this.store.getAliasesForContact(contactId)) {
      const override = this.config.chats[jid]?.read;
      if (override === 'allow') return true;
      if (override === 'deny') return false;
    }
    return this.config.read_mode !== 'disabled';
  }

  // =========================================================================
  // Internal — persistence
  // =========================================================================

  private loadWatches(): void {
    let data: string;
    try {
      data = fs.readFileSync(this.watchesPath, 'utf-8');
    } catch {
      return;
    }

    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    if (!Array.isArray(parsed)) return;

    for (const entry of parsed) {
      const result = WatchSchema.safeParse(entry);
      if (result.success) {
        this.watches.set(result.data.id, result.data);
      }
    }

    this.log.info(`Loaded ${this.watches.size} WhatsApp watches`);
  }

  private persistWatches(): void {
    const data = [...this.watches.values()];
    try {
      fs.mkdirSync(path.dirname(this.watchesPath), { recursive: true });
      fs.writeFileSync(this.watchesPath, JSON.stringify(data, null, 2));
    } catch (err) {
      this.log.warn({ err }, 'Failed to persist watches');
    }
  }
}
