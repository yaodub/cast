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
import { ownsBinding, textResult } from '@getcast/extension-schema';

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
  /** Reply binding, participant half: the identity of the cell that created the
   *  watch. Host-stamped at watch time (`ToolCallContext.participant`). */
  target: z.string(),
  /** Reply binding, channel half: the channel of the cell that created the
   *  watch. Host-stamped (`ToolCallContext.channel`). Absent on legacy entries —
   *  those fall back to the extension's baked channel. */
  originChannel: z.string().optional(),
  /** Provenance: who created this watch. Audit only, never routing. */
  createdBy: z.string().optional(),
  createdAt: z.string(),
});
type Watch = z.infer<typeof WatchSchema>;

// ---------------------------------------------------------------------------
// WatchManager
// ---------------------------------------------------------------------------

/** The store surface this manager consumes — narrowed so tests can supply a
 *  structural fake without casting. `resolver` is narrowed one level deeper
 *  for the same reason (only `getContact` is consumed). */
export type WatchStore = Pick<
  WhatsAppStore,
  'onNewMessages' | 'resolveQueryToContactId' | 'resolveQueryMatches'
  | 'getAliasesForContact' | 'getContactIdForJid'
> & {
  resolver: Pick<WhatsAppStore['resolver'], 'getContact'>;
};

/** The connection surface handleWatch consumes. */
type PairedProbe = Pick<ConnectionManager, 'isPaired'>;

export class WatchManager {
  private watches = new Map<string, Watch>();
  private readonly watchesPath: string;
  private deliver: ExtensionContext['deliver'];
  private log: Logger;
  private store: WatchStore;
  private config: WhatsAppConfig;

  constructor(opts: {
    privateDir: string;
    deliver: ExtensionContext['deliver'];
    log: Logger;
    store: WatchStore;
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
    connection: PairedProbe,
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

    // Explicit-id overwrite is ownership-gated: an id created by another cell
    // is taken, not overwritable. (No handle-leak concern here — watches share
    // the store's single message feed, there is nothing per-watch to stop.)
    const existing = this.watches.get(id);
    if (existing && !this.ownsWatch(existing, call)) {
      return textResult(`Watch id "${id}" is already in use.`, true);
    }

    const watch: Watch = {
      id,
      contactId,
      chatName,
      instructions,
      // Reply binding = the calling cell, both halves host-stamped. The fire
      // returns to the conversation that created the watch (intent-cell return).
      target: call.participant,
      originChannel: call.channel,
      createdBy: call.participant,
      createdAt: new Date().toISOString(),
    };

    this.watches.set(id, watch);
    this.persistWatches();

    return textResult(`Watch "${id}" ${existing ? 'updated' : 'created'} for ${chatName}. New messages will be delivered to this conversation with your instructions.`);
  }

  /** Ownership of a watch's reply binding — see `ownsBinding`. */
  private ownsWatch(watch: Watch, call: ToolCallContext): boolean {
    return ownsBinding(watch.target, call);
  }

  handleUnwatch(args: Record<string, unknown>, call: ToolCallContext): ToolResult {
    const id = String(args.id ?? '');
    const watch = this.watches.get(id);
    // Same message for missing and not-owned: existence of other cells'
    // watches is not an oracle.
    if (!watch || !this.ownsWatch(watch, call)) {
      return textResult(`Watch "${id}" not found.`, true);
    }
    this.watches.delete(id);
    this.persistWatches();
    return textResult(`Watch "${id}" removed.`);
  }

  handleListWatches(call: ToolCallContext): ToolResult {
    const visible = [...this.watches.values()].filter(w => this.ownsWatch(w, call));
    if (visible.length === 0) return textResult('No active watches for this conversation.');
    const lines = visible.map(w => {
      const landing = w.originChannel ? `${w.target} on "${w.originChannel}"` : w.target;
      return `ID: ${w.id}\n  Chat: ${w.chatName}\n  Delivers to: ${landing}\n  Instructions: ${w.instructions}\n  Created: ${w.createdAt}`;
    });
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

      // Intent-cell return: replyTo + originChannel are the stored host-stamped
      // binding, echoed verbatim. Legacy entries without originChannel fall
      // back to the extension's configured channel.
      if (!watch.originChannel) {
        this.log.info(
          { watchId: watch.id },
          'Legacy watch (no originChannel) — delivering on the configured default channel; re-create it to bind to a conversation',
        );
      }
      this.deliver(text, { replyTo: watch.target, channel: watch.originChannel }).catch(err => {
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
