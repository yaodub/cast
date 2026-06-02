/**
 * ProvisionsTab form schema + transformer.
 *
 * Form stores CSV strings for extra packages and disabled tools; mutation
 * expects arrays. Resources map keyed by slot name.
 */
import { z } from 'zod';
import type { agentUpdateProvisionsInput } from '@getcast/server/admin/schemas';

export const ProvisionsFormSchema = z.object({
  resources: z.record(z.string(), z.string()),
  extraPackages: z.string(),
  disabledTools: z.string(),
});

export type ProvisionsFormValues = z.infer<typeof ProvisionsFormSchema>;

/** Server-side provisions query result shape. Mirrors the getProvisions
 *  tRPC return so the form can render + transform it without extra casts. */
export interface ProvisionsServerData {
  resources: Array<{
    name: string;
    description: string | null;
    access: 'ro' | 'rw';
    required: boolean;
    provisionedPath: string | null;
    provisionedAccess: 'ro' | 'rw' | null;
  }>;
  pip: {
    allowedPackages: string[];
    extraPackagesUnlocked: boolean;
    extraPackages: string[];
  } | null;
  additionalDisabledTools: {
    unlocked: boolean;
    values: string[];
  };
}

export function provisionsFormInitialValues(data: ProvisionsServerData): ProvisionsFormValues {
  const resources: Record<string, string> = {};
  for (const r of data.resources) resources[r.name] = r.provisionedPath ?? '';
  return {
    resources,
    extraPackages: data.pip?.extraPackages.join(', ') ?? '',
    disabledTools: data.additionalDisabledTools.unlocked
      ? data.additionalDisabledTools.values.join(', ')
      : '',
  };
}

export function provisionsFormToPayload(
  alias: string,
  v: ProvisionsFormValues,
  data: ProvisionsServerData,
): z.infer<typeof agentUpdateProvisionsInput> {
  const resources: Record<string, string | null> = {};
  for (const [name, path] of Object.entries(v.resources)) {
    resources[name] = path.trim() || null;
  }
  return {
    alias,
    resources: data.resources.length > 0 ? resources : undefined,
    pipExtraPackages: data.pip?.extraPackagesUnlocked
      ? v.extraPackages.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
    additionalDisabledTools: data.additionalDisabledTools.unlocked
      ? v.disabledTools.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
  };
}
