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
import { textResult } from '@getcast/extension-schema';

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

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

interface SubscriptionManagerOpts {
  watcher: EmailWatcher;
  privateDir: string;
  deliver: ExtensionContext['deliver'];
  config: EmailConfig;
  log: Logger;
}

// ---------------------------------------------------------------------------
// SubscriptionManager
// ---------------------------------------------------------------------------

export class SubscriptionManager {
  private watcher: EmailWatcher;
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

    const sub: Subscription = {
      id,
      criteria: {
        from: args.from as string | undefined,
        to: args.to as string | undefined,
        subject: args.subject as string | undefined,
        body: args.body as string | undefined,
      },
      folder,
      target: call.participant,
      schedule,
      instructions,
      timezone: args.timezone as string | undefined,
      enabled: true,
      watermark: 0, // watcher will seed
      createdAt: new Date().toISOString(),
    };

    const handle = await this.startWatch(sub);
    sub.watermark = handle.watermark; // capture seeded value
    this.entries.set(id, { sub, handle });
    this.persistSubs();

    const effectiveFolder = folder ?? DEFAULT_FOLDER;
    const scheduleDesc = schedule === REALTIME ? 'realtime (IMAP IDLE)' : `cron: ${schedule}`;
    return textResult(
      `Subscription created:\n  ID: ${id}\n  Folder: ${effectiveFolder}\n  Schedule: ${scheduleDesc}\n  Target: ${call.participant}\n  Watermark: ${sub.watermark}`,
    );
  }

  handleUnsubscribe(args: Record<string, unknown>): ToolResult {
    const id = args.id as string | undefined;
    if (!id) return textResult('Missing required field: id', true);

    const entry = this.entries.get(id);
    if (!entry) return textResult(`Subscription not found: ${id}`, true);

    entry.handle?.stop();
    this.entries.delete(id);
    this.persistSubs();

    return textResult(`Subscription "${id}" removed.`);
  }

  handleListSubscriptions(): ToolResult {
    if (this.entries.size === 0) {
      return textResult('No email subscriptions.');
    }

    const lines: string[] = [];
    for (const { sub, handle } of this.entries.values()) {
      const scheduleDesc = isRealtime(sub) ? 'realtime' : `cron: ${sub.schedule}`;
      const status = sub.enabled ? 'active' : 'paused';
      const folder = sub.folder ?? DEFAULT_FOLDER;
      const watermark = handle?.watermark ?? sub.watermark;
      lines.push(
        `ID: ${sub.id}\n  Folder: ${folder}\n  Schedule: ${scheduleDesc}\n  Target: ${sub.target}\n  Status: ${status}\n  Watermark: ${watermark}\n  Created: ${sub.createdAt}\n  Criteria: ${JSON.stringify(sub.criteria)}`,
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

  /** Format and deliver email notification for a subscription. */
  private deliverEmails(sub: Subscription, emails: EmailEnvelope[]): void {
    const folder = sub.folder ?? DEFAULT_FOLDER;
    const lines = [`Subscription "${sub.id}" — ${emails.length} new email(s) in ${folder}:\n`];
    for (const e of emails) {
      lines.push(`Email ID: ${e.emailId} | From: ${e.from} | Subject: ${e.subject} | Date: ${e.date}`);
    }
    lines.push('', 'Use email__fetch to download full content.', '');
    lines.push(`Instructions: ${sub.instructions}`);

    this.deliver(lines.join('\n'), { replyTo: sub.target });

    this.log.info(
      { subscription: sub.id, newEmails: emails.length },
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
