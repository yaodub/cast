/**
 * Email extension — subscription persistence and delivery layer.
 *
 * Wraps EmailWatcher with MCP-specific concerns: subscription persistence,
 * delivery formatting, participant binding, and tool handlers.
 * All IMAP, IDLE, cron, and polling logic lives in watcher.ts.
 */
import path from 'path';

import { isAllowedFolder, isInReadScope, type EmailConfig, type EmailEnvelope } from './schemas.js';
import type { ExtensionContext, Logger, ToolCallContext, ToolResult } from '@getcast/extension-schema';
import { ownsBinding, textResult } from '@getcast/extension-schema';

import { EmailWatcher } from './watcher.js';
import {
  REALTIME,
  DEFAULT_FOLDER,
  type Subscription,
  type WatchHandle,
  loadSubscriptions,
  persistSubscriptions,
  isRealtime,
} from './types.js';

/** Field-wise criteria equality — the "same watched surface" test for upsert
 *  watermark carry-over. Explicit fields, not JSON.stringify: serialization
 *  is key-order-sensitive and hides which fields participate. */
function sameCriteria(a: Subscription['criteria'], b: Subscription['criteria']): boolean {
  return a.from === b.from && a.to === b.to && a.subject === b.subject && a.body === b.body;
}

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/** The watcher surface this manager consumes — narrowed so tests can supply a
 *  structural fake without casting. */
type WatchSource = Pick<EmailWatcher, 'watch'>;

interface SubscriptionManagerOpts {
  watcher: WatchSource;
  privateDir: string;
  deliver: ExtensionContext['deliver'];
  config: EmailConfig;
  log: Logger;
}

// ---------------------------------------------------------------------------
// SubscriptionManager
// ---------------------------------------------------------------------------

export class SubscriptionManager {
  private watcher: WatchSource;
  private deliver: ExtensionContext['deliver'];
  private config: EmailConfig;
  private log: Logger;
  private subsFilePath: string;

  /** Subscription metadata + watch handle, keyed by subscription ID. */
  private entries = new Map<string, { sub: Subscription; handle: WatchHandle | null }>();

