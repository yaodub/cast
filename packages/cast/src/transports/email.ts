/**
 * Email transport — generic IMAP/SMTP.
 *
 * Each configured email route gets one persistent IMAP IDLE connection
 * (inbound) and one nodemailer SMTP transporter (outbound).
 * Works with any provider (Gmail, Fastmail, Migadu, self-hosted).
 *
 * Threading state and UID watermarks are stored in a transport-owned
 * SQLite DB at `CONFIG_DIR/transport-email.db`.
 */
import Database from 'better-sqlite3';
import { ImapFlow } from 'imapflow';
import type { ParsedMail } from 'mailparser';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

import fs from 'fs';

import { z } from 'zod';

import { verifyMessage } from '@getcast/ext-email';

import type { BusAddress } from '../auth/address.js';
import { decodeAddressValue, encodeAddressValue } from '../auth/address.js';
import { MAX_ATTACHMENT_BYTES, CONFIG_DIR } from '../config.js';
import { queryOne } from '../lib/db-query.js';
import type { AnyPacket } from '../gateway/packets.js';
import type { ApprovalRequestPkt } from '../types.js';
import type { Attachment, Evt } from '../types.js';
import { defineTransport } from './schema.js';
import { isDeliverablePacket } from './packet-dispatch.js';
import type { OutboundContext, Transport, TransportContext } from './schema.js';

// ---------------------------------------------------------------------------
// Config schema (replaces EmailRoute from gateway/routes.ts)
// ---------------------------------------------------------------------------

export const EmailRouteSchema = z.object({
  address: z.string(),
  channel: z.string().optional(),
  email: z.string(),
  whitelist: z.array(z.string()).optional(),
  /** Drop inbound mail unless DKIM/DMARC alignment with the From-domain holds. */
  requireAuth: z.boolean().optional(),
  imap: z.object({
    host: z.string(),
    port: z.number().default(993),
    user: z.string(),
    pass: z.string(),
    tls: z.boolean().default(true),
  }),
  smtp: z.object({
    host: z.string(),
    port: z.number().default(465),
    user: z.string(),
    pass: z.string(),
    secure: z.boolean().default(true),
  }),
});
export type EmailRoute = z.infer<typeof EmailRouteSchema>;

const EmailConfigSchema = z.array(EmailRouteSchema).default([]);
type EmailConfig = z.infer<typeof EmailConfigSchema>;

/** Route after `address` has been canonicalised through the bus. */
type EmailBinding = Omit<EmailRoute, 'address'> & { address: BusAddress };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type IdleState =
  | { status: 'stopped' }
  | { status: 'connecting'; attempt: number }
  | { status: 'connected'; client: ImapFlow }
  | { status: 'closing' };

const WatermarkRow = z.object({ uid: z.number() });

