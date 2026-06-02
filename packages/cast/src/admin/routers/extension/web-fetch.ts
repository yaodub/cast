/**
 * Web-fetch extension admin router — domain policy config only, no secrets.
 *
 * Web-fetch has no connect hook (no credentials to validate).
 */
import { z } from 'zod';

import { WebFetchPolicySchema } from '@getcast/ext-web-fetch/schemas';

import { adminProcedure, router } from '../../trpc.js';
import { aliasToFolder, readExtensionConfig, writeExtensionConfig, LockableFieldSchema } from './helpers.js';

const EXT_NAME = 'web-fetch';
const aliasInput = z.object({ alias: z.string() });

// Partial of the canonical schema — forms submit only unlocked fields, so
// every key is optional, but each key's *value* is shape-validated.
const WebFetchPolicyPartial = WebFetchPolicySchema.partial();

// getConfig response contract. Validated on return — a parse failure here
// is a server bug (the envelope assembled by readExtensionConfig diverged
// from what the form expects), not a runtime data issue.
const WebFetchAdminResponseSchema = z.object({
  config: z.record(z.string(), LockableFieldSchema(z.unknown())),
});

export const webFetchRouter = router({
  getConfig: adminProcedure.input(aliasInput).query(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const config = readExtensionConfig(folder, EXT_NAME);
    return WebFetchAdminResponseSchema.parse({ config });
  }),

  setConfig: adminProcedure
    .input(
      z.object({
        alias: z.string(),
        config: WebFetchPolicyPartial,
      }),
    )
    .mutation(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      writeExtensionConfig(folder, EXT_NAME, input.config);
      return { ok: true };
    }),
});
