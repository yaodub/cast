import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import {
  AgentManifestSchema,
  CapabilitiesSchema,
  McpServerSecretsSchema,
  ProvisionsSchema,
  isUnlocked,
} from '@getcast/agent-schema/v1';

import { AGENT_TEMPLATES_DIR, DEFAULT_AGENTS_DIR } from './paths.js';
import { errorMessage, listAgentFolders, parseJsonFile } from './helpers.js';
import { computeTemplateServiceChecksum } from './build-service.js';

const TemplateManifestSchema = z.object({ version: z.string().optional() }).passthrough();

const ServiceManifestSchema = z.object({
  entry: z.string().optional(),
  jobs: z.array(z.object({
    name: z.string(),
    schedule: z.string(),
    script: z.string(),
  })).default([]),
}).passthrough();

export async function checkAgentTemplate(templateName: string, agentsDir = DEFAULT_AGENTS_DIR): Promise<void> {
  const templateDir = path.join(AGENT_TEMPLATES_DIR, templateName);
  if (!fs.existsSync(templateDir)) {
    p.log.error(`Agent template "${templateName}" not found at ${templateDir}`);
    process.exit(1);
  }

  p.intro(`Checking agent template: ${templateName}`);
  let hasErrors = false;

  // Check required directories
  for (const dir of ['identity', 'service']) {
    const dirPath = path.join(templateDir, dir);
    if (fs.existsSync(dirPath)) {
      p.log.step(`${dir}/  ✓`);
    } else {
      p.log.warn(`${dir}/  missing`);
    }
  }

  // Check system prompt
  const promptPath = path.join(templateDir, 'identity', 'prompt.md');
  if (fs.existsSync(promptPath)) {
    const content = fs.readFileSync(promptPath, 'utf-8');
    p.log.step(`identity/prompt.md  ✓  (${content.length} chars)`);
  } else {
    p.log.warn('identity/prompt.md  missing');
  }

  // Check service manifest
  const manifestPath = path.join(templateDir, 'service', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = ServiceManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
      const jobs = manifest.jobs;
      const serviceDir = path.join(templateDir, 'service');

      for (const job of jobs) {
        const scriptPath = path.resolve(serviceDir, job.script);
        if (!fs.existsSync(scriptPath)) {
          p.log.error(`  Job script not found: ${job.script}`);
          hasErrors = true;
        }
        try {
          CronExpressionParser.parse(job.schedule);
        } catch {
          p.log.error(`  Invalid cron for job "${job.name}": ${job.schedule}`);
          hasErrors = true;
        }
      }

      if (!hasErrors) {
        p.log.step(`service/manifest.json  ✓  (${jobs.length} jobs)`);
      }
    } catch (err) {
      p.log.error(`service/manifest.json  invalid: ${errorMessage(err)}`);
      hasErrors = true;
    }
  } else {
    p.log.step('service/manifest.json  (none)');
  }

  // Check channels directory
  const channelsDir = path.join(templateDir, 'channels');
  if (fs.existsSync(channelsDir)) {
    const channelEntries = fs.readdirSync(channelsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'));
    for (const entry of channelEntries) {
      if (!/^[a-z][a-z0-9-]*$/.test(entry.name)) {
        p.log.error(`channels/${entry.name}/  invalid name (must be lowercase alphanumeric + hyphens, no leading digit)`);
        hasErrors = true;
        continue;
      }
      const chJsonPath = path.join(channelsDir, entry.name, 'channel.json');
      if (fs.existsSync(chJsonPath)) {
        try {
          JSON.parse(fs.readFileSync(chJsonPath, 'utf-8'));
          p.log.step(`channels/${entry.name}/channel.json  ✓`);
        } catch {
          p.log.error(`channels/${entry.name}/channel.json  invalid JSON`);
          hasErrors = true;
        }
      } else {
        p.log.error(`channels/${entry.name}/  missing channel.json`);
        hasErrors = true;
      }
    }
    if (!channelEntries.length) {
      p.log.warn('channels/  empty');
    }
  }

  // Check settings files
  for (const settingsFile of ['settings.json', 'sdk-settings.json']) {
    const settingsPath = path.join(templateDir, 'props', settingsFile);
    if (fs.existsSync(settingsPath)) {
      try {
        JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        p.log.step(`props/${settingsFile}  ✓`);
      } catch {
        p.log.error(`props/${settingsFile}  invalid JSON`);
        hasErrors = true;
      }
    }
  }

  if (hasErrors) {
    p.outro('Validation failed');
    process.exit(1);
  }

  // Staleness detection: compare stamped agents against fresh build
  const templateServiceDir = path.join(templateDir, 'service');
  if (fs.existsSync(path.join(templateServiceDir, 'src', 'index.ts'))) {
    p.log.step('Checking service staleness...');
    const freshChecksum = await computeTemplateServiceChecksum(templateServiceDir);
    if (freshChecksum) {
      const agents = listAgentFolders(agentsDir);
      const templateManifest = parseJsonFile(path.join(templateDir, 'manifest.json'), TemplateManifestSchema);
      const currentTemplateVersion = templateManifest?.version ?? '?';
      let anyStamped = false;

      for (const folder of agents) {
        const manifest = parseJsonFile(path.join(agentsDir, folder, 'manifest.json'), AgentManifestSchema);
        if (!manifest || manifest.template !== templateName) continue;
        anyStamped = true;

        const checksumPath = path.join(agentsDir, folder, 'blueprint', 'service', 'checksum.txt');
        const agentChecksum = fs.existsSync(checksumPath)
          ? fs.readFileSync(checksumPath, 'utf-8').trim()
          : null;

        if (agentChecksum === freshChecksum) {
          p.log.step(`  ${folder}: current`);
        } else {
          const stampedVersion = manifest.templateVersion ?? '?';
          p.log.warn(`  ${folder}: stale (stamped from ${templateName}@${stampedVersion}, current: ${templateName}@${currentTemplateVersion}, service changed)`);
        }
      }

      if (!anyStamped) {
        p.log.step('  No agents stamped from this template');
      }
    }
  }

  // Validate provisions against capabilities for stamped instances
  const capsPath = path.join(templateDir, 'props', 'capabilities.json');
  if (fs.existsSync(capsPath)) {
    try {
      const caps = CapabilitiesSchema.parse(JSON.parse(fs.readFileSync(capsPath, 'utf-8')));
      const agents = listAgentFolders(agentsDir);
      for (const folder of agents) {
        const manifest = parseJsonFile(path.join(agentsDir, folder, 'manifest.json'), AgentManifestSchema);
        if (!manifest || manifest.template !== templateName) continue;
        const provisionsPath = path.join(agentsDir, folder, 'config', 'provisions.json');
        if (!fs.existsSync(provisionsPath)) {
          // Check if any resource slots are required
          const requiredSlots = Object.entries(caps.resources).filter(([, s]) => s.required);
          if (requiredSlots.length > 0) {
            for (const [name] of requiredSlots) {
              p.log.error(`  ${folder}: required resource "${name}" has no provisions.json`);
              hasErrors = true;
            }
          }
          continue;
        }
        const provisions = parseJsonFile(provisionsPath, ProvisionsSchema);
        if (!provisions) {
          p.log.error(`  ${folder}: provisions.json is invalid`);
          hasErrors = true;
          continue;
        }
        // Required resource slots must have paths
        for (const [name, slot] of Object.entries(caps.resources)) {
          if (slot.required && !provisions.resources[name]) {
            p.log.error(`  ${folder}: required resource "${name}" not provisioned`);
            hasErrors = true;
          }
        }
        // Unknown resource keys in provisions
        for (const name of Object.keys(provisions.resources)) {
          if (!(name in caps.resources)) {
            p.log.warn(`  ${folder}: provisions.json has unknown resource "${name}"`);
          }
        }
        // Resource access not escalated
        for (const [name, provision] of Object.entries(provisions.resources)) {
          const slot = caps.resources[name];
          if (!slot) continue;
          const provAccess = typeof provision === 'string' ? undefined : provision.access;
          if (provAccess === 'rw' && slot.access === 'ro') {
            p.log.error(`  ${folder}: resource "${name}" access escalated (slot is ro, provision is rw)`);
            hasErrors = true;
          }
        }
        // pip extra_packages only if unlocked
        if (provisions.pip?.extra_packages?.length) {
          if (!caps.pip || !isUnlocked(caps.pip.extra_packages)) {
            p.log.error(`  ${folder}: provisions.json has pip.extra_packages but capabilities does not unlock it`);
            hasErrors = true;
          }
          // No wildcards in pip extra_packages
          for (const pkg of provisions.pip.extra_packages) {
            if (pkg.includes('*')) {
              p.log.error(`  ${folder}: pip extra_packages "${pkg}" contains wildcard — must be exact package name`);
              hasErrors = true;
            }
          }
        }
        // additional_disabled_tools only if unlocked
        if (provisions.additional_disabled_tools.length > 0) {
          if (!isUnlocked(caps.additional_disabled_tools)) {
            p.log.error(`  ${folder}: provisions.json has additional_disabled_tools but capabilities does not unlock it`);
            hasErrors = true;
          }
        }
        if (!hasErrors) {
          p.log.step(`  ${folder}: provisions valid`);
        }
      }
    } catch {
      p.log.warn('props/capabilities.json invalid — skipping provisions validation');
    }
  }

  // Validate MCP server declarations
  if (fs.existsSync(capsPath)) {
    try {
      const caps = CapabilitiesSchema.parse(JSON.parse(fs.readFileSync(capsPath, 'utf-8')));
      const mcpServers = Object.entries(caps.mcp_servers);
      if (mcpServers.length > 0) {
        p.log.step(`MCP servers: ${mcpServers.length} declared`);
        for (const [name, decl] of mcpServers) {
          // Transport-specific field validation
          if (decl.transport === 'stdio' && !decl.command) {
            p.log.error(`  mcp_servers.${name}: stdio transport requires "command"`);
            hasErrors = true;
          }
          if ((decl.transport === 'sse' || decl.transport === 'streamable-http') && !decl.url) {
            p.log.error(`  mcp_servers.${name}: ${decl.transport} transport requires "url"`);
            hasErrors = true;
          }

          // Check required env slots are provisioned in stamped instances
          const requiredEnvSlots = Object.entries(decl.env).filter(
            ([, slot]) => typeof slot === 'object' && slot.unlocked && slot.required,
          );
          if (requiredEnvSlots.length > 0) {
            const agents = listAgentFolders(agentsDir);
            for (const folder of agents) {
              const manifest = parseJsonFile(path.join(agentsDir, folder, 'manifest.json'), AgentManifestSchema);
              if (!manifest || manifest.template !== templateName) continue;
              const secretsPath = path.join(agentsDir, folder, 'config', 'mcp-servers.json');
              const secrets = fs.existsSync(secretsPath)
                ? parseJsonFile(secretsPath, McpServerSecretsSchema) ?? {}
                : {};
              const serverSecrets = secrets[name] ?? {};
              for (const [key] of requiredEnvSlots) {
                if (!serverSecrets[key]) {
                  p.log.error(`  ${folder}: MCP server "${name}" requires env "${key}" — not provisioned in config/mcp-servers.json`);
                  hasErrors = true;
                }
              }
            }
          }

          if (!hasErrors) {
            p.log.step(`  ${name}: ${decl.transport}  ✓`);
          }
        }
      }
    } catch {
      // capabilities.json already validated above
    }
  }

  if (hasErrors) {
    p.outro('Validation failed');
    process.exit(1);
  }
  p.outro('All checks passed');
}
