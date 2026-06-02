/**
 * Per-agent summary projection for cross-agent listings.
 *
 * Three manager-console prompt builders (config-manager, design-manager,
 * security-manager) each enumerate `mnt/agents/*` and render a row per
 * agent. They all need the same projection: name, description, status —
 * with sane fallbacks when the manifest is missing or unparseable.
 *
 * `console-builders.ts` reads more fields (template, templateVersion) for
 * the per-agent ConsoleContext and intentionally does NOT use this helper.
 */
import { AgentManifestSchema } from '@getcast/agent-schema/v1';

import { agentPath } from '../../config.js';
import { readText } from '../../lib/config-reader.js';
import { parseJsonSafe } from '../../lib/utils.js';

export interface AgentSummary {
  folder: string;
  name: string;
  description: string | undefined;
  status: 'draft' | 'ready' | undefined;
}

export function loadAgentSummary(folder: string): AgentSummary {
  const raw = readText(agentPath(folder, 'manifest.json'));
  if (!raw) return { folder, name: folder, description: undefined, status: undefined };
  const parsed = parseJsonSafe(raw, AgentManifestSchema);
  if (!parsed) return { folder, name: folder, description: undefined, status: undefined };
  return {
    folder,
    name: parsed.name ?? folder,
    description: parsed.description,
    status: parsed.status === 'draft' ? 'draft' : 'ready',
  };
}
