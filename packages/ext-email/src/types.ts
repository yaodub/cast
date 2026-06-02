/**
 * Email extension — subscription types, watch primitives, and persistence.
 *
 * Schema, state types, and pure I/O helpers for subscription data.
 */
import fs from 'fs';
import path from 'path';

import type { ImapFlow } from 'imapflow';
import { z } from 'zod';

import type { EmailEnvelope } from './schemas.js';
import type { Logger } from '@getcast/extension-schema';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REALTIME = 'realtime';
export const DEBOUNCE_MS = 30_000;
export const DEFAULT_FOLDER = 'INBOX';

// ---------------------------------------------------------------------------
// Watch primitive types
// ---------------------------------------------------------------------------

/** Options for starting a folder watch. */
export interface WatchOptions {
  /** IMAP folder to watch (default: INBOX). */
  folder?: string;
  /** Filter criteria for matching emails. */
  criteria?: { from?: string; to?: string; subject?: string; body?: string };
  /** 'realtime' for IMAP IDLE push, or a cron expression. */
  schedule: string;
  /** IANA timezone for cron schedules. */
  timezone?: string;
  /** Resume from this watermark instead of seeding from IMAP. */
  initialWatermark?: number;
  /** Inbound scope pushed into every IMAP query (senders allowlist + blocked denylist). */
  scope?: { senders: string[]; blocked: string[] };
  /** Drop messages whose DKIM/DMARC alignment with the From-domain doesn't hold. */
  requireAuth?: boolean;
  /** Called with new matching emails. */
  onEmails: (emails: EmailEnvelope[]) => void;
}

/** Handle returned by watch() — allows stopping and reading watermark. */
export interface WatchHandle {
  /** Unique watch ID. */
  readonly id: string;
  /** Stop this watch. Tears down IDLE connection if last watcher on folder. */
  stop: () => void;
  /** Current watermark (highest UID processed). */
  readonly watermark: number;
}

// ---------------------------------------------------------------------------
// IDLE state machine (per-folder)
// ---------------------------------------------------------------------------

export type IdleState =
  | { status: 'stopped' }
  | { status: 'connecting'; attempt: number }
  | { status: 'connected'; client: ImapFlow }
  | { status: 'closing' };

// ---------------------------------------------------------------------------
// Subscription schema
// ---------------------------------------------------------------------------

export const SubscriptionSchema = z.object({
  id: z.string(),
  criteria: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
  }),
  folder: z.string().optional(),
  target: z.string(),
  schedule: z.string(),
  instructions: z.string(),
  timezone: z.string().optional(),
  /** Per-subscription override; falls back to inbound.require_auth if undefined. */
  requireAuth: z.boolean().optional(),
  enabled: z.boolean(),
  watermark: z.number(),
  createdAt: z.string(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

export function loadSubscriptions(filePath: string, log: Logger): Subscription[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return z.array(SubscriptionSchema).parse(raw);
  } catch (err) {
    log.warn({ filePath, err }, 'Failed to load subscriptions');
    return [];
  }
}

export function persistSubscriptions(filePath: string, subs: Subscription[]): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(subs, null, 2));
}

export function isRealtime(sub: { schedule: string }): boolean {
  return sub.schedule === REALTIME;
}
