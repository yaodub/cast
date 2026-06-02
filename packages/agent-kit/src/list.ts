import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import { z } from 'zod';
import { AgentManifestSchema, AgentConfigSchema } from '@getcast/agent-schema/v1';

import { DEFAULT_AGENTS_DIR, AGENT_TEMPLATES_DIR } from './paths.js';
import { listAgentFolders, listSubdirectories, parseJsonFile } from './helpers.js';

export function listAgents(agentsDir = DEFAULT_AGENTS_DIR): void {
  const folders = listAgentFolders(agentsDir);
  if (folders.length === 0) {
    p.log.info('No agents found. Run `pnpm agent create <name>` to create one.');
    return;
  }

  p.intro('Agents');

  for (const folder of folders) {
    const agentManifest = parseJsonFile(path.join(agentsDir, folder, 'manifest.json'), AgentManifestSchema);
    const config = parseJsonFile(path.join(agentsDir, folder, 'config', 'agent.json'), AgentConfigSchema);

    const templateName = agentManifest?.template ?? '?';
    const templateVersion = agentManifest?.templateVersion ?? '?';
    const model = config?.model ?? '(default)';

    p.log.step(`${folder}  |  template: ${templateName}@${templateVersion}  |  model: ${model}`);
  }

  p.outro('');
}

export function listTemplates(agentsDir = DEFAULT_AGENTS_DIR): void {
  const templates = listSubdirectories(AGENT_TEMPLATES_DIR);
  if (templates.length === 0) {
    p.log.info('No agent templates found. Run `pnpm agent template create` to create one.');
    return;
  }

  // Count stamped agents per template
  const agents = listAgentFolders(agentsDir);
  const countByTemplate: Record<string, number> = {};
  for (const folder of agents) {
    const manifest = parseJsonFile(path.join(agentsDir, folder, 'manifest.json'), AgentManifestSchema);
    const t = manifest?.template ?? '';
    if (t) countByTemplate[t] = (countByTemplate[t] ?? 0) + 1;
  }

  p.intro('Agent templates');

  for (const name of templates) {
    const templateDir = path.join(AGENT_TEMPLATES_DIR, name);
    const TemplateManifestSchema = z.object({ version: z.string().optional() }).passthrough();
    const manifest = parseJsonFile(path.join(templateDir, 'manifest.json'), TemplateManifestSchema);
    const version = manifest?.version ?? '?';
    const hasService = fs.existsSync(path.join(templateDir, 'service', 'src', 'index.ts'));
    const count = countByTemplate[name] ?? 0;

    p.log.step(`${name}@${version}  |  service: ${hasService ? 'yes' : 'no'}  |  agents: ${count}`);
  }

  p.outro('');
}
