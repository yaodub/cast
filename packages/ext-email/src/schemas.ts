/**
 * Email extension schemas — config, secrets, capability types, and scope/approval helpers.
 *
 * Config shape: symmetric inbound/outbound sections. Each axis has scope
 * (allowlist + denylist), a mode (disabled | approval | enabled), and an
 * approval-bypass list (always_allow). Inbound additionally has folder scope
 * and volumetric caps.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Email config + secrets schemas
// ---------------------------------------------------------------------------

const ModeSchema = z.enum(['disabled', 'approval', 'enabled']);
export type Mode = z.infer<typeof ModeSchema>;

const InboundSchema = z.object({
  /** Folder allowlist. Empty = all folders. Exact IMAP paths (case-sensitive). */
  folders:      z.array(z.string()).default([]),
  /** Sender allowlist. Empty = all senders. Patterns: exact (alice@acme.com) or domain (@acme.com). */
  senders:      z.array(z.string()).default([]),
  /** Sender denylist. Pushed to IMAP `not:` clause so matches never return. Same pattern syntax. */
  blocked:      z.array(z.string()).default([]),
  window_days:  z.number().int().min(1).default(7),
  max_results:  z.number().int().min(1).default(25),
  /** Default approval mode for search/subscribe within scope. */
  default:      ModeSchema.default('approval'),
  /** Per-sender override: these addresses bypass approval even under `approval` default. */
  always_allow: z.array(z.string()).default([]),
  /** Default DKIM/DMARC requirement for subscriptions. Subscriptions may override per-watch. */
  require_auth: z.boolean().default(false),
});

const OutboundSchema = z.object({
  /** Recipient allowlist. Empty = any recipient. Patterns: exact or domain. */
  recipients:   z.array(z.string()).default([]),
  /** Recipient denylist — never send to these. */
  blocked:      z.array(z.string()).default([]),
  default:      ModeSchema.default('approval'),
  always_allow: z.array(z.string()).default([]),
});

export const EmailConfigSchema = z.object({
  inbound:  InboundSchema.default(() => InboundSchema.parse({})),
  outbound: OutboundSchema.default(() => OutboundSchema.parse({})),
});
export type EmailConfig = z.infer<typeof EmailConfigSchema>;

/** Email extension secrets (config/ext/email/secrets.json). */
export const EmailSecretsSchema = z.object({
  EMAIL_ADDRESS: z.string(),
  EMAIL_PASSWORD: z.string(),
  IMAP_HOST: z.string(),
  // Ports coerce: secrets.json stores numbers, but live form/test overrides
  // arrive as strings. Coercion accepts both; identity on the stored number.
  IMAP_PORT: z.coerce.number().default(993),
  SMTP_HOST: z.string(),
  SMTP_PORT: z.coerce.number().default(465),
});
export type EmailSecrets = z.infer<typeof EmailSecretsSchema>;

// ---------------------------------------------------------------------------
// Admin connect state (returned by connect hook for admin UI)
// ---------------------------------------------------------------------------

export const EmailAdminState = z.object({
  folders: z.array(z.object({ path: z.string(), name: z.string() })),
});
export type EmailAdminState = z.infer<typeof EmailAdminState>;

// ---------------------------------------------------------------------------
// Scope + approval decision helpers
// ---------------------------------------------------------------------------

/** Normalize address for comparison. */
function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

/**
 * Match an address against a pattern.
 * Patterns: exact (`alice@acme.com`) or domain (`@acme.com` — any address in that domain).
 */
export function matchAddressPattern(pattern: string, addr: string): boolean {
  const p = normalizeAddress(pattern);
  const a = normalizeAddress(addr);
  if (!p || !a) return false;
  if (p.startsWith('@')) return a.endsWith(p);
  return p === a;
}

/** True if any pattern in the list matches. */
function matchAny(patterns: string[], addr: string): boolean {
  return patterns.some((p) => matchAddressPattern(p, addr));
}

/** True if sender passes inbound scope (allowlist non-empty → must match; blocked → rejected). */
export function isInReadScope(config: EmailConfig, sender: string): boolean {
  if (matchAny(config.inbound.blocked, sender)) return false;
  if (config.inbound.senders.length === 0) return true;
  return matchAny(config.inbound.senders, sender);
}

