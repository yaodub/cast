/**
 * Email extension — entry point.
 *
 * Exports the extension definition (for server registration) and the class
 * (for direct service-side instantiation with full type access).
 */
import { defineExtension } from '@getcast/extension-schema';
import { EmailConfigSchema, EmailSecretsSchema } from './schemas.js';
import { connect } from './helpers.js';

import { EmailExtension } from './extension.js';

export const email = defineExtension({
  name: 'email',
  configSchema: EmailConfigSchema,
  secretsSchema: EmailSecretsSchema,
  create: (ctx) => new EmailExtension(ctx),
  connect,
});

export { EmailExtension };
export { verifyMessage } from './verify.js';
export type { VerifyResult, VerifyOptions, Resolver } from './verify.js';
