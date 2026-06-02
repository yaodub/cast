/**
 * Email extension admin router — IMAP/SMTP credential management and config.
 *
 * Connection testing and folder discovery go through the generic
 * extension.shared.connect procedure (delegates to the extension's connect hook).
 * This router only handles config/secret I/O.
 */
import fs from 'fs';
import { z } from 'zod';

import { EmailConfigSchema } from '@getcast/ext-email/schemas';

import { agentPath } from '../../../config.js';
import { readSecretsJson, writeSecretsJson } from '../../../lib/secrets-file.js';
import { adminProcedure, router } from '../../trpc.js';
import {
  aliasToFolder,
  readExtensionConfig,
  writeExtensionConfig,
  maskSecret,
  LockableFieldSchema,
  SecretFieldSchema,
} from './helpers.js';

const EXT_NAME = 'email';
const SECRET_KEYS = [
  'EMAIL_ADDRESS',
  'EMAIL_PASSWORD',
  'IMAP_HOST',
  'IMAP_PORT',
  'SMTP_HOST',
  'SMTP_PORT',
] as const;

// Keys whose canonical type in secrets.json is `number`. The admin UI sends
// string-typed form values, so the router coerces these at the write boundary
// to satisfy the numeric Zod schema (z.number()).
const NUMERIC_KEYS: ReadonlySet<string> = new Set(['IMAP_PORT', 'SMTP_PORT']);

const aliasInput = z.object({ alias: z.string() });
const EmailConfigPartial = EmailConfigSchema.partial();

// getConfig response contract. Validated on return — a parse failure here
// is a server bug (the envelope assembled by readExtensionConfig diverged
// from what the form expects), not a runtime data issue.
const EmailAdminResponseSchema = z.object({
  secrets: z.record(z.string(), SecretFieldSchema),
  config: z.record(z.string(), LockableFieldSchema(z.unknown())),
});

export const emailRouter = router({
  getConfig: adminProcedure.input(aliasInput).query(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const secretsPath = agentPath(folder, 'config', 'ext', EXT_NAME, 'secrets.json');
    const rawSecrets = readSecretsJson(secretsPath);
    const secrets: Record<string, { value: string; set: boolean }> = {};
    // Only the password is sensitive — show everything else in full.
    // Numeric port values are stringified for transport over the tRPC contract;
    // the UI form receives them as strings either way.
    for (const key of SECRET_KEYS) {
      const raw = rawSecrets[key];
      const val = raw == null || raw === '' ? '' : String(raw);
      if (!val) {
        secrets[key] = { value: '', set: false };
      } else if (key === 'EMAIL_PASSWORD') {
        secrets[key] = { value: maskSecret(val), set: true };
      } else {
        secrets[key] = { value: val, set: true };
      }
    }

    const config = readExtensionConfig(folder, EXT_NAME);

    return EmailAdminResponseSchema.parse({ secrets, config });
  }),

  setConfig: adminProcedure
    .input(
      z.object({
        alias: z.string(),
        config: EmailConfigPartial.optional(),
        secrets: z.record(z.string(), z.string()).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      if (input.config) writeExtensionConfig(folder, EXT_NAME, input.config);
      if (input.secrets) {
        const secretsPath = agentPath(folder, 'config', 'ext', EXT_NAME, 'secrets.json');
        fs.mkdirSync(agentPath(folder, 'config', 'ext', EXT_NAME), { recursive: true });
        const existing = readSecretsJson(secretsPath);
        const merged: Record<string, unknown> = { ...existing };
        for (const [key, value] of Object.entries(input.secrets)) {
          if (NUMERIC_KEYS.has(key) && /^\d+$/.test(value)) {
            merged[key] = Number(value);
          } else {
            merged[key] = value;
          }
        }
        writeSecretsJson(secretsPath, merged);
      }
      return { ok: true };
    }),
});
