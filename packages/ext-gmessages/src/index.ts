/**
 * Google Messages extension — entry point.
 *
 * Exports the extension definition (for server registration) and the class
 * (for direct service-side instantiation with full type access).
 */
import { defineExtension } from '@getcast/extension-schema';
import { GmessagesConfigSchema, GmessagesSecretsSchema } from './schemas.js';
import { GmessagesExtension } from './extension.js';
import { connect } from './connect.js';

export const gmessages = defineExtension({
  name: 'gmessages',
  configSchema: GmessagesConfigSchema,
  secretsSchema: GmessagesSecretsSchema,
  create: (ctx) => new GmessagesExtension(ctx),
  connect,
});

export { GmessagesExtension };
export { isPaired } from './connect.js';
