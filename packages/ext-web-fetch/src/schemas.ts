/**
 * Web-fetch extension schemas — config and capability types.
 *
 * Lives in this package because the schemas are extension-specific and
 * have no cross-boundary consumers.
 */
import { z } from 'zod';

/** Per-agent web-fetch security policy (props/capabilities.json → extensions.web-fetch). */
export const WebFetchPolicySchema = z.object({
  fetch_mode: z.enum(['disabled', 'approval', 'open']).default('approval'),
  allowed_domains: z.array(z.string()).default([]),
  blocked_domains: z.array(z.string()).default([]),
  allow_query_strings: z.boolean().default(true),
});
export type WebFetchPolicy = z.infer<typeof WebFetchPolicySchema>;

/** Web-fetch capability request. */
export const FetchRequestSchema = z.object({
  url: z.string(),
  pipelines: z.array(z.string()).optional(),
});
export type FetchRequest = z.infer<typeof FetchRequestSchema>;

/** Web-fetch capability result. */
export const FetchResultSchema = z.object({
  meta: z.object({
    url: z.string(),
    title: z.string(),
    description: z.string(),
    contentType: z.string(),
    fetchedAt: z.string(),
    sizes: z.record(
      z.string(),
      z.object({ bytes: z.number(), tokens: z.number() }),
    ),
  }),
  files: z.record(z.string(), z.string()),
  encoding: z.enum(['base64']).optional(),
  ext: z.string().optional(),
});
export type FetchResult = z.infer<typeof FetchResultSchema>;