  constructor(opts: SubscriptionManagerOpts) {
    this.watcher = opts.watcher;
    this.deliver = opts.deliver;
    this.config = opts.config;
    this.log = opts.log;
    this.subsFilePath = path.join(opts.privateDir, 'subscriptions.json');
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  private started = false;

  /** Load subscriptions from disk and start watches. Called by onAgentStart. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const subs = loadSubscriptions(this.subsFilePath, this.log);

    // Sender allowlist without DKIM check is spoofable. Warn when the combination is set.
    const senderScope = this.config.inbound.senders.length > 0;
    const defaultRequireAuth = this.config.inbound.require_auth;
    for (const sub of subs) {
      if (!sub.enabled) continue;
      const effectiveRequireAuth = sub.requireAuth ?? defaultRequireAuth;
      if (senderScope && !effectiveRequireAuth) {
        this.log.warn(
          { subscriptionId: sub.id },
          'Subscription has sender scope but requireAuth is false — From-header is spoofable. Set inbound.require_auth: true.',
        );
      }
    }

    for (const sub of subs) {
      if (!sub.enabled) {
        this.entries.set(sub.id, { sub, handle: null });
        continue;
      }
      const handle = await this.startWatch(sub);
      this.entries.set(sub.id, { sub, handle });
    }
  }

  /** Stop all watches (watcher.stopAll() is called by extension). */
  stop(): void {
    // Persist final watermarks before stopping
    this.persistSubs();
    this.entries.clear();
  }

  get subscriptionCount(): number {
    return this.entries.size;
  }

  // =========================================================================
  // Tool handlers
  // =========================================================================

  async handleSubscribe(
    args: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    const schedule = args.schedule as string | undefined;
    const instructions = args.instructions as string | undefined;
    if (!schedule || !instructions) {
      return textResult('Missing required fields: schedule, instructions', true);
    }

    if (!call.participant) {
      return textResult('Subscriptions require a participant context.', true);
    }

    const folder = (args.folder as string) || undefined;
    const effectiveFolderForCheck = folder ?? DEFAULT_FOLDER;
    if (!isAllowedFolder(this.config, effectiveFolderForCheck)) {
      return textResult(`Folder "${effectiveFolderForCheck}" is not in the allowed folders list.`, true);
    }

    const fromCriterion = typeof args.from === 'string' ? args.from : undefined;
    if (fromCriterion && !isInReadScope(this.config, fromCriterion)) {
      return textResult(`Sender "${fromCriterion}" is not in the read scope.`, true);
    }

    if (schedule !== REALTIME) {
      const { Cron } = await import('croner');
      try {
        const test = new Cron(schedule);
        test.stop();
      } catch (err) {
        return textResult(
          `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    }

    const id =
      (args.id as string) ||
      `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const criteria: Subscription['criteria'] = {
      from: args.from as string | undefined,
      to: args.to as string | undefined,
      subject: args.subject as string | undefined,
      body: args.body as string | undefined,
    };

    // Explicit-id upsert. Ownership-gated: an id created by another cell is
    // taken, not overwritable (else a caller could hijack someone else's
    // binding). The superseded watch handle MUST be stopped before the map
    // entry is replaced — `entries.set` alone leaks a live IMAP watch that
    // double-fires until restart. Watermark carries over when the watched
    // surface (criteria + folder) is unchanged, so a reconciliation-style
    // blind re-subscribe never replays already-seen mail.
    const existing = this.entries.get(id);
    let carriedWatermark: number | undefined;
    if (existing) {
      if (!this.ownsEntry(existing.sub, call)) {
        return textResult(`Subscription id "${id}" is already in use.`, true);
      }
      const sameSurface = sameCriteria(existing.sub.criteria, criteria)
        && (existing.sub.folder ?? DEFAULT_FOLDER) === effectiveFolderForCheck;
      if (sameSurface) carriedWatermark = existing.handle?.watermark ?? existing.sub.watermark;
      existing.handle?.stop();
      this.entries.delete(id);
    }

    const sub: Subscription = {
      id,
      criteria,
      folder,
      // Reply binding = the calling cell, both halves host-stamped. The fire
      // returns to the conversation that subscribed (intent-cell return).
      target: call.participant,
      originChannel: call.channel,
      createdBy: call.participant,
      schedule,
      instructions,
      timezone: args.timezone as string | undefined,
      enabled: true,
      watermark: carriedWatermark ?? 0, // watcher seeds when 0
      createdAt: new Date().toISOString(),
    };

    const handle = await this.startWatch(sub);
    sub.watermark = handle.watermark; // capture seeded value
    this.entries.set(id, { sub, handle });
    this.persistSubs();

    const effectiveFolder = folder ?? DEFAULT_FOLDER;
    const scheduleDesc = schedule === REALTIME ? 'realtime (IMAP IDLE)' : `cron: ${schedule}`;
    const landing = call.channel ? `${call.participant} on channel "${call.channel}"` : call.participant;
    return textResult(
      `Subscription ${existing ? 'updated' : 'created'}:\n  ID: ${id}\n  Folder: ${effectiveFolder}\n  Schedule: ${scheduleDesc}\n  Delivers to: ${landing} (this conversation)\n  Watermark: ${sub.watermark}`,
    );
  }

  /** Ownership of a subscription's reply binding — see `ownsBinding`. */
  private ownsEntry(sub: Subscription, call: ToolCallContext): boolean {
    return ownsBinding(sub.target, call);
  }

  handleUnsubscribe(args: Record<string, unknown>, call: ToolCallContext): ToolResult {
    const id = args.id as string | undefined;
    if (!id) return textResult('Missing required field: id', true);

    const entry = this.entries.get(id);
    // Same message for missing and not-owned: existence of other cells'
    // subscriptions is not an oracle.
    if (!entry || !this.ownsEntry(entry.sub, call)) {
      return textResult(`Subscription not found: ${id}`, true);
    }

    entry.handle?.stop();
    this.entries.delete(id);
    this.persistSubs();

    return textResult(`Subscription "${id}" removed.`);
  }

  handleListSubscriptions(call: ToolCallContext): ToolResult {
    const visible = [...this.entries.values()].filter(({ sub }) => this.ownsEntry(sub, call));
    if (visible.length === 0) {
      return textResult('No email subscriptions for this conversation.');
    }

    const lines: string[] = [];
    for (const { sub, handle } of visible) {
      const scheduleDesc = isRealtime(sub) ? 'realtime' : `cron: ${sub.schedule}`;
      const status = sub.enabled ? 'active' : 'paused';
      const folder = sub.folder ?? DEFAULT_FOLDER;
      const watermark = handle?.watermark ?? sub.watermark;
      const landing = sub.originChannel ? `${sub.target} on "${sub.originChannel}"` : sub.target;
      lines.push(
        `ID: ${sub.id}\n  Folder: ${folder}\n  Schedule: ${scheduleDesc}\n  Delivers to: ${landing}\n  Status: ${status}\n  Watermark: ${watermark}\n  Created: ${sub.createdAt}\n  Criteria: ${JSON.stringify(sub.criteria)}`,
      );
    }
    return textResult(lines.join('\n\n'));
  }

  // =========================================================================
  // Watch wiring
  // =========================================================================

  /** Create a watch for a subscription, wiring delivery as the onEmails callback. */
  private async startWatch(sub: Subscription): Promise<WatchHandle> {
    return this.watcher.watch({
      folder: sub.folder,
      criteria: sub.criteria,
      schedule: sub.schedule,
      timezone: sub.timezone,
      initialWatermark: sub.watermark || undefined,
      scope: {
        senders: this.config.inbound.senders,
        blocked: this.config.inbound.blocked,
      },
      requireAuth: sub.requireAuth ?? this.config.inbound.require_auth,
      onEmails: (emails) => this.deliverEmails(sub, emails),
    });
  }

  /** Format and deliver email notification for a subscription. The fire
   *  returns to the cell that subscribed: replyTo + originChannel are the
   *  stored host-stamped binding, echoed verbatim (intent-cell return).
   *  Legacy entries without originChannel fall back to the extension's
   *  configured channel — a fire is never dropped for lack of one. */
  private deliverEmails(sub: Subscription, emails: EmailEnvelope[]): void {
    const folder = sub.folder ?? DEFAULT_FOLDER;
    const lines = [`Subscription "${sub.id}" — ${emails.length} new email(s) in ${folder}:\n`];
    for (const e of emails) {
      lines.push(`Email ID: ${e.emailId} | From: ${e.from} | Subject: ${e.subject} | Date: ${e.date}`);
    }
    lines.push('', 'Use email__fetch to download full content.', '');
    lines.push(`Instructions: ${sub.instructions}`);

    if (!sub.originChannel) {
      this.log.info(
        { subscription: sub.id },
        'Legacy subscription (no originChannel) — delivering on the configured default channel; re-create it to bind to a conversation',
      );
    }
    this.deliver(lines.join('\n'), { replyTo: sub.target, channel: sub.originChannel });

    this.log.info(
      { subscription: sub.id, newEmails: emails.length, channel: sub.originChannel },
      'Email subscription delivered',
    );
  }

  // =========================================================================
  // Persistence
  // =========================================================================

  private persistSubs(): void {
    const subs = [...this.entries.values()].map(({ sub, handle }) => ({
      ...sub,
      watermark: handle?.watermark ?? sub.watermark,
    }));
    persistSubscriptions(this.subsFilePath, subs);
  }
}
