/**
 * ConfigTab form schema + transformer.
 *
 * The form carries string-shaped fields (CSVs, numeric strings) and a
 * flattened backup toggle that doesn't match the server's nested shape.
 * toPayload maps form values to the exported mutation input.
 */
import { z } from 'zod';

import type { AgentConfig } from '@getcast/server/admin';
import type { agentUpdateConfigInput } from '@getcast/server/admin/schemas';

export const ConfigFormSchema = z.object({
  model: z.string(),
  containerNetwork: z.enum(['sdk-only', 'full', 'none']),
  allowedEndpoints: z.string(),
  showSteps: z.boolean(),
  showConsoleSteps: z.boolean(),
  timezone: z.string(),
  backupEnabled: z.boolean(),
  backupRetain: z.string(),
  backupHour: z.string(),
});

export type ConfigFormValues = z.infer<typeof ConfigFormSchema>;

type AgentConfigForUi = AgentConfig;

/** Build initial form values from the server's AgentConfig object. */
export function configFormInitialValues(config: AgentConfigForUi): ConfigFormValues {
  const existingBackup = config.backup;
  const existingEndpoints = config.containerAllowedEndpoints ?? [];
  return {
    model: config.model ?? '',
    containerNetwork: config.containerNetwork ?? 'sdk-only',
    allowedEndpoints: existingEndpoints.join(', '),
    showSteps: config.showSteps !== false,
    showConsoleSteps: config.showConsoleSteps !== false,
    timezone: config.timezone ?? '',
    backupEnabled: !!existingBackup,
    backupRetain: String(existingBackup?.retain ?? 7),
    backupHour: String(existingBackup?.hour ?? 3),
  };
}

/** Build the tRPC mutation payload from form values. */
export function configFormToPayload(
  alias: string,
  v: ConfigFormValues,
): z.infer<typeof agentUpdateConfigInput> {
  const endpoints = v.allowedEndpoints.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    alias,
    model: v.model || undefined,
    containerNetwork: v.containerNetwork,
    containerAllowedEndpoints: endpoints.length > 0 ? endpoints : undefined,
    showSteps: v.showSteps,
    showConsoleSteps: v.showConsoleSteps,
    timezone: v.timezone || undefined,
    backup: v.backupEnabled
      ? {
          retain: parseInt(v.backupRetain, 10) || 7,
          hour: parseInt(v.backupHour, 10) || 3,
        }
      : null,
  };
}
