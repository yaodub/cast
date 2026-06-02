import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';

import { AGENT_TEMPLATES_DIR, PROJECT_ROOT } from './paths.js';
import { bail, writeJson } from './helpers.js';
import { SERVICE_SKELETON } from './templates/service-skeleton.js';

export async function createAgentTemplate(name?: string, opts: { dir?: string } = {}): Promise<void> {
  p.intro('Create agent template');

  // Name
  if (!name) {
    const input = await p.text({
      message: 'Agent template name (kebab-case)',
      placeholder: 'my-bot',
      validate: (v) => {
        if (!v) return 'Name is required';
        if (!/^[a-z][a-z0-9-]*$/.test(v)) return 'Must be kebab-case (lowercase, hyphens, starts with letter)';
        const existing = path.join(opts.dir ?? AGENT_TEMPLATES_DIR, v);
        if (fs.existsSync(existing)) return `Template "${v}" already exists`;
        return undefined;
      },
    });
    if (p.isCancel(input)) bail();
    name = input;
  } else {
    // Validate provided name
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      p.log.error('Name must be kebab-case (lowercase, hyphens, starts with letter)');
      process.exit(1);
    }
    const outputBase = opts.dir ?? AGENT_TEMPLATES_DIR;
    if (fs.existsSync(path.join(outputBase, name))) {
      p.log.error(`Template "${name}" already exists`);
      process.exit(1);
    }
  }

  // Description
  const description = await p.text({
    message: 'What does this agent do?',
    placeholder: 'A helpful assistant that...',
  });
  if (p.isCancel(description)) bail();

  // Service?
  const wantService = await p.confirm({
    message: 'Does this agent need background jobs or custom MCP tools?',
    initialValue: false,
  });
  if (p.isCancel(wantService)) bail();

  // Channels
  const channelChoice = await p.select({
    message: 'Channel configuration',
    options: [
      { value: 'default', label: 'Default only', hint: 'Persistent 4h' },
      { value: 'with-scratch', label: 'Default + scratch', hint: 'Add short-TTL scratch channel' },
      { value: 'with-single-shot', label: 'Default + single-shot', hint: 'Add stateless channel' },
    ],
  });
  if (p.isCancel(channelChoice)) bail();

  // --- Generate files ---
  const outputBase = opts.dir ? path.resolve(opts.dir) : AGENT_TEMPLATES_DIR;
  const templateDir = path.join(outputBase, name);

  // manifest.json
  writeJson(path.join(templateDir, 'manifest.json'), { version: '0.1.0' });

  // identity/prompt.md
  const identityDir = path.join(templateDir, 'identity');
  fs.mkdirSync(identityDir, { recursive: true });
  fs.writeFileSync(
    path.join(identityDir, 'prompt.md'),
    `## What You Can Do\n\n${description}\n`,
  );

  // channels/default/channel.json
  const defaultChannelDir = path.join(templateDir, 'channels', 'default');
  fs.mkdirSync(defaultChannelDir, { recursive: true });
  writeJson(path.join(defaultChannelDir, 'channel.json'), {
    idle_timeout: 1_800_000,
    lifecycle: 'none',
    log_messages: true,
    use_sharding: false,
    disabled_tools: [],
  });

  if (channelChoice === 'with-scratch') {
    const scratchDir = path.join(templateDir, 'channels', 'scratch');
    fs.mkdirSync(scratchDir, { recursive: true });
    writeJson(path.join(scratchDir, 'channel.json'), {
      idle_timeout: 300_000,
      lifecycle: 'bootstrap-only',
      log_messages: true,
      use_sharding: false,
      disabled_tools: [],
    });
    fs.writeFileSync(path.join(scratchDir, 'bootstrap.md'), 'This is a scratch session. Keep responses brief.\n');
  }
  if (channelChoice === 'with-single-shot') {
    const ssDir = path.join(templateDir, 'channels', 'single-shot');
    fs.mkdirSync(ssDir, { recursive: true });
    writeJson(path.join(ssDir, 'channel.json'), {
      idle_timeout: null,
      lifecycle: 'none',
      log_messages: true,
      use_sharding: false,
      disabled_tools: [],
    });
  }

  // props/settings.json + capabilities.json
  const propsDir = path.join(templateDir, 'props');
  fs.mkdirSync(propsDir, { recursive: true });
  writeJson(path.join(propsDir, 'settings.json'), {});
  writeJson(path.join(propsDir, 'capabilities.json'), {
    disabled_tools: [],
    extensions: {},
  });

  // Service files
  if (wantService) {
    const serviceDir = path.join(templateDir, 'service');
    fs.mkdirSync(path.join(serviceDir, 'src', 'jobs'), { recursive: true });

    writeJson(path.join(serviceDir, 'package.json'), {
      name: `@getcast/agent-service-${name}`,
      version: '1.0.0',
      private: true,
      dependencies: {
        'cron-parser': '^5.5.0',
        'dotenv': '^16.4.7',
      },
    });

    writeJson(path.join(serviceDir, 'manifest.json'), {
      name,
      version: '0.1.0',
      jobs: [],
    });

    fs.writeFileSync(path.join(serviceDir, '.env.example'), '');
    fs.writeFileSync(path.join(serviceDir, 'src', 'index.ts'), SERVICE_SKELETON);
  }

  p.log.success(`Created template "${name}" at ${path.relative(PROJECT_ROOT, templateDir)}`);
  p.note(
    [
      `pnpm agent init my-agent --template ${name}    Stamp an instance`,
      `pnpm agent template check ${name}              Validate template`,
    ].join('\n'),
    'Next steps',
  );
  p.outro('');
}
