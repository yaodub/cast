/**
 * EmailWatcher — low-level watch engine for IMAP folder monitoring.
 *
 * Manages per-folder IDLE connections, cron-based polling, watermark tracking,
 * and criteria-based email filtering. Has no knowledge of subscriptions,
 * persistence, delivery, or MCP — callers provide an onEmails callback.
 *
 * Used by SubscriptionManager (MCP tool layer) and directly by agent services.
 */
import { Cron } from 'croner';
import { ImapFlow } from 'imapflow';
import type { SearchObject } from 'imapflow';
import { simpleParser } from 'mailparser';

import type { EmailSecrets, EmailEnvelope } from './schemas.js';
import { matchAddressPattern } from './schemas.js';
import type { Logger } from '@getcast/extension-schema';
import { noopLogger } from '@getcast/extension-schema';

import {
  SNIPPET_LENGTH,
  createImapClient,
  buildSearchObject,
  applyScope,
  htmlToText,
} from './helpers.js';
import { verifyMessage } from './verify.js';
import { detectAutoResponder } from './auto-responder.js';
import {
  REALTIME,
  DEBOUNCE_MS,
  DEFAULT_FOLDER,
  type WatchOptions,
  type WatchHandle,
  type IdleState,
  isRealtime,
} from './types.js';

// ---------------------------------------------------------------------------
// Per-folder IDLE connection state
// ---------------------------------------------------------------------------

interface FolderIdleState {
  state: IdleState;
  /** Watch IDs using this folder's IDLE connection. */
  watchIds: Set<string>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// Internal watch entry
// ---------------------------------------------------------------------------

interface WatchEntry {
  id: string;
  folder: string;
  criteria: { from?: string; to?: string; subject?: string; body?: string };
  schedule: string;
  timezone?: string;
  watermark: number;
  scope?: { senders: string[]; blocked: string[] };
  requireAuth?: boolean;
  onEmails: (emails: EmailEnvelope[]) => void;
  cron: Cron | null;
}

// ---------------------------------------------------------------------------
// EmailWatcher
// ---------------------------------------------------------------------------

let nextWatchId = 0;

export class EmailWatcher {
  private secrets: EmailSecrets;
  private log: Logger;

  /** All active watches, keyed by watch ID. */
  private watches = new Map<string, WatchEntry>();

  /** Per-folder IDLE connection state. */
  private folders = new Map<string, FolderIdleState>();

