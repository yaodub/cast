/**
 * Mutation input schemas shared between server and admin UI.
 *
 * This module has zero server-side dependencies (no express, trpc, fs).
 * The admin web UI imports these directly as form resolvers via
 * `@getcast/server/admin/schemas`, and the tRPC routers reference them as
 * their `.input()` shapes. Single source of truth; form/mutation drift
 * becomes a compile error.
 */
import { z } from 'zod';

/**
 * Agent folder/name constraint. Lowercase alphanumeric plus hyphens, must
 * start with a letter or digit. The 64-char cap aligns with HOST_NAME_MAX /
 * DNS label conventions and is purely a UX guardrail — Cast itself only
 * requires the folder to be a valid filesystem name component.
 */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const AGENT_NAME_MAX_LENGTH = 64;
export const agentNameSchema = z
  .string()
  .regex(AGENT_NAME_RE, 'must be lowercase alphanumeric plus hyphens')
  .max(AGENT_NAME_MAX_LENGTH, `must be ${AGENT_NAME_MAX_LENGTH} characters or fewer`);

export const serverUpdateConfigInput = z.object({
  consoleModel: z.string().nullable().optional(),
  showManagerSteps: z.boolean().optional(),
  consoleIsolation: z.enum(['normal', 'strict']).optional(),
});

export const updateCredentialsInput = z.object({
  authMode: z.enum(['api-key', 'setup-token']),
  apiKey: z.string().optional(),
  oauthToken: z.string().optional(),
});

export const agentUpdateConfigInput = z.object({
  alias: z.string(),
  model: z.string().optional(),
  containerNetwork: z.enum(['sdk-only', 'full', 'none']).optional(),
  containerAllowedEndpoints: z.array(z.string()).optional(),
  showSteps: z.boolean().optional(),
  showConsoleSteps: z.boolean().optional(),
  timezone: z.string().optional(),
  backup: z.object({
    retain: z.number().int().min(1),
    hour: z.number().int().min(0).max(23).default(3),
  }).nullable().optional(),
});

export const agentUpdateProvisionsInput = z.object({
  alias: z.string(),
  resources: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
  pipExtraPackages: z.array(z.string()).optional(),
  additionalDisabledTools: z.array(z.string()).optional(),
});

// Routes — generic registry-driven shape. Each transport's per-entry shape is
// validated downstream by its registered `configSchema`; here we guarantee
// only the address/channel/fields envelope. Field values are unknown because
// each transport's descriptor declares its own field types.
export const routeEntryInput = z.object({
  address: z.string().min(1),
  channel: z.string().optional(),
  fields: z.record(z.string(), z.unknown()),
});

export const routeUpdateInput = z.object({
  byType: z.record(z.string(), z.array(routeEntryInput)),
});

export const mcpServerSetEnvInput = z.object({
  alias: z.string(),
  server: z.string(),
  env: z.record(z.string(), z.string()),
});
