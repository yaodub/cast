/**
 * WhatsApp extension — entry point.
 *
 * Exports the extension definition (for server registration) and the class
 * (for direct service-side instantiation with full type access).
 */
import { defineExtension } from '@getcast/extension-schema';
import { WhatsAppConfigSchema, WhatsAppSecretsSchema } from './schemas.js';
import { WhatsAppExtension } from './extension.js';
import { connect } from './connect.js';

export const whatsapp = defineExtension({
  name: 'whatsapp',
  configSchema: WhatsAppConfigSchema,
  secretsSchema: WhatsAppSecretsSchema,
  create: (ctx) => new WhatsAppExtension(ctx),
  connect,
});

export { WhatsAppExtension };
export { isRegistered } from './helpers.js';
