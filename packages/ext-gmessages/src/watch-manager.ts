/**
 * Google Messages extension — watch manager.
 *
 * Implements the intent-cell return contract (extension-schema AUTHORING.md
 * §"Async delivery — the reply binding"): a watch stores the calling cell —
 * `participant` + `channel`, both host-stamped from `ToolCallContext` — and a
 * fire echoes that binding verbatim. The extension is a courier; it never
 * chooses a destination.
 *
 * Watches key on conversationId, which is stable and is what the push stream
 * carries. There is no local store to hook: deliveries come from the library's
 * decoded event stream via `onEvent`.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { messagesOf, createMessageTracker, STATUS_INBOUND } from 'gmessages';
import type { ClientEvent, InboundMessage, MessageEvent } from 'gmessages';

import type { ExtensionContext, Logger, ToolCallContext, ToolResult } from '@getcast/extension-schema';
import { ownsBinding, textResult } from '@getcast/extension-schema';

import type { GmessagesConfig } from './schemas.js';
import { canDeliver } from './policy.js';
import type { ConversationView } from './resolver.js';
import { renderMessage } from './render.js';

// ---------------------------------------------------------------------------
// Watch record
// ---------------------------------------------------------------------------

const WatchSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** Display label at creation time, for rendering and listings. */
  label: z.string(),
  instructions: z.string(),
  /** Reply binding, participant half. Host-stamped (`ToolCallContext.participant`). */
  target: z.string(),
  /** Reply binding, channel half. Host-stamped (`ToolCallContext.channel`).
   *  Absent on legacy entries — those fall back to the configured default. */
  originChannel: z.string().optional(),
  /** Provenance only, never routing. */
  createdBy: z.string().optional(),
  createdAt: z.string(),
  /**
   * When the watch began caring, in the wire's microseconds as a decimal string (JSON has no bigint).
   *
   * Only messages after this are news: a watch reports what arrives once it exists, not the thread's
   * back catalogue. Seeded at creation.
   */
  sinceMicros: z.string().optional(),
  /**
   * Ids already delivered, newest last, bounded.
   *
   * PERSISTED, and that is the point. The in-memory tracker collapses repeats within one process, but
   * the relay replays recent messages when the stream reconnects — so after a restart an empty
   * tracker treats the whole replay as new and the agent is notified all over again. Measured: six
   * server restarts produced six replay bursts, each about a second after the process came up.
   *
   * Ids rather than a high-water timestamp, and that distinction is not academic: two messages can
   * share a timestamp, and a `<=` against a mark silently DROPS the second one. Re-announcing a
   * message is annoying; losing one is a failure of the whole point of a watch.
   */
  deliveredIds: z.array(z.string()).optional(),
});

/** How many delivered ids to remember per watch — enough to outlast a reconnect's replay window. */
const DELIVERED_MEMORY = 200;
type Watch = z.infer<typeof WatchSchema>;

// ---------------------------------------------------------------------------

export interface WatchManagerOpts {
  privateDir: string;
  deliver: ExtensionContext['deliver'];
  log: Logger;
  config: GmessagesConfig;
  /** Resolve a query to a conversation, or report ambiguity. Supplied by the extension. */
  resolve: (query: string) => Promise<
    { match: ConversationView; ambiguous?: undefined } | { match?: undefined; ambiguous?: readonly ConversationView[] }
  >;
  /** This account's participant id, for filtering our own echoed sends. */
  ownParticipantId: () => string;
}

export class WatchManager {
  private watches = new Map<string, Watch>();
  private readonly watchesPath: string;
  private started = false;

  /**
   * Collapses the stream's repeats to one event per message.
   *
   * The relay re-sends a message as its delivery status advances — three times for a send, on the
   * traffic measured so far — and a push carries a batch, so the same id can arrive repeatedly.
   * Firing a watch per arrival delivers the same text to the agent several times. The tracker keys
   * on messageId: a first sighting yields `message`, a status move yields `delivery`, an exact
   * repeat yields null. Only the first sighting is new information, so only that fires.
   */
  private track: (message: InboundMessage) => MessageEvent | null = createMessageTracker();