/** True if recipient passes outbound scope. */
export function isInSendScope(config: EmailConfig, recipient: string): boolean {
  if (matchAny(config.outbound.blocked, recipient)) return false;
  if (config.outbound.recipients.length === 0) return true;
  return matchAny(config.outbound.recipients, recipient);
}

/** True if folder passes inbound folder allowlist. */
export function isAllowedFolder(config: EmailConfig, folder: string): boolean {
  if (config.inbound.folders.length === 0) return true;
  return config.inbound.folders.includes(folder);
}

/** Filter decision for the approval framework. */
export type FilterDecision = 'skip' | 'approve' | 'block';

function modeToDecision(mode: Mode): FilterDecision {
  if (mode === 'disabled') return 'block';
  if (mode === 'enabled') return 'skip';
  return 'approve';
}

/** Read-side decision for a specific sender. */
export function readDecision(config: EmailConfig, sender: string): FilterDecision {
  if (!isInReadScope(config, sender)) return 'block';
  if (matchAny(config.inbound.always_allow, sender)) return 'skip';
  return modeToDecision(config.inbound.default);
}

/** Send-side decision for a specific recipient. */
export function sendDecision(config: EmailConfig, recipient: string): FilterDecision {
  if (!isInSendScope(config, recipient)) return 'block';
  if (matchAny(config.outbound.always_allow, recipient)) return 'skip';
  return modeToDecision(config.outbound.default);
}

/** Mode-based decision when no specific address is available (e.g. search with no `from`). */
export function readDefaultDecision(config: EmailConfig): FilterDecision {
  return modeToDecision(config.inbound.default);
}

// ---------------------------------------------------------------------------
// Email capability types
// ---------------------------------------------------------------------------

/** Email search request — structured criteria. */
export const EmailSearchRequestSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  since: z.string().optional(),
  before: z.string().optional(),
  folder: z.string().optional(),
  limit: z.number().int().min(1).optional(),
});
export type EmailSearchRequest = z.infer<typeof EmailSearchRequestSchema>;

/** Email envelope — summary metadata for a single email. */
export const EmailEnvelopeSchema = z.object({
  emailId: z.string(),
  messageId: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  date: z.string(),
  snippet: z.string(),
});
export type EmailEnvelope = z.infer<typeof EmailEnvelopeSchema>;

/** Email search result. */
export const EmailSearchResultSchema = z.object({
  emails: z.array(EmailEnvelopeSchema),
  total: z.number(),
});
export type EmailSearchResult = z.infer<typeof EmailSearchResultSchema>;

/** Email send request. */
export const EmailSendRequestSchema = z.object({
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  replyToMessageId: z.string().optional(),
});
export type EmailSendRequest = z.infer<typeof EmailSendRequestSchema>;

/** Email send result. */
export const EmailSendResultSchema = z.object({
  ok: z.boolean(),
  mode: z.enum(['sent']),
  messageId: z.string().optional(),
  error: z.string().optional(),
});
export type EmailSendResult = z.infer<typeof EmailSendResultSchema>;

/** Email read request. */
export const EmailReadRequestSchema = z.object({
  emailId: z.string(),
  folder: z.string().optional(),
});
export type EmailReadRequest = z.infer<typeof EmailReadRequestSchema>;

/** Email read result. */
export const EmailReadResultSchema = z.object({
  emailId: z.string(),
  messageId: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  date: z.string(),
  text: z.string(),
  html: z.string().optional(),
  attachments: z.array(
    z.object({
      filename: z.string(),
      contentType: z.string(),
      size: z.number(),
    }),
  ),
});
export type EmailReadResult = z.infer<typeof EmailReadResultSchema> & {
  /** Raw RFC 2822 source. Not in zod schema (Buffer). */
  rawSource: Buffer;
};

/** Email fetch result — metadata + file paths from fetchToDir(). */
export interface EmailFetchResult {
  emailId: string;
  messageId: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  mdPath: string;
  emlPath: string;
  attachments: { filename: string; contentType: string; size: number }[];
}
