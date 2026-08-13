/**
 * Google Messages extension schemas — config, secrets, admin state.
 *
 * Policy model (see manual/README.md for the full rationale):
 * - `chats` is keyed on conversationId — the stable key for anything that exists,
 *   groups included. Surfaced in tool output so operators can copy it.
 * - `contacts` is keyed on E.164 phone number — 1:1 only by construction (a group
 *   has no number). An entry authorizes cold send to that number and, once the
 *   thread is resolved, keeps governing it.
 * - Cold send (no existing conversation) NEVER inherits `direct`: it requires at
 *   minimum per-message approval unless an explicit `contacts` allow exists.
 *   The global mode expresses trust in ongoing threads; first contact is a
 *   distinct, riskier act.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Per-target override
// ---------------------------------------------------------------------------

/**
 * Per-target override. Each axis is independently settable.
 * - 'allow': always allow on this axis (skips approval).
 * - 'deny': hard-deny on this axis.
 * - missing: inherit from the global mode.
 */
export const AxisOverrideSchema = z.object({
  read: z.enum(['allow', 'deny']).optional(),
  send: z.enum(['allow', 'deny']).optional(),
});
export type AxisOverride = z.infer<typeof AxisOverrideSchema>;

// ---------------------------------------------------------------------------
// Config + secrets
// ---------------------------------------------------------------------------

export const GmessagesConfigSchema = z.object({
  /** Global read default. Applies to conversations with no override. */
  read_mode: z.enum(['disabled', 'approval', 'open']).default('approval'),
  /** Global send default. Applies to conversations with no override. */
  send_mode: z.enum(['disabled', 'approval', 'direct']).default('disabled'),
  /** Per-conversation overrides, keyed on conversationId. */
  chats: z.record(z.string(), AxisOverrideSchema).default({}),
  /** Per-number overrides (E.164), 1:1 only. The cold-send authorization surface. */
  contacts: z.record(z.string(), AxisOverrideSchema).default({}),
  /** Operator labels, keyed on conversationId — for unsaved numbers or nicknames
   *  Google's contact sync can't provide. Used in display and name resolution. */
  labels: z.record(z.string(), z.string()).default({}),
});
export type GmessagesConfig = z.infer<typeof GmessagesConfigSchema>;

/**
 * No standing secrets. Google cookies enter once through the admin pairing flow
 * and are discarded; the durable credential is the self-rotating session file in
 * privateDir (never mounted, never in operator config).
 */
export const GmessagesSecretsSchema = z.object({});
export type GmessagesSecrets = z.infer<typeof GmessagesSecretsSchema>;

// ---------------------------------------------------------------------------
// Admin connect state (returned by connect hook for admin UI)
// ---------------------------------------------------------------------------

export const GmessagesAdminState = z.object({
  paired: z.boolean(),
  connected: z.boolean().default(false),
  /** Live conversation inventory for the policy picker. Empty when the agent
   *  is not running — policy editing must not require a live connection. */
  conversations: z
    .array(
      z.object({
        conversationId: z.string(),
        label: z.string(),
        kind: z.enum(['sms', 'rcs', 'unknown']),
      }),
    )
    .default([]),
});
export type GmessagesAdminState = z.infer<typeof GmessagesAdminState>;