  constructor(private opts: WatchManagerOpts) {
    this.watchesPath = path.join(opts.privateDir, 'watches.json');
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  start(): void {
    if (this.started) return;
    this.started = true;
    this.load();
  }

  stop(): void {
    this.started = false;
  }

  // =========================================================================
  // Stream ingress
  // =========================================================================

  /**
   * Every decoded client event. Only genuinely inbound messages, once each, reach a watch.
   *
   * Two filters, and both are load-bearing — without them one incoming text notified an agent
   * repeatedly and every message the account sent notified it too.
   *
   * DIRECTION first, positively. `STATUS_INBOUND` is the status the relay puts on a message from
   * another party; anything else is this account's own traffic, whether it left from here or from the
   * handset. Testing for inbound rather than excluding a list of outbound codes means an unrecognised
   * status is treated as not-inbound: a watch stays quiet on something it cannot classify instead of
   * announcing a message the user in fact sent. (`isOwnMessage` cannot do this job — it only catches
   * this client's own sends, and a message typed on the phone carries that conversation's participant
   * id, not this device's.)
   *
   * REPEATS second. A send progresses `sending → handed off → delivered` and each step is another
   * push of the same message id, so the relay emits several notifications per message by design.
   * The tracker keeps only the first sighting.
   */
  onEvent(event: ClientEvent): void {
    if (event.kind !== 'push') return;
    if (this.watches.size === 0) return;

    for (const message of messagesOf(event.update)) {
      if (message.statusCode !== STATUS_INBOUND) continue;
      // Tracked AFTER the direction filter, so the tracker's bounded map holds inbound ids only
      // and outbound churn cannot evict them.
      const seen = this.track(message);
      if (seen?.type !== 'message') continue;
      this.fire(message);
    }
  }

  private fire(message: InboundMessage): void {
    const matching = [...this.watches.values()].filter(
      (w) => w.conversationId === message.conversationId,
    );
    if (matching.length === 0) return;
    if (!canDeliver(this.opts.config, message.conversationId)) return;

    for (const watch of matching) {
      // Two guards, and they answer different questions. `sinceMicros` asks "did this predate the
      // watch?" — the thread's history is not news. `deliveredIds` asks "have we already sent this
      // one?" — which survives the restart the tracker does not, and, being keyed on id, does not
      // drop a second message that happens to share a timestamp with the first.
      const since = watch.sinceMicros === undefined ? 0n : BigInt(watch.sinceMicros);
      if (message.timestampMicros <= since) continue;
      const delivered = watch.deliveredIds ?? [];
      if (delivered.includes(message.messageId)) continue;
      watch.deliveredIds = [...delivered, message.messageId].slice(-DELIVERED_MEMORY);
      this.persist();

      const view: ConversationView = {
        conversationId: watch.conversationId,
        label: watch.label,
        kind: 'unknown',
        participants: [],
        isGroup: false,
      };
      const body = [
        `New Google Messages message in "${watch.label}":`,
        '',
        renderMessage(message, { ownParticipantId: this.opts.ownParticipantId(), view }),
        '',
        // The id is here because an agent receiving these could not otherwise tell a genuinely new
        // message from a redelivery of one it had already handled — it said so itself.
        `Message id: ${message.messageId}`,
        '',
        `Watch instructions: ${watch.instructions}`,
      ].join('\n');

      if (!watch.originChannel) {
        this.opts.log.info(
          { watchId: watch.id },
          'Legacy watch (no originChannel) — delivering on the configured default channel; re-create it to bind to a conversation',
        );
      }
      // Intent-cell return: the stored binding, echoed verbatim.
      this.opts
        .deliver(body, { replyTo: watch.target, channel: watch.originChannel })
        .catch((err: unknown) => {
          this.opts.log.warn({ watchId: watch.id, err }, 'Watch delivery failed');
        });
    }
  }

  // =========================================================================
  // Tool handlers
  // =========================================================================

  async handleWatch(args: Record<string, unknown>, call: ToolCallContext): Promise<ToolResult> {
    const chat = String(args.chat ?? '');
    const instructions = String(args.instructions ?? '');
    const customId = typeof args.id === 'string' ? args.id : undefined;

    if (!instructions) return textResult('Instructions are required.', true);
    if (!call.participant) return textResult('Watches require a conversation context.', true);

    const resolved = await this.opts.resolve(chat);
    if (resolved.ambiguous?.length) {
      const lines = resolved.ambiguous.map((v) => `${v.label} · ${v.conversationId}`).join('\n');
      return textResult(`Multiple conversations match "${chat}". Please specify:\n\n${lines}`, true);
    }
    if (!resolved.match) return textResult(`No conversation matching "${chat}".`, true);

    const view = resolved.match;
    // Hard-policy backstop, independent of the approval filter.
    if (!canDeliver(this.opts.config, view.conversationId)) {
      return textResult('Access to this conversation is restricted.', true);
    }

    const id = customId ?? `watch_${crypto.randomBytes(4).toString('hex')}`;
    const existing = this.watches.get(id);
    // An id owned by another cell is taken, not overwritable.
    if (existing && !ownsBinding(existing.target, call)) {
      return textResult(`Watch id "${id}" is already in use.`, true);
    }

    this.watches.set(id, {
      id,
      conversationId: view.conversationId,
      label: view.label,
      instructions,
      target: call.participant,
      ...(call.channel !== undefined ? { originChannel: call.channel } : {}),
      createdBy: call.participant,
      createdAt: new Date().toISOString(),
      // Seeded to NOW, so a freshly created watch does not immediately announce the thread's existing
      // history. `timestampMicros` is the wire's unit, so the mark has to be in it too.
      sinceMicros: (BigInt(Date.now()) * 1000n).toString(),
      deliveredIds: [],
    });
    this.persist();

    return textResult(
      `Watch "${id}" ${existing ? 'updated' : 'created'} for ${view.label}. New messages will be delivered to this conversation with your instructions.`,
    );
  }

  handleUnwatch(args: Record<string, unknown>, call: ToolCallContext): ToolResult {
    const id = String(args.id ?? '');
    const watch = this.watches.get(id);
    // Same message for missing and not-owned: another cell's watches are not
    // discoverable by probing ids.
    if (!watch || !ownsBinding(watch.target, call)) {
      return textResult(`Watch "${id}" not found.`, true);
    }
    this.watches.delete(id);
    this.persist();
    return textResult(`Watch "${id}" removed.`);
  }

  handleListWatches(call: ToolCallContext): ToolResult {
    const visible = [...this.watches.values()].filter((w) => ownsBinding(w.target, call));
    if (visible.length === 0) return textResult('No active watches for this conversation.');
    return textResult(
      visible
        .map((w) => {
          const landing = w.originChannel ? `${w.target} on "${w.originChannel}"` : w.target;
          return `ID: ${w.id}\n  Conversation: ${w.label}\n  Delivers to: ${landing}\n  Instructions: ${w.instructions}\n  Created: ${w.createdAt}`;
        })
        .join('\n\n'),
    );
  }

  // =========================================================================
  // Persistence
  // =========================================================================

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.watchesPath, 'utf-8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      const result = WatchSchema.safeParse(entry);
      if (result.success) this.watches.set(result.data.id, result.data);
    }
    this.opts.log.info(`Loaded ${this.watches.size} Google Messages watches`);
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.watchesPath), { recursive: true });
      fs.writeFileSync(this.watchesPath, JSON.stringify([...this.watches.values()], null, 2));
    } catch (err) {
      this.opts.log.warn({ err }, 'Failed to persist watches');
    }
  }
}
