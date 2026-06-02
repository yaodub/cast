/**
 * Unified agent management CLI.
 *
 * Usage:
 *   pnpm agent config [name]                        Configure an agent interactively
 *   pnpm agent list                                 List all agent instances
 */
import * as p from '@clack/prompts';

import { parseFlags } from './helpers.js';
import { initAgent } from './init.js';
import { configAgent } from './config.js';
import { listAgents, listTemplates } from './list.js';
import { checkAgentTemplate } from './check.js';
import { createAgentTemplate } from './create.js';

function templateSubcommand(sub: string | undefined, arg: string | undefined): void | Promise<void> {
  switch (sub) {
    case 'list':
    case 'ls': {
      const flags = parseFlags(4);
      return listTemplates(flags.dir);
    }

    case 'create': {
      const flags = parseFlags(arg ? 5 : 4);
      return createAgentTemplate(arg || undefined, { dir: flags.dir });
    }

    case 'check': {
      if (!arg) {
        p.log.error('Usage: pnpm agent template check <name>');
        process.exit(1);
      }
      const flags = parseFlags(5);
      return checkAgentTemplate(arg, flags.dir);
    }

    default:
      console.log('Agent template commands\n');
      console.log('  pnpm agent template list            List available agent templates');
      console.log('  pnpm agent template create [name]   Create a new agent template interactively');
      console.log('    --dir <path>                      Output directory (default: packages/agent-kit/templates/)');
      console.log('  pnpm agent template check <name>    Validate agent template manifest + staleness\n');
      break;
  }
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  const arg = process.argv[3];

  switch (subcommand) {
    case 'init': {
      if (!arg) {
        p.log.error('Usage: pnpm agent init <name> --template <template>');
        process.exit(1);
      }
      const flags = parseFlags(4);
      if (!flags.template) {
        p.log.error('Missing --template. Usage: pnpm agent init <name> --template <template>');
        process.exit(1);
      }
      await initAgent(arg, flags.template, {
        force: 'force' in flags,
        outputDir: flags.dir,
        withConfig: 'with-config' in flags,
      });
      break;
    }

    case 'config': {
      const flags = parseFlags(arg ? 4 : 3);
      await configAgent(arg || 'main', flags.dir);
      break;
    }

    case 'list':
    case 'ls': {
      const flags = parseFlags(3);
      listAgents(flags.dir);
      break;
    }

    case 'template':
      await templateSubcommand(arg, process.argv[4]);
      break;

    default:
      console.log('Cast Agent Manager\n');
      console.log('  pnpm agent config [name]            Configure agent (model)');
      console.log('  pnpm agent list                     List all agent instances');
      console.log('');
      console.log('  Global options:');
      console.log('    --dir <path>                      Agents directory (default: ~/.cast/agents/, or $CAST_AGENTS_DIR)\n');
      break;
  }
}

main().catch((err) => {
  p.log.error(err.message);
  process.exit(1);
});
