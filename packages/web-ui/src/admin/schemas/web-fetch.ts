/**
 * WebFetch extension form schema + transformer.
 *
 * Extension form pattern: the server emits a per-field LockableField envelope
 * with `value: unknown`; the form narrows each value to its expected type.
 * Lock metadata on each field comes from the serverContext (the getConfig
 * query result) — locked fields are omitted from the payload.
 */
import type { inferRouterOutputs } from '@trpc/server';
import { z } from 'zod';

import type { AppRouter } from '@getcast/server/admin';

export const WebFetchFormSchema = z.object({
  fetchMode: z.enum(['open', 'approval', 'disabled']),
  allowedDomains: z.array(z.string()),
  blockedDomains: z.array(z.string()),
  allowQueryStrings: z.boolean(),
});

export type WebFetchFormValues = z.infer<typeof WebFetchFormSchema>;

export type WebFetchServerData = inferRouterOutputs<AppRouter>['extension']['webFetch']['getConfig'];

export function webFetchFormInitialValues(data: WebFetchServerData): WebFetchFormValues {
  const c = data.config;
  return {
    fetchMode: (String(c.fetch_mode?.value ?? 'approval') as 'open' | 'approval' | 'disabled'),
    allowedDomains: Array.isArray(c.allowed_domains?.value) ? c.allowed_domains!.value as string[] : [],
    blockedDomains: Array.isArray(c.blocked_domains?.value) ? c.blocked_domains!.value as string[] : [],
    allowQueryStrings: c.allow_query_strings?.value !== false,
  };
}

export function webFetchFormToPayload(
  alias: string,
  v: WebFetchFormValues,
  data: WebFetchServerData,
): { alias: string; config: Record<string, unknown> } {
  const config: Record<string, unknown> = {};
  const c = data.config;
  if (!c.fetch_mode?.locked) config['fetch_mode'] = v.fetchMode;
  if (!c.allowed_domains?.locked) config['allowed_domains'] = v.allowedDomains;
  if (!c.blocked_domains?.locked) config['blocked_domains'] = v.blockedDomains;
  if (!c.allow_query_strings?.locked) config['allow_query_strings'] = v.allowQueryStrings;
  return { alias, config };
}
