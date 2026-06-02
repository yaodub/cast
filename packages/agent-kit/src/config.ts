import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import { AgentConfigSchema } from '@getcast/agent-schema/v1';

import { DEFAULT_AGENTS_DIR, MODELS } from './paths.js';
import { bail, parseJsonFile, writeJson } from './helpers.js';

export async function configAgent(name: string, agentsDir = DEFAULT_AGENTS_DIR): Promise<void> {
  const agentDir = path.join(agentsDir, name);
  if (!fs.existsSync(agentDir)) {
    p.log.error(`Agent "${name}" not found. Run \`pnpm agent create ${name}\` first.`);
    process.exit(1);
  }

  p.intro(`Configure agent: ${name}`);

  const configPath = path.join(agentDir, 'config', 'agent.json');
  const config: Record<string, unknown> = parseJsonFile(configPath, AgentConfigSchema.passthrough()) ?? {};
  const currentModel = typeof config.model === 'string' ? config.model : undefined;

  // --- Model selection ---
  const initialValue = MODELS.find((m) => m.value === currentModel)?.value ?? MODELS[0]!.value;

  const model = await p.select({
    message: `Model${currentModel ? ` (current: ${currentModel})` : ''}`,
    options: MODELS,
    initialValue,
  });
  if (p.isCancel(model)) bail();

  if (model !== currentModel) {
    config.model = model;
    writeJson(configPath, AgentConfigSchema.parse(config));
    p.log.success(`Model set to ${model}`);
  } else {
    p.log.step(`Model unchanged: ${model}`);
  }

  p.outro('Done. Restart Cast to apply changes.');
}
