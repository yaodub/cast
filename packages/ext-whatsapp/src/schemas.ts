/**
 * WhatsApp extension schemas — config, secrets, and per-chat override resolution.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Per-chat override
// ---------------------------------------------------------------------------

/**
 * Per-chat override. Each axis is independently settable.
 * - 'allow': always allow on this axis (skips approval, hard-policy passes).
 * - 'deny': hard-deny on this axis.
 * - missing: inherit from the global mode.
 */
export const ChatOverrideSchema = z.object({
  read: z.enum(['allow', 'deny']).optional(),
  send: z.enum(['allow', 'deny']).optional(),
});
export type ChatOverride = z.infer<typeof ChatOverrideSchema>;

// ---------------------------------------------------------------------------
// Config + secrets
// ---------------------------------------------------------------------------

export const WhatsAppConfigSchema = z.object({
  /** Global read default. Applies to chats with no per-chat read override. */
  read_mode: z.enum(['disabled', 'approval', 'open']).default('approval'),
  /** Global send default. Applies to chats with no per-chat send override. */
  send_mode: z.enum(['disabled', 'approval', 'direct']).default('disabled'),
  /** Per-JID overrides. Each axis (read, send) is independent; missing fields inherit the global mode. */
  chats: z.record(z.string(), ChatOverrideSchema).default({}),
  /** History sync depth. 'standard' (~3 months, web client), 'extended' (~1 year, desktop client). Changing requires re-pair. */
  pairing_history_depth: z.enum(['standard', 'extended']).default('standard'),
});
export type WhatsAppConfig = z.infer<typeof WhatsAppConfigSchema>;

export const WhatsAppSecretsSchema = z.object({});
export type WhatsAppSecrets = z.infer<typeof WhatsAppSecretsSchema>;

// ---------------------------------------------------------------------------
// Admin connect state (returned by connect hook for admin UI)
// ---------------------------------------------------------------------------

export const WhatsAppAdminState = z.object({
  paired: z.boolean(),
  chats: z.array(z.object({
    jid: z.string(),
    name: z.string(),
    isGroup: z.boolean(),
  })).default([]),
});
export type WhatsAppAdminState = z.infer<typeof WhatsAppAdminState>;
