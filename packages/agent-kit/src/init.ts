import { execSync } from 'child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'crypto';
import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import { z } from 'zod';

import {
  SPEC_VERSION, BLUEPRINT_SUBDIRS, INSTANCE_LAYERS, EPHEMERAL_LAYERS, AgentManifestSchema,
} from '@getcast/agent-schema/v1';

import {
  AGENT_TEMPLATES_DIR, DEFAULT_AGENTS_DIR, PROJECT_ROOT,
} from './paths.js';
import { bail, copyDirRecursive, parseJsonFile, writeJson } from './helpers.js';
import { buildService } from './build-service.js';

/**
 * Initialize an agent instance from a template.
 * Idempotent: safe to re-run. Overwrites blueprint dirs (identity, channels, props, assets, service),
 * never touches instance-owned dirs (config, state, home, memory, ext).
 *
 * @param outputDir Override the agents directory
 */
export async function initAgent(
  name: string,
  templateName: string,
  opts: { force?: boolean; outputDir?: string; withConfig?: boolean } = {},
): Promise<string> {
  const templateDir = path.join(AGENT_TEMPLATES_DIR, templateName);
  if (!fs.existsSync(templateDir)) {
    p.log.error(`Agent template "${templateName}" not found at ${templateDir}`);
    process.exit(1);
  }

  const agentsRoot = opts.outputDir ?? DEFAULT_AGENTS_DIR;
  const agentDir = path.join(agentsRoot, name);
  const exists = fs.existsSync(agentDir);

  if (exists && !opts.force) {
    const confirm = await p.confirm({
      message: `Agent "${name}" already exists. Overwrite blueprint from "${templateName}" template?`,
    });
    if (p.isCancel(confirm) || !confirm) bail();
  }

  // Validate agent name (DNS hostname rules: lowercase alphanumeric + hyphens)
  const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
  if (!NAME_RE.test(name)) {
    p.log.error(`Agent name "${name}" invalid — must be lowercase alphanumeric + hyphens, no leading hyphen`);
    process.exit(1);
  }

  // Create blueprint/ and its subdirs
  for (const sub of BLUEPRINT_SUBDIRS) {
    fs.mkdirSync(path.join(agentDir, 'blueprint', sub), { recursive: true });
  }
  // Create instance and ephemeral dirs
  for (const layer of [...INSTANCE_LAYERS, ...EPHEMERAL_LAYERS]) {
    fs.mkdirSync(path.join(agentDir, layer), { recursive: true });
  }
  // Ensure shared/ext/service/ exists (service-published agent-visible output)
  fs.mkdirSync(path.join(agentDir, 'shared', 'ext', 'service'), { recursive: true });
  // Ensure ext/service/ exists (service private runtime: credentials, DBs, caches)
  fs.mkdirSync(path.join(agentDir, 'ext', 'service'), { recursive: true });

  // Export template authoring surface into blueprint/ via git archive.
  // Templates are git repos; agents are dist — clean export, no history.
  const isGitRepo = fs.existsSync(path.join(templateDir, '.git'));
  const AUTHORING_SURFACE = ['identity', 'channels', 'props', 'assets'] as const;

  for (const layer of AUTHORING_SURFACE) {
    const destDir = path.join(agentDir, 'blueprint', layer);
    // On restamp, clean-replace blueprint dirs — the template is the source of truth.
    if (exists && fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true });
    }
    fs.mkdirSync(destDir, { recursive: true });

    if (isGitRepo) {
      // Git archive exports a clean snapshot — no .git/, no .composer/, no dev/
      try {
        execSync(
          `git archive HEAD -- ${layer}/ | tar -x --strip-components=1 -C "${destDir.replace(/"/g, '\\"')}"`,
          { cwd: templateDir, stdio: 'pipe' },
        );
      } catch {
        // Layer doesn't exist in the template (e.g. no assets/) — skip silently
      }
    } else {
      // Fallback for non-git templates (basic, knowledge, note-taker)
      const templateSrc = path.join(templateDir, layer);
      if (fs.existsSync(templateSrc)) {
        copyDirRecursive(templateSrc, destDir, false);
      }
    }
  }

  // Seed config/acl.json on first init (instance-owned, never overwritten on restamp)
  const aclPath = path.join(agentDir, 'config', 'acl.json');
  if (!fs.existsSync(aclPath)) {
    const defaultAcl = {
      owner: 'local',
      peers: {},
      reject_message: 'Not authorized. Use /pair <code> to get access.',
    };
    fs.writeFileSync(aclPath, JSON.stringify(defaultAcl, null, 2) + '\n');
  }

  // Seed config/agent.json with default backup policy on first init
  const agentJsonPath = path.join(agentDir, 'config', 'agent.json');
  if (!fs.existsSync(agentJsonPath)) {
    const defaultAgentConfig = {
      backup: { retain: 7, hour: 3 },
    };
    fs.writeFileSync(agentJsonPath, JSON.stringify(defaultAgentConfig, null, 2) + '\n');
  }

  // Generate Ed25519 keypair on first init, preserve on restamp. The key
  // lives in secrets/ (not config/) so the Configure console can mount the
  // whole config/ directory without exposing the private key.
  const keyPath = path.join(agentDir, 'secrets', 'agent.key');
  let pubkeyFingerprint: string;
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const der = publicKey.export({ type: 'spki', format: 'der' });
    pubkeyFingerprint = createHash('sha256').update(der).digest('hex').slice(0, 16);
  } else {
    const pem = fs.readFileSync(keyPath, 'utf-8');
    const privateKey = createPrivateKey({ key: pem, format: 'pem' });
    const publicKey = createPublicKey(privateKey);
    const der = publicKey.export({ type: 'spki', format: 'der' });
    pubkeyFingerprint = createHash('sha256').update(der).digest('hex').slice(0, 16);
  }

  // Read template commit for manifest (git repos only)
  let templateCommit: string | undefined;
  if (isGitRepo) {
    templateCommit = execSync('git rev-parse --short HEAD', { cwd: templateDir }).toString().trim();
  }

  // Bundle service via esbuild into blueprint/service/ (build artifacts only, no secrets)
  await buildService(
    path.join(templateDir, 'service'),
    path.join(agentDir, 'blueprint', 'service'),
  );

  // Seed config/ext/service/.env on first init (operator secrets — CM/SM-readable,
  // Configure-writable; dotenv loads it by absolute path from the service CWD)
  const envPath = path.join(agentDir, 'config', 'ext', 'service', '.env');
  if (!fs.existsSync(envPath)) {
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, '');
  }

  // Write manifest.json at folder root — structural metadata
  // spec = agent contract (owned by agent-kit), templateVersion = template's own version
  const templateManifestPath = path.join(templateDir, 'manifest.json');
  const TemplateManifestSchema = z.object({ version: z.string().optional() }).passthrough();
  const templateManifest = parseJsonFile(templateManifestPath, TemplateManifestSchema);
  const templateVersion = templateManifest?.version;
  if (!templateVersion || typeof templateVersion !== 'string') {
    p.log.error(`Agent template "${templateName}" must declare "version" in manifest.json`);
    process.exit(1);
  }
  // Preserve instance-specific fields (name, pubkey, description) from existing manifest on restamp
  const existingManifestPath = path.join(agentDir, 'manifest.json');
  const existingManifest = fs.existsSync(existingManifestPath)
    ? parseJsonFile(existingManifestPath, z.object({
      name: z.string().optional(),
      pubkey: z.string().optional(),
      description: z.string().optional(),
    }).passthrough())
    : null;
  const agentManifest = AgentManifestSchema.parse({
    spec: SPEC_VERSION,
    template: templateName,
    templateVersion,
    ...(templateCommit ? { templateCommit } : {}),
    stampedAt: new Date().toISOString(),
    name: existingManifest?.name ?? name,
    pubkey: existingManifest?.pubkey ?? pubkeyFingerprint,
    ...(existingManifest?.description ? { description: existingManifest.description } : {}),
  });
  writeJson(path.join(agentDir, 'manifest.json'), agentManifest);

  // Print post-init instructions if the template defines them
  const postInitPath = path.join(templateDir, 'POST_INIT.md');
  if (fs.existsSync(postInitPath)) {
    const instructions = fs.readFileSync(postInitPath, 'utf-8').trim();
    p.note(instructions, 'Post-init');
  }

  const verb = exists ? 'updated' : 'created';
  p.log.success(`Agent "${name}" ${verb} from template "${templateName}"`);

  if (!exists) {
    p.note(
      [
        'manifest.json          Agent identity and stamp metadata',
        'blueprint/identity/    System prompt, skills (read-only)',
        'blueprint/channels/    Channel configs, lifecycle prompts (read-only)',
        'blueprint/props/       Settings, schedule (read-only)',
        'blueprint/service/     Service (compiled or source)',
        'blueprint/assets/      Static reference data (read-only)',
        'config/                Operator config (model, ACL, extension .env + config.json)',
        'ext/service/           Service private runtime (credentials, DBs, caches)',
        'shared/ext/service/    Service-published output (agent-visible, read-only at /shared/service)',
        'state/                 Server-managed state (conversations, tasks)',
        'home/                  Working directory (read-write)',
        'memory/                Agent memory (read-write)',
      ].join('\n'),
      path.relative(PROJECT_ROOT, agentDir),
    );
    p.log.info(`Run \`pnpm agent config ${name}\` to configure.`);
  }

  return agentDir;
}
