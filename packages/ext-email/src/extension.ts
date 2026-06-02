/**
 * Email extension — main class.
 *
 * Orchestrates tools, prompt, handle dispatch, and lifecycle.
 * Delegates watching to EmailWatcher, subscriptions to SubscriptionManager,
 * and stateless operations to client.ts.
 *
 * Approval is enforced on email__search / email__subscribe / email__send via
 * the framework's approval block. email__fetch has no approval — IDs are
 * expected to have come from an already-approved search; handler still
 * validates envelope sender against scope as defense-in-depth.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import {
  EmailSearchRequestSchema,
  EmailSendRequestSchema,
  isAllowedFolder,
  isInReadScope,
  readDecision,
  readDefaultDecision,
  sendDecision,
  type EmailConfig,
  type EmailSecrets,
  type EmailSearchRequest,
  type EmailSearchResult,
  type EmailSendRequest,
  type EmailSendResult,
  type EmailReadRequest,
  type EmailReadResult,
  type EmailFetchResult,
} from './schemas.js';

import type {
  ExtensionContext,
  ExtensionInstance,
  Logger,
  ToolCallContext,
  ToolDefinition,
  ToolResult,
} from '@getcast/extension-schema';
import { noopLogger, textResult } from '@getcast/extension-schema';

import { formatEnvelopes, formatSidecar, listFolders, type FolderInfo } from './helpers.js';
import { searchEmails, sendEmail, readEmail } from './client.js';
import { EmailWatcher } from './watcher.js';
import { SubscriptionManager } from './subscription-manager.js';
import type { WatchOptions, WatchHandle } from './types.js';

// ---------------------------------------------------------------------------
// Extension class
// ---------------------------------------------------------------------------

export class EmailExtension implements ExtensionInstance {
  readonly name = 'email';
  private config: EmailConfig;
  private secrets: EmailSecrets;
  private log: Logger;
  private hasChannel: boolean;
  private watcher: EmailWatcher;
  private subs: SubscriptionManager;

  constructor(ctx: ExtensionContext<EmailConfig, EmailSecrets>) {
    this.config = ctx.config;
    this.secrets = ctx.secrets;
    this.log = ctx.log ?? noopLogger;
    this.hasChannel = ctx.hasChannel;
    this.watcher = new EmailWatcher(ctx.secrets, this.log);
    this.subs = new SubscriptionManager({
      watcher: this.watcher,
      privateDir: ctx.privateDir,
      deliver: ctx.deliver,
      config: this.config,
      log: this.log,
    });
  }

  // =========================================================================
  // Tools + prompt
  // =========================================================================

  get tools(): ToolDefinition[] {
    const readGate = this.config.inbound.default !== 'enabled';
    const sendGate = this.config.outbound.default !== 'enabled';

    const searchFilter = (args: Record<string, unknown>): 'approve' | 'skip' | 'block' => {
      const from = typeof args.from === 'string' ? args.from : '';
      const folder = typeof args.folder === 'string' ? args.folder : 'INBOX';
      if (!isAllowedFolder(this.config, folder)) return 'block';
      return from ? readDecision(this.config, from) : readDefaultDecision(this.config);
    };

    const sendFilter = (args: Record<string, unknown>): 'approve' | 'skip' | 'block' => {
      const to = typeof args.to === 'string' ? args.to : '';
      return to ? sendDecision(this.config, to) : 'block';
    };

    const tools: ToolDefinition[] = [
      {
        name: 'email__search',
        description: `Search emails via IMAP. Returns envelope summaries (ID, from, to, subject, date, snippet). Use email__fetch to download full content.\n\nSearch is scoped to the last ${this.config.inbound.window_days} days.`,
        schema: {
          from: z.string().optional().describe('Filter by sender address'),
          to: z.string().optional().describe('Filter by recipient address'),
          subject: z
            .string()
            .optional()
            .describe('Filter by subject (substring match)'),
          body: z.string().optional().describe('Filter by body content'),
          folder: z
            .string()
            .optional()
            .describe('IMAP folder (default: INBOX)'),
        },
        approval: readGate ? {
          enabled: true,
          preview: (args) => {
            const parts: string[] = [];
            if (typeof args.from === 'string' && args.from) parts.push(`from ${args.from}`);
            if (typeof args.subject === 'string' && args.subject) parts.push(`subject "${args.subject}"`);
            if (typeof args.folder === 'string' && args.folder) parts.push(`in ${args.folder}`);
            const criteria = parts.length > 0 ? parts.join(', ') : `last ${this.config.inbound.window_days} days`;
            return { summary: `Search emails: ${criteria}` };
          },
          filter: searchFilter,
        } : undefined,
      },
      {
        name: 'email__fetch',
        description:
          'Download emails to staging. Writes .md (parsed text with headers, attachment summary, image stats) and .eml (raw MIME) per email. Use Read to access .md files. Use .eml for raw MIME / attachments.',
        schema: {
          ids: z
            .array(z.string())
            .optional()
            .describe('Email IDs to fetch (batch)'),
          emailId: z
            .string()
            .optional()
            .describe('Single email ID (alternative to ids)'),
          folder: z
            .string()
            .optional()
            .describe('IMAP folder (default: INBOX)'),
        },
      },
      {
        name: 'email__send',
        description: `Compose and send an email.`,
        schema: {
          to: z.string().describe('Recipient email address'),
          subject: z.string().describe('Email subject'),
          body: z.string().describe('Plain text email body'),
          replyToMessageId: z
            .string()
            .optional()
            .describe(
              'RFC Message-ID to reply to (from a previous email__fetch result)',
            ),
        },
        approval: sendGate ? {
          enabled: true,
          preview: (args) => ({
            summary: `Send email to ${typeof args.to === 'string' ? args.to : '(missing recipient)'}`,
            details: typeof args.subject === 'string' ? `Subject: ${args.subject}` : undefined,
          }),
          filter: sendFilter,
        } : undefined,
      },
      {
        name: 'email__list_folders',
        description: 'List all available IMAP mailbox folders.',
        schema: {},
      },
    ];

    if (this.hasChannel) {
      tools.push(
        {
          name: 'email__subscribe',
          description:
            'Watch for new emails matching criteria. Notifications are processed on a dedicated channel and delegated to you. Subscriptions persist across conversations.',
          schema: {
            schedule: z
              .string()
              .describe(
                'Schedule: "realtime" for IMAP IDLE push, or cron expression (e.g. "*/15 * * * *")',
              ),
            instructions: z
              .string()
              .describe('Instructions for the agent when matching emails arrive'),
            from: z.string().optional().describe('Filter by sender address'),
            subject: z.string().optional().describe('Filter by subject'),
            folder: z
              .string()
              .optional()
              .describe('IMAP folder to watch (default: INBOX)'),
            id: z
              .string()
              .optional()
              .describe('Custom subscription ID (auto-generated if omitted)'),
            timezone: z
              .string()
              .optional()
              .describe(
                'IANA timezone for cron schedule (defaults to agent timezone)',
              ),
          },
          approval: readGate ? {
            enabled: true,
            preview: (args) => {
              const folder = typeof args.folder === 'string' ? args.folder : 'INBOX';
              const criteria: string[] = [];
              if (typeof args.from === 'string' && args.from) criteria.push(`from ${args.from}`);
              if (typeof args.subject === 'string' && args.subject) criteria.push(`subject "${args.subject}"`);
              const criteriaStr = criteria.length > 0 ? criteria.join(', ') : 'any matching mail';
              const schedule = typeof args.schedule === 'string' ? args.schedule : 'realtime';
              return {
                summary: `Subscribe to ${folder}: ${criteriaStr} (${schedule})`,
                details: typeof args.instructions === 'string' ? `Instructions: ${args.instructions}` : undefined,
              };
            },
            filter: (args) => {
              const folder = typeof args.folder === 'string' ? args.folder : 'INBOX';
              if (!isAllowedFolder(this.config, folder)) return 'block';
              const from = typeof args.from === 'string' ? args.from : '';
              return from ? readDecision(this.config, from) : readDefaultDecision(this.config);
            },
          } : undefined,
        },
        {
          name: 'email__unsubscribe',
          description: 'Remove an email subscription.',
          schema: {
            id: z.string().describe('Subscription ID to remove'),
          },
        },
        {
          name: 'email__list_subscriptions',
          description: 'List all email subscriptions and their status.',
          schema: {},
        },
      );
    }

    return tools;
  }

  get promptSection(): string {
    const { inbound, outbound } = this.config;
    const lines = [
      '## Email',
      '',
      'Use `email__search` to find emails (returns envelope summaries inline). Use `email__fetch` to download full content to staging.',
      `- Search is scoped to the last ${inbound.window_days} days, capped at ${inbound.max_results} results.`,
      '- `email__fetch` writes `.md` (headers + body text + image stats + attachment summary) and `.eml` (raw MIME) to `/staging/in/`.',
      '- Use `Read` to access `.md` files. Use `.eml` for raw MIME, attachments, or cleaning scripts.',
      '- Files in `/staging/in/` are ephemeral — cleared when the conversation ends. Copy to `/memory/` if needed long-term.',
      '- `email__list_folders` shows available IMAP folders.',
    ];

    if (inbound.senders.length > 0) {
      lines.push(`- Visible senders: ${inbound.senders.join(', ')}`);
    }
    if (inbound.folders.length > 0) {
      lines.push(`- Visible folders: ${inbound.folders.join(', ')}`);
    }

    const readLabel = inbound.default;
    if (readLabel === 'disabled') {
      lines.push('- Reading is **disabled**.');
    } else if (readLabel === 'approval') {
      lines.push('- Searching requires **user approval** unless the sender is pre-authorized.');
    } else {
      lines.push('- Searching is **enabled** (no approval required).');
    }

    const sendLabel = outbound.default;
    if (sendLabel === 'disabled') {
      lines.push('- Email sending is **disabled**.');
    } else if (sendLabel === 'approval') {
      lines.push('- Sending requires **user approval** unless the recipient is pre-authorized.');
    } else {
      lines.push('- Sending is **enabled** (no approval required).');
    }
    if (outbound.recipients.length > 0) {
      lines.push(`- Allowed recipients: ${outbound.recipients.join(', ')}`);
    }

    lines.push(
      '- To reply, pass the `messageId` from `email__fetch` as `replyToMessageId` in `email__send`.',
    );
    if (this.hasChannel) {
      lines.push(
        '- Use `email__subscribe` to watch for new emails. Supports `"realtime"` (IMAP IDLE) or cron schedules. Optional `folder` param.',
        '- Subscription notifications include email IDs — use `email__fetch` with those IDs to download full content.',
        '- Subscriptions persist across conversations. Use `email__list_subscriptions` to see active watches.',
      );
    } else {
      lines.push(
        '- Email subscriptions are not available — no processing channel is configured for this agent.',
      );
    }
    return lines.join('\n');
  }

  // =========================================================================
  // MCP tool handler (policy enforcement + dispatch)
  // =========================================================================

  async handle(
    toolName: string,
    args: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    switch (toolName) {
      case 'email__search':
        return this.handleSearch(args);
      case 'email__fetch':
        return this.handleFetch(args, call);
      case 'email__send':
        return this.handleSend(args);
      case 'email__list_folders':
        return this.handleListFolders();
      case 'email__subscribe':
        return this.subs.handleSubscribe(args, call);
      case 'email__unsubscribe':
        return this.subs.handleUnsubscribe(args);
      case 'email__list_subscriptions':
        return this.subs.handleListSubscriptions();
      default:
        return textResult(`Unknown tool: ${toolName}`, true);
    }
  }

  // =========================================================================
  // MCP tool handlers
  // =========================================================================

  private async handleSearch(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const parsed = EmailSearchRequestSchema.safeParse(args);
    if (!parsed.success) {
      return textResult(
        `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
        true,
      );
    }

    const folder = parsed.data.folder ?? 'INBOX';
    if (!isAllowedFolder(this.config, folder)) {
      return textResult(`Folder "${folder}" is not in the allowed folders list.`, true);
    }

    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - this.config.inbound.window_days);
    const req = { ...parsed.data };
    if (!req.since || new Date(req.since) < windowStart) {
      req.since = windowStart.toISOString();
    }
    req.limit = Math.min(
      req.limit ?? this.config.inbound.max_results,
      this.config.inbound.max_results,
    );

    try {
      const result = await this.search(req);
      const text = formatEnvelopes(result.emails);
      return textResult(
        result.total > result.emails.length
          ? `${text}\n\n(Showing ${result.emails.length} of ${result.total} matches)`
          : text,
      );
    } catch (err) {
      this.log.warn({ err }, 'email__search failed');
      return textResult(
        `Search failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  }

  private async handleFetch(
    args: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    const ids: string[] = Array.isArray(args.ids)
      ? (args.ids as string[])
      : typeof args.emailId === 'string'
        ? [args.emailId]
        : [];
    const folder = typeof args.folder === 'string' ? args.folder : undefined;

    if (ids.length === 0) {
      return textResult('Missing required field: ids or emailId', true);
    }

    if (folder !== undefined && !isAllowedFolder(this.config, folder)) {
      return textResult(`Folder "${folder}" is not in the allowed folders list.`, true);
    }

    try {
      const results: EmailFetchResult[] = [];
      const rejected: { id: string; reason: string }[] = [];
      for (const id of ids) {
        try {
          const preRead = await this.read({ emailId: id, folder });
          if (!isInReadScope(this.config, preRead.from)) {
            rejected.push({ id, reason: `sender ${preRead.from} is not in read scope` });
            continue;
          }
          const result = await this.fetchToDir(id, call.stagingDir, { folder, preRead });
          results.push(result);
        } catch (err) {
          rejected.push({ id, reason: err instanceof Error ? err.message : String(err) });
        }
      }

      const lines: string[] = [];
      if (results.length > 0) {
        lines.push(`Fetched ${results.length} email(s) to /staging/in/`);
        for (const r of results) {
          const mdFile = path.basename(r.mdPath);
          const emlFile = path.basename(r.emlPath);
          lines.push(`  ID: ${r.emailId} | From: ${r.from} | Subject: ${r.subject}`);
          lines.push(`    ${mdFile}, ${emlFile}`);
        }
        lines.push('', 'Use Read to access .md files. Use .eml for raw MIME / attachments.');
      }
      if (rejected.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(`Rejected ${rejected.length} email(s):`);
        for (const r of rejected) lines.push(`  ID: ${r.id} — ${r.reason}`);
      }
      const isError = results.length === 0;
      return textResult(lines.join('\n'), isError);
    } catch (err) {
      this.log.warn({ err }, 'email__fetch failed');
      return textResult(
        `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  }

  private async handleSend(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = EmailSendRequestSchema.safeParse(args);
    if (!parsed.success) {
      return textResult(
        `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
        true,
      );
    }

    if (this.config.outbound.default === 'disabled') {
      return textResult('Email sending is disabled for this agent.', true);
    }

    try {
      const result = await this.send(parsed.data);
      if (!result.ok) {
        return textResult(`Send failed: ${result.error}`, true);
      }
      return textResult(`Email sent. Message-ID: ${result.messageId}`);
    } catch (err) {
      this.log.warn({ err }, 'email__send failed');
      return textResult(
        `Send failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  }

  private async handleListFolders(): Promise<ToolResult> {
    try {
      const folders = await this.listFolders();
      const filtered = this.config.inbound.folders.length === 0
        ? folders
        : folders.filter((f) => this.config.inbound.folders.includes(f.path));
      if (filtered.length === 0) return textResult('No folders found.');
      const lines = filtered.map((f) => {
        const suffix = f.specialUse ? ` (${f.specialUse})` : '';
        return f.name === f.path ? `${f.path}${suffix}` : `${f.path} — ${f.name}${suffix}`;
      });
      return textResult(lines.join('\n'));
    } catch (err) {
      this.log.warn({ err }, 'email__list_folders failed');
      return textResult(
        `Failed to list folders: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async onAgentStart(): Promise<void> {
    return this.subs.start();
  }

  onAgentStop(): void {
    this.subs.stop();
    this.watcher.stopAll();
  }

  // =========================================================================
  // Public service API
  // =========================================================================

  /** Search emails. Returns typed result — no file I/O. */
  search(req: EmailSearchRequest): Promise<EmailSearchResult> {
    return searchEmails(this.secrets, req, this.config);
  }

  /** Send an email. No file I/O. */
  send(req: EmailSendRequest): Promise<EmailSendResult> {
    return sendEmail(this.secrets, req);
  }

  /** Read a full email. Returns typed result with rawSource buffer. No file I/O. */
  read(req: EmailReadRequest): Promise<EmailReadResult> {
    return readEmail(this.secrets, req);
  }

  /** List available IMAP mailbox folders. */
  listFolders(): Promise<FolderInfo[]> {
    return listFolders(this.secrets);
  }

  /** Start watching a folder for new emails. Returns a handle to stop and read watermark. */
  watch(opts: WatchOptions): Promise<WatchHandle> {
    return this.watcher.watch(opts);
  }

  /**
   * Fetch an email and write .md sidecar + .eml to a directory.
   * Shared code path for MCP handler and agent services.
   * Pass `preRead` to skip a redundant IMAP roundtrip when the caller has already
   * read the message (e.g., to perform an upstream scope check).
   */
  async fetchToDir(
    emailId: string,
    dir: string,
    opts?: { folder?: string; preRead?: EmailReadResult },
  ): Promise<EmailFetchResult> {
    const result = opts?.preRead ?? await this.read({ emailId, folder: opts?.folder });

    const hash = createHash('sha256').update(result.emailId).digest('hex').slice(0, 12);
    fs.mkdirSync(dir, { recursive: true });

    const mdFilename = `email_${hash}.md`;
    const emlFilename = `email_${hash}.eml`;
    const mdPath = path.join(dir, mdFilename);
    const emlPath = path.join(dir, emlFilename);

    const sidecar = formatSidecar({
      from: result.from,
      to: result.to,
      cc: result.cc,
      date: result.date,
      subject: result.subject,
      messageId: result.messageId,
      text: result.text,
      html: result.html,
      attachments: result.attachments,
    });
    fs.writeFileSync(mdPath, sidecar);
    fs.writeFileSync(emlPath, result.rawSource);

    return {
      emailId: result.emailId,
      messageId: result.messageId,
      from: result.from,
      to: result.to,
      subject: result.subject,
      date: result.date,
      mdPath,
      emlPath,
      attachments: result.attachments,
    };
  }
}
