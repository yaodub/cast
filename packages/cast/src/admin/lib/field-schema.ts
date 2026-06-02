/**
 * Lockable + secret field envelopes — the shape every admin `getConfig`
 * tRPC route emits per editable field.
 *
 * `LockableField<T>` wraps an extension/agent config value with a `locked`
 * flag so the form UI can disable author-pinned fields.
 * `SecretField` wraps a credential string with a `set` flag so the form
 * can show "•••• set" without exposing the actual value (passwords are
 * masked; non-sensitive secrets surface in clear).
 *
 * Lock state is a Cast-server feature applied by `helpers.ts` after
 * reading the extension's plain config schema — extensions don't know
 * they're locked, so this envelope lives server-side, not in extension
 * packages.
 */
import { z } from 'zod';

export function LockableFieldSchema<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    value,
    locked: z.boolean(),
  });
}

export const SecretFieldSchema = z.object({
  value: z.string(),
  set: z.boolean(),
});

export interface LockableField<T> {
  value: T;
  locked: boolean;
}

export type SecretField = z.infer<typeof SecretFieldSchema>;
