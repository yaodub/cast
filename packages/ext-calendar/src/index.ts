/**
 * Calendar extension — entry point.
 *
 * Exports the extension definition (for server registration) and the class
 * (for direct service-side instantiation with full type access).
 */
import { defineExtension } from '@getcast/extension-schema';
import { CalendarConfigSchema, CalendarSecretsSchema } from './schemas.js';
import { connect } from './connect.js';

import { CalendarExtension } from './extension.js';

export const calendar = defineExtension({
  name: 'calendar',
  configSchema: CalendarConfigSchema,
  secretsSchema: CalendarSecretsSchema,
  create: (ctx) => new CalendarExtension(ctx),
  connect,
});

export { CalendarExtension };
export { discoverGoogleCalendars, type GoogleCalendarEntry } from './google.js';