  constructor(secrets: EmailSecrets, log?: Logger) {
    this.secrets = secrets;
    this.log = log ?? noopLogger;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Start watching a folder for new emails.
   * Seeds watermark from IMAP if not provided, starts IDLE or cron.
   */
  async watch(opts: WatchOptions): Promise<WatchHandle> {
    const id = `w-${++nextWatchId}-${Date.now().toString(36)}`;
    const folder = opts.folder ?? DEFAULT_FOLDER;

    let watermark = opts.initialWatermark ?? 0;
    if (!opts.initialWatermark) {
      watermark = await this.seedWatermark(folder);
    }

    const entry: WatchEntry = {
      id,
      folder,
      criteria: opts.criteria ?? {},
      schedule: opts.schedule,
      timezone: opts.timezone,
      watermark,
      scope: opts.scope,
      requireAuth: opts.requireAuth,
      onEmails: opts.onEmails,
      cron: null,
    };

    this.watches.set(id, entry);

    if (isRealtime(entry)) {
      this.ensureFolderIdle(folder, id);
    } else {
      this.startCron(entry);
    }

    const handle: WatchHandle = {
      id,
      stop: () => this.stopWatch(id),
      get watermark() { return entry.watermark; },
    };

    return handle;
  }

  /** Stop all watches and tear down all IDLE connections. */
  stopAll(): void {
    for (const entry of this.watches.values()) {
      if (entry.cron) entry.cron.stop();
    }
    this.watches.clear();

    for (const [folder, fstate] of this.folders) {
      this.teardownFolderIdle(folder, fstate);
    }
    this.folders.clear();
  }

  // =========================================================================
  // Watch lifecycle
  // =========================================================================

  private stopWatch(id: string): void {
    const entry = this.watches.get(id);
    if (!entry) return;

    if (entry.cron) entry.cron.stop();
    this.watches.delete(id);

    if (isRealtime(entry)) {
      const fstate = this.folders.get(entry.folder);
      if (fstate) {
        fstate.watchIds.delete(id);
        if (fstate.watchIds.size === 0) {
          this.teardownFolderIdle(entry.folder, fstate);
          this.folders.delete(entry.folder);
        }
      }
    }
  }

  // =========================================================================
  // Watermark seeding
  // =========================================================================

  private async seedWatermark(folder: string): Promise<number> {
    try {
      const client = createImapClient(this.secrets);
      await client.connect();
      try {
        const mailbox = await client.mailboxOpen(folder);
        return mailbox.uidNext - 1;
      } finally {
        try { await client.logout(); } catch { /* already disconnected */ }
      }
    } catch (err) {
      this.log.warn({ err, folder }, 'Failed to seed watermark');
      return 0;
    }
  }

  // =========================================================================
  // Cron management
  // =========================================================================

  private startCron(entry: WatchEntry): void {
    if (entry.cron) entry.cron.stop();
    entry.cron = new Cron(
      entry.schedule,
      { timezone: entry.timezone },
      () => {
        this.pollCron(entry).catch((err) => {
          this.log.warn({ watchId: entry.id, err }, 'Cron poll failed');
        });
      },
    );
  }

  private async pollCron(entry: WatchEntry): Promise<void> {
    const client = createImapClient(this.secrets);
    await client.connect();
    try {
      const lock = await client.getMailboxLock(entry.folder);
      try {
        await this.pollEntry(client, entry);
      } finally {
        lock.release();
      }
    } finally {
      try { await client.logout(); } catch { /* already disconnected */ }
    }
  }

  // =========================================================================
  // Per-folder IDLE connection
  // =========================================================================

  /** Ensure an IDLE connection exists for this folder; register the watch ID. */
  private ensureFolderIdle(folder: string, watchId: string): void {
    let fstate = this.folders.get(folder);
    if (fstate) {
      fstate.watchIds.add(watchId);
      return;
    }

    fstate = {
      state: { status: 'stopped' },
      watchIds: new Set([watchId]),
      debounceTimer: null,
      reconnectTimer: null,
    };
    this.folders.set(folder, fstate);
    this.connectFolderIdle(folder, fstate, 0);
  }

  private connectFolderIdle(folder: string, fstate: FolderIdleState, attempt: number): void {
    if (fstate.state.status !== 'stopped') return;
    fstate.state = { status: 'connecting', attempt };

    const client = new ImapFlow({
      host: this.secrets.IMAP_HOST,
      port: this.secrets.IMAP_PORT,
      secure: true,
      auth: { user: this.secrets.EMAIL_ADDRESS, pass: this.secrets.EMAIL_PASSWORD },
      logger: false,
      maxIdleTime: 25 * 60 * 1000,
    });

    client.connect()
      .then(() => {
        if (fstate.state.status !== 'connecting') { client.close(); return; }
        return client.mailboxOpen(folder).then(() => {
          if (fstate.state.status !== 'connecting') { client.close(); return; }
          client.on('exists', () => this.handleExists(folder, fstate));
          client.on('close', () => this.handleDisconnect(folder, fstate));
          fstate.state = { status: 'connected', client };
          this.log.info({ folder, email: this.secrets.EMAIL_ADDRESS }, 'IDLE connected');

          // Catch up after reconnect
          if (attempt > 0) {
            this.pollRealtimeForFolder(folder, fstate).catch((err) => {
              this.log.warn({ err, folder }, 'IDLE catch-up poll failed');
            });
          }
        });
      })
      .catch((err) => {
        fstate.state = { status: 'stopped' };
        const delay = Math.min(1000 * 2 ** attempt, 60_000);
        this.log.warn({ folder, err, delay }, 'IDLE connect failed, retrying');
        fstate.reconnectTimer = setTimeout(() => {
          fstate.reconnectTimer = null;
          this.connectFolderIdle(folder, fstate, attempt + 1);
        }, delay);
      });
  }

  private handleExists(folder: string, fstate: FolderIdleState): void {
    if (fstate.state.status !== 'connected') return;
    if (fstate.debounceTimer) clearTimeout(fstate.debounceTimer);
    fstate.debounceTimer = setTimeout(() => {
      fstate.debounceTimer = null;
      this.pollRealtimeForFolder(folder, fstate).catch((err) => {
        this.log.warn({ err, folder }, 'IDLE realtime poll failed');
      });
    }, DEBOUNCE_MS);
  }

  private handleDisconnect(folder: string, fstate: FolderIdleState): void {
    if (fstate.state.status === 'closing') {
      fstate.state = { status: 'stopped' };
      return;
    }
    const attempt = fstate.state.status === 'connecting' ? fstate.state.attempt : 0;
    fstate.state = { status: 'stopped' };
    if (fstate.watchIds.size === 0) return;
    const delay = Math.min(1000 * 2 ** attempt, 60_000);
    this.log.warn({ folder, delay }, 'IDLE disconnected, reconnecting');
    fstate.reconnectTimer = setTimeout(() => {
      fstate.reconnectTimer = null;
      this.connectFolderIdle(folder, fstate, attempt + 1);
    }, delay);
  }

  private teardownFolderIdle(folder: string, fstate: FolderIdleState): void {
    if (fstate.reconnectTimer) {
      clearTimeout(fstate.reconnectTimer);
      fstate.reconnectTimer = null;
    }
    if (fstate.debounceTimer) {
      clearTimeout(fstate.debounceTimer);
      fstate.debounceTimer = null;
    }
    if (fstate.state.status === 'connected') {
      const { client } = fstate.state;
      fstate.state = { status: 'closing' };
      client.close();
    } else {
      fstate.state = { status: 'stopped' };
    }
  }

  // =========================================================================
  // Polling
  // =========================================================================

  /** Poll all realtime watches for a given folder using its IDLE connection. */
  private async pollRealtimeForFolder(folder: string, fstate: FolderIdleState): Promise<void> {
    if (fstate.state.status !== 'connected') return;
    const { client } = fstate.state;

    const lock = await client.getMailboxLock(folder);
    try {
      for (const watchId of fstate.watchIds) {
        const entry = this.watches.get(watchId);
        if (!entry) continue;
        await this.pollEntry(client, entry);
      }
    } finally {
      lock.release();
    }
  }

  /** Core poll logic for a single watch on an open connection. */
  private async pollEntry(client: ImapFlow, entry: WatchEntry): Promise<void> {
    const base = entry.scope
      ? applyScope(buildSearchObject(entry.criteria), entry.scope)
      : buildSearchObject(entry.criteria);
    const searchObj: SearchObject = {
      ...base,
      uid: `${entry.watermark + 1}:*`,
    };

    const uids = await client.search(searchObj, { uid: true });
    if (!Array.isArray(uids) || uids.length === 0) return;

    const newUids = uids.filter((uid) => uid > entry.watermark);
    if (newUids.length === 0) return;

    const emails: EmailEnvelope[] = [];
    let maxUid = entry.watermark;

    for await (const msg of client.fetch(newUids, { envelope: true, source: true }, { uid: true })) {
      if (msg.uid > maxUid) maxUid = msg.uid;
      const envelope = msg.envelope;
      if (!envelope) continue;

      // Auth check before snippet/parse — skip unauthenticated mail entirely so we
      // don't waste body parsing on rejected messages and so the fail log is the
      // first signal in the trace.
      if (entry.requireAuth && msg.source) {
        try {
          const verdict = await verifyMessage(msg.source);
          if (!verdict.pass) {
            this.log.warn(
              { watchId: entry.id, from: envelope.from?.[0]?.address, fromDomain: verdict.fromDomain, reason: verdict.reason },
              'Email failed authentication, skipping',
            );
            continue;
          }
        } catch (err) {
          this.log.warn(
            { watchId: entry.id, from: envelope.from?.[0]?.address, err },
            'Email authentication threw, skipping (fail-closed)',
          );
          continue;
        }
      }

      // Auto-responder detection (RFC 3834 + vendor signals). One simpleParser
      // call serves both the auto-check and snippet generation — we skip the
      // snippet (and the eventual delivery) when the auto-check fires. Parsed
      // emails that throw fall through with no snippet and no auto-skip; the
      // envelope still delivers because the existing scope/auth filters already
      // ran. Watermark is still advanced (above) so we don't re-fetch.
      let snippet = '';
      let autoReason: string | undefined;
      if (msg.source) {
        try {
          const parsed = await simpleParser(msg.source);
          autoReason = detectAutoResponder(parsed.headers);
          if (!autoReason) {
            const rawText = parsed.html ? htmlToText(parsed.html) : parsed.text || '';
            snippet = rawText.slice(0, SNIPPET_LENGTH).replace(/\s+/g, ' ').trim();
          }
        } catch { /* skip unparseable */ }
      }

      if (autoReason) {
        this.log.info(
          { watchId: entry.id, from: envelope.from?.[0]?.address, subject: envelope.subject, reason: autoReason },
          'Email skipped: auto-responder',
        );
        continue;
      }

      emails.push({
        emailId: String(msg.emailId),
        messageId: envelope.messageId || String(msg.emailId),
        from: envelope.from?.[0]?.address || '',
        to: (envelope.to || []).map((a) => a.address || ''),
        subject: envelope.subject || '',
        date: envelope.date?.toISOString() || new Date().toISOString(),
        snippet,
      });
    }

    entry.watermark = maxUid;

    // Post-fetch exact-match enforcement. IMAP `from` is substring-matching, so
    // the search-time scope is permissive (e.g. "alerts@bank.com" also matches
    // "evil-alerts@bank.com.attacker"). Re-filter using exact/domain semantics.
    let delivered = emails;
    if (entry.scope) {
      const { senders, blocked } = entry.scope;
      delivered = emails.filter((e) => {
        if (blocked.length > 0 && blocked.some((p) => matchAddressPattern(p, e.from))) return false;
        if (senders.length === 0) return true;
        return senders.some((p) => matchAddressPattern(p, e.from));
      });
      if (delivered.length < emails.length) {
        this.log.warn(
          { dropped: emails.length - delivered.length, watchId: entry.id },
          'Emails dropped by post-fetch scope filter (likely substring-match leakage)',
        );
      }
    }

    if (delivered.length > 0) {
      entry.onEmails(delivered);
    }
  }
}