const ThreadRow = z.object({
  message_id: z.string(),
  subject: z.string().nullable(),
});
type ThreadRow = z.infer<typeof ThreadRow>;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function openDb(): Database.Database {
  const dbPath = `${CONFIG_DIR}/transport-email.db`;
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS watermarks (
      connection_key TEXT PRIMARY KEY,
      uid            INTEGER NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      sender_handle  TEXT NOT NULL,
      agent_address  TEXT NOT NULL,
      message_id     TEXT NOT NULL,
      subject        TEXT,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (sender_handle, agent_address)
    );
    CREATE TABLE IF NOT EXISTS approval_threads (
      message_id    TEXT PRIMARY KEY,
      approval_id   TEXT NOT NULL,
      agent_address TEXT NOT NULL,
      participant   TEXT NOT NULL
    );
  `);
  return db;
}

// ---------------------------------------------------------------------------
// EmailConnection — per-route IMAP IDLE + SMTP
// ---------------------------------------------------------------------------

class EmailConnection {
  readonly agentAddress: BusAddress;
  readonly agentEmail: string;
  readonly channel: string | undefined;

  private route: EmailBinding;
  private ctx: TransportContext;
  private db: Database.Database;
  private transporter: nodemailer.Transporter;
  private whitelist: string[] | undefined;

  private idleState: IdleState = { status: 'stopped' };

  private saveWatermark(): void {
    this.db
      .prepare('INSERT OR REPLACE INTO watermarks (connection_key, uid, updated_at) VALUES (?, ?, ?)')
      .run(this.agentEmail, this.uid, new Date().toISOString());
  }
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private uid = 0;
  private needsWatermarkSeed = false;
  private alive = false;

  constructor(route: EmailBinding, ctx: TransportContext, db: Database.Database) {
    this.route = route;
    this.ctx = ctx;
    this.db = db;
    this.agentAddress = route.address;
    this.agentEmail = route.email;
    this.channel = route.channel;
    this.whitelist = route.whitelist;

    this.transporter = nodemailer.createTransport({
      host: route.smtp.host,
      port: route.smtp.port,
      secure: route.smtp.secure,
      auth: { user: route.smtp.user, pass: route.smtp.pass },
    });

    // Load watermark from DB — if no watermark exists, seed on first connect
    const row = queryOne(
      db.prepare('SELECT uid FROM watermarks WHERE connection_key = ?'),
      WatermarkRow,
      route.email,
    );
    if (row) {
      this.uid = row.uid;
    } else {
      this.needsWatermarkSeed = true;
    }
  }

  get isAlive(): boolean {
    return this.alive;
  }

  // --- IMAP IDLE ---

  async start(): Promise<void> {
    await this.connectIdle();
  }

  stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.idleState.status === 'connected') {
      const { client } = this.idleState;
      this.idleState = { status: 'closing' };
      client.close();
    } else {
      this.idleState = { status: 'stopped' };
    }
    this.alive = false;
  }

  private async connectIdle(attempt = 0): Promise<void> {
    if (this.idleState.status !== 'stopped') return;
    this.idleState = { status: 'connecting', attempt };

    const client = new ImapFlow({
      host: this.route.imap.host,
      port: this.route.imap.port,
      secure: this.route.imap.tls,
      auth: { user: this.route.imap.user, pass: this.route.imap.pass },
      logger: false,
      maxIdleTime: 25 * 60 * 1000, // Re-issue IDLE before typical 29min timeout
    });

    try {
      await client.connect();

      // stop() may have been called while connect() was in flight
      if (this.idleState.status !== 'connecting') {
        client.close();
        return;
      }

      const mailbox = await client.mailboxOpen('INBOX');

      // First-run: seed watermark to current highest UID so we only process new mail
      if (this.needsWatermarkSeed) {
        this.uid = mailbox.uidNext - 1;
        this.saveWatermark();
        this.needsWatermarkSeed = false;
        this.ctx.log.info({ email: this.agentEmail, uid: this.uid }, 'Email watermark seeded (first run)');
      }

      client.on('exists', () => this.handleExists(client));
      client.on('close', () => this.handleDisconnect());
      this.idleState = { status: 'connected', client };
      this.alive = true;
      this.ctx.log.info({ email: this.agentEmail }, 'Email IDLE connection established');

      // Catch up from watermark after reconnect
      if (attempt > 0) {
        await this.fetchNew(client);
      }
    } catch (err) {
      this.idleState = { status: 'stopped' };
      const delay = Math.min(1000 * 2 ** attempt, 60_000);
      this.ctx.log.warn({ email: this.agentEmail, err, delay }, 'Email IDLE connect failed, retrying');
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connectIdle(attempt + 1).catch((e) => {
          this.ctx.log.error({ email: this.agentEmail, err: e }, 'Email IDLE reconnect failed');
        });
      }, delay);
    }
  }

  private handleExists(client: ImapFlow): void {
    if (this.idleState.status !== 'connected') return;
    this.fetchNew(client).catch((err) => {
      this.ctx.log.warn({ email: this.agentEmail, err }, 'Email fetch failed after EXISTS');
    });
  }

  private handleDisconnect(): void {
    if (this.idleState.status === 'closing') {
      this.idleState = { status: 'stopped' };
      return;
    }
    const attempt = this.idleState.status === 'connecting' ? this.idleState.attempt : 0;
    this.idleState = { status: 'stopped' };
    this.alive = false;
    const delay = Math.min(1000 * 2 ** attempt, 60_000);
    this.ctx.log.warn({ email: this.agentEmail, delay }, 'Email IDLE disconnected, reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectIdle(attempt + 1).catch((err) => {
        this.ctx.log.error({ email: this.agentEmail, err }, 'Email IDLE reconnect failed');
      });
    }, delay);
  }

  // --- Fetch new messages ---

  private async fetchNew(client: ImapFlow): Promise<void> {
    // Fetch messages with UID > watermark
    const range = this.uid > 0 ? `${this.uid + 1}:*` : '1:*';
    let maxUid = this.uid;

    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
          if (msg.uid <= this.uid) continue; // Skip already-processed
          if (msg.uid > maxUid) maxUid = msg.uid;

          if (msg.source) {
            await this.processMessage(msg.source);
          }
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      this.ctx.log.warn({ email: this.agentEmail, err }, 'Email FETCH failed');
      return;
    }

    if (maxUid > this.uid) {
      this.uid = maxUid;
      this.saveWatermark();
    }
  }

  private async processMessage(source: Buffer): Promise<void> {
    let parsed: ParsedMail;
    try {
      parsed = await simpleParser(source);
    } catch (err) {
      this.ctx.log.warn({ email: this.agentEmail, err }, 'Email parse failed');
      return;
    }

    const fromAddr = parsed.from?.value[0]?.address;
    if (!fromAddr) return;

    // Skip messages from self (agent's own outbound replies)
    if (fromAddr.toLowerCase() === this.agentEmail.toLowerCase()) return;

    // DKIM/DMARC alignment check — drop mail whose visible From cannot be authenticated.
    // Defends against the spoofed-paired-user scenario where an attacker forges From to
    // inherit a paired identity's ACL bits. Only applies when the route opts in.
    if (this.route.requireAuth) {
      try {
        const verdict = await verifyMessage(source);
        if (!verdict.pass) {
          this.ctx.log.warn(
            { email: this.agentEmail, from: fromAddr, fromDomain: verdict.fromDomain, reason: verdict.reason },
            'Email failed authentication, dropping',
          );
          return;
        }
      } catch (err) {
        this.ctx.log.warn(
          { email: this.agentEmail, from: fromAddr, err },
          'Email authentication threw, dropping (fail-closed)',
        );
        return;
      }
    }

    // Whitelist check — if configured, only allow matching senders
    if (this.whitelist && this.whitelist.length > 0 && !matchesWhitelist(fromAddr, this.whitelist)) {
      this.ctx.log.debug({ email: this.agentEmail, from: fromAddr }, 'Email sender not in whitelist, dropping');
      return;
    }

    const senderHandle = `email:${encodeAddressValue(fromAddr)}`;
    const senderName = parsed.from?.value[0]?.name || fromAddr;

    // Check if this is a reply to an approval email
    if (parsed.inReplyTo) {
      const approvalThread = this.db.prepare(
        'SELECT approval_id, agent_address, participant FROM approval_threads WHERE message_id = ?',
      ).get(parsed.inReplyTo) as { approval_id: string; agent_address: string; participant: string } | undefined;

      if (approvalThread) {
        // Verify From matches the participant the approval was originally sent to —
        // an unauthorized replier who learned the Message-ID (forwarded mail, leaked
        // archive) must not be able to approve on the recipient's behalf. This does
        // not defend against full From-header spoofing — that requires DKIM/SPF.
        const expectedAddr = approvalThread.participant.startsWith('email:')
          ? decodeAddressValue(approvalThread.participant.slice('email:'.length))
          : null;
        if (!expectedAddr || expectedAddr.toLowerCase() !== fromAddr.toLowerCase()) {
          this.ctx.log.warn(
            { email: this.agentEmail, from: fromAddr, expected: approvalThread.participant },
            'Approval reply From does not match recipient, dropping',
          );
          return;
        }

        const replyBody = (parsed.text || '').trim().toLowerCase();
        const isApprove = /^approve/i.test(replyBody);
        const isReject = /^reject/i.test(replyBody);
        if (isApprove || isReject) {
          const reason = replyBody.replace(/^(approve|reject)\s*/i, '').trim() || undefined;
          this.ctx.ingestApprovalResponse(
            approvalThread.participant,
            approvalThread.agent_address,
            { id: approvalThread.approval_id, decision: isApprove ? 'approved' : 'rejected', reason },
          );
          this.db.prepare('DELETE FROM approval_threads WHERE message_id = ?').run(parsed.inReplyTo);
          return;
        }
        // Non-approve/reject reply to approval thread — fall through to normal processing
      }
    }

    // Extract attachments (skip oversized files)
    const attachments: Attachment[] = (parsed.attachments ?? [])
      .filter((att) => {
        if (att.size > MAX_ATTACHMENT_BYTES) {
          this.ctx.log.warn({ from: fromAddr, filename: att.filename, size: att.size, limit: MAX_ATTACHMENT_BYTES }, 'Skipping oversized email attachment');
          return false;
        }
        return true;
      })
      .map((att) => ({
        filename: att.filename || 'attachment',
        mimeType: att.contentType || 'application/octet-stream',
        data: att.content,
        filesize: att.size,
      }));

    // Extract body — prefer text, fall back to minimal HTML stripping
    let body = parsed.text || stripHtml(parsed.html || '') || '';
    body = body.trim();
    if (!body && attachments.length === 0) return;

    // Subject handling:
    // - Commands (starting with /) — never prepend, would break gateway detection
    // - New thread (no inReplyTo) — prepend subject for agent context
    // - Reply in existing thread — skip, subject is redundant "Re: Re: ..."
    const isCommand = body.startsWith('/');
    const isNewThread = !parsed.inReplyTo;
    if (!isCommand && isNewThread && parsed.subject) {
      body = `[Subject: ${parsed.subject}]\n\n${body}`;
    }

    // Store threading state for outbound replies
    if (parsed.messageId) {
      this.db
        .prepare(
          'INSERT OR REPLACE INTO threads (sender_handle, agent_address, message_id, subject, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(senderHandle, this.agentAddress, parsed.messageId, parsed.subject || null, new Date().toISOString());
    }

    // Deliver to gateway
    this.ctx.ingestInbound(senderHandle, this.agentAddress, body, senderName, {
      channel: this.channel,
    }, attachments.length > 0 ? attachments : undefined);
  }

  // --- SMTP outbound ---

  async sendMail(recipientEmail: string, senderHandle: string, text: string, attachments?: Attachment[]): Promise<void> {
    // Lookup threading state
    const thread = queryOne(
      this.db.prepare('SELECT message_id, subject FROM threads WHERE sender_handle = ? AND agent_address = ?'),
      ThreadRow,
      senderHandle,
      this.agentAddress,
    );

    const subject = thread?.subject ? `Re: ${thread.subject.replace(/^Re:\s*/i, '')}` : this.agentEmail;

    // Build nodemailer attachments from host paths
    const mailAttachments = attachments?.filter((a) => a.hostPath).map((a) => ({
      filename: a.filename,
      content: fs.createReadStream(a.hostPath!),
      contentType: a.mimeType,
    }));

    try {
      await this.transporter.sendMail({
        from: this.agentEmail,
        to: recipientEmail,
        subject,
        text,
        ...(thread?.message_id
          ? {
              inReplyTo: thread.message_id,
              references: thread.message_id,
            }
          : {}),
        ...(mailAttachments?.length ? { attachments: mailAttachments } : {}),
      });
    } catch (err) {
      this.ctx.log.error({ email: this.agentEmail, to: recipientEmail, err }, 'Email send failed');
      throw err;
    }
  }

  async sendApprovalMail(
    recipientEmail: string,
    senderHandle: string,
    pkt: ApprovalRequestPkt,
    db: Database.Database,
  ): Promise<void> {
    const subject = `[Approval] ${pkt.summary}`;
    const body = [
      pkt.summary,
      ...(pkt.details ? ['', pkt.details] : []),
      '',
      'Reply "approve" or "reject" (optionally followed by a reason).',
    ].join('\n');

    try {
      const info = await this.transporter.sendMail({
        from: this.agentEmail,
        to: recipientEmail,
        subject,
        text: body,
      });

      // Store threading state for inbound approval detection
      const messageId = info.messageId;
      if (messageId) {
        db.prepare(
          'INSERT OR REPLACE INTO approval_threads (message_id, approval_id, agent_address, participant) VALUES (?, ?, ?, ?)',
        ).run(messageId, pkt.approvalId, this.agentAddress, senderHandle);
      }
    } catch (err) {
      this.ctx.log.error({ email: this.agentEmail, to: recipientEmail, err }, 'Approval email send failed');
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// EmailTransport
// ---------------------------------------------------------------------------

class EmailTransport implements Transport {
  name = 'email';

  private connections = new Map<string, EmailConnection>();
  private db: Database.Database;
  private ctx: TransportContext;

  constructor(ctx: TransportContext, bindings: EmailBinding[]) {
    this.ctx = ctx;
    this.db = openDb();

    for (const route of bindings) {
      const conn = new EmailConnection(route, ctx, this.db);
      this.connections.set(route.address, conn);
    }
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  async connect(): Promise<void> {
    const starts = [...this.connections.values()].map((c) => c.start());
    await Promise.allSettled(starts);
  }

  async send(pkt: AnyPacket, ctx: OutboundContext): Promise<void> {
    if (!isDeliverablePacket(pkt)) return;
    // Email has no in-place message edit semantics — previews never ship.
    if (pkt.type === 'preview') return;

    const handle = pkt.to; // 'email:user%40example.com'
    const recipientEmail = decodeAddressValue(handle.slice('email:'.length));

    const conn = this.connections.get(ctx.agentAddress);
    if (!conn) {
      this.ctx.log.warn({ agentAddress: ctx.agentAddress }, 'No email connection for agent');
      return;
    }

    if (pkt.type === 'approval_request') {
      await conn.sendApprovalMail(recipientEmail, handle, pkt, this.db);
      return;
    }

    if (pkt.type === 'approval_ack') {
      // Skip email for acks — the tool result email provides the real confirmation
      return;
    }

    await conn.sendMail(recipientEmail, handle, pkt.text, pkt.attachments);
  }

  ownsParticipant(participantAddress: string): boolean {
    return participantAddress.startsWith('email:');
  }

  async sendEvent(_evt: Evt): Promise<void> {
    // Email has no real-time event support (no typing, no lifecycle rendering)
  }

  async disconnect(): Promise<void> {
    for (const conn of this.connections.values()) {
      conn.stop();
    }
    this.db.close();
  }

  isConnected(): boolean {
    for (const conn of this.connections.values()) {
      if (conn.isAlive) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

const EMAIL_SETUP = `
Cast connects to a mailbox via **IMAP** (read inbound mail with IDLE) and **SMTP** (send replies). You'll need a dedicated mail account — credentials are stored on disk, so don't use your personal account.

1. Pick or create a mail account that the agent will own (e.g. \`myagent@gmail.com\`).
2. If your provider uses 2FA (Gmail, iCloud, Outlook all do), generate an **app-specific password** — your normal password won't work over IMAP/SMTP.
3. Look up your provider's IMAP and SMTP host/port.
4. Paste both into the form. Username is usually the full email address; password is the app-specific one from step 2.

**Common providers:**

- **Gmail** — IMAP \`imap.gmail.com:993\`, SMTP \`smtp.gmail.com:465\`. App password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
- **iCloud** — IMAP \`imap.mail.me.com:993\`, SMTP \`smtp.mail.me.com:587\`. App password at [account.apple.com](https://account.apple.com) → Sign-In and Security.
- **Outlook / Microsoft 365** — IMAP \`outlook.office365.com:993\`, SMTP \`smtp.office365.com:587\`.
- **Fastmail** — IMAP \`imap.fastmail.com:993\`, SMTP \`smtp.fastmail.com:465\`. App password under Settings → Privacy & Security.

Sender allowlist defaults to "any sender" — restrict in \`routes.json\` with the \`whitelist\` field if needed.
`.trim();

export const email = defineTransport<EmailConfig>({
  name: 'email',
  addressPrefix: 'email',
  configSchema: EmailConfigSchema,
  admin: {
    displayLabel: 'Email',
    fields: [
      { key: 'email', type: 'text', label: 'Email Address', placeholder: 'agent@example.com' },
      { key: 'imapHost', path: 'imap.host', type: 'text', label: 'Host', placeholder: 'imap.gmail.com', group: 'IMAP' },
      { key: 'imapPort', path: 'imap.port', type: 'number', label: 'Port', placeholder: '993', group: 'IMAP' },
      { key: 'imapUser', path: 'imap.user', type: 'text', label: 'Username', placeholder: 'agent@example.com', group: 'IMAP' },
      { key: 'imapPass', path: 'imap.pass', type: 'password', label: 'Password', secret: true, group: 'IMAP' },
      { key: 'smtpHost', path: 'smtp.host', type: 'text', label: 'Host', placeholder: 'smtp.gmail.com', group: 'SMTP' },
      { key: 'smtpPort', path: 'smtp.port', type: 'number', label: 'Port', placeholder: '465', group: 'SMTP' },
      { key: 'smtpUser', path: 'smtp.user', type: 'text', label: 'Username', placeholder: 'agent@example.com', group: 'SMTP' },
      { key: 'smtpPass', path: 'smtp.pass', type: 'password', label: 'Password', secret: true, group: 'SMTP' },
    ],
    summarize: (entry) => (entry as EmailRoute).email,
    setupInstructions: EMAIL_SETUP,
  },
  create: (ctx, routes) => {
    if (routes.length === 0) return null;

    // Duplicate address check
    const seen = new Set<string>();
    for (const r of routes) {
      if (seen.has(r.email)) {
        ctx.log.warn({ email: r.email }, 'Duplicate email address across routes — behavior undefined');
      }
      seen.add(r.email);
    }

    // Resolve routes.json names to canonical bus addresses
    const bindings: EmailBinding[] = [];
    for (const r of routes) {
      const canonical = ctx.resolveAddress(r.address);
      if (!canonical) {
        ctx.log.warn({ address: r.address }, 'Email route references unregistered address — skipping');
        continue;
      }
      // Whitelist trusts the From-header; without requireAuth a paired sender is spoofable.
      if (r.whitelist && r.whitelist.length > 0 && !r.requireAuth) {
        ctx.log.warn(
          { email: r.email },
          'Email route has whitelist but requireAuth is false — From-header is spoofable. Set requireAuth: true in routes.json.',
        );
      }
      bindings.push({ ...r, address: canonical });
    }
    if (bindings.length === 0) return null;
    return new EmailTransport(ctx, bindings);
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal HTML tag stripping for email bodies when text/plain is unavailable. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Check if an email address matches a whitelist entry. Supports exact match and *@domain wildcards. */
function matchesWhitelist(email: string, whitelist: string[]): boolean {
  const lower = email.toLowerCase();
  for (const entry of whitelist) {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith('*@')) {
      // Domain wildcard: *@domain.com matches anything @domain.com
      if (lower.endsWith(pattern.slice(1))) return true;
    } else {
      if (lower === pattern) return true;
    }
  }
  return false;
}
