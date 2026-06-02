/**
 * ConfigManagerConsole — code-declared virtual agent at `console:config-manager`.
 *
 * Thin subclass of `ServerScopeConsole` — CM adds no console-specific deps
 * beyond the base's default set. See `console/shared/server-scope.ts` for
 * the BusHandler, Conversations-façade scope wiring, and invalidation hooks.
 */
import type { McpServerDeps } from '../../agent/mcp-server.js';
import type { FileWatcher } from '../../lib/file-watcher.js';
import type { Bus } from '../../gateway/bus.js';
import type { Host } from '../../types.js';

import type { ConsoleDb } from '../console-db.js';
import { ServerScopeConsole, type ServerScopeConsoleSpec } from '../shared/server-scope.js';
import type { AdminManual } from '@getcast/admin-schema/v1';

import { CONFIG_MANAGER_DESCRIPTOR } from './descriptor.js';
import { assembleConfigManagerPrompt, buildConfigManagerContext } from './prompt.js';
import { configManagerStrategy } from './strategy.js';

const CONFIG_MANAGER_HOST: Host = { name: 'config-manager', folder: '.config-manager' };

const CONFIG_MANAGER_SPEC: ServerScopeConsoleSpec = {
  descriptor: CONFIG_MANAGER_DESCRIPTOR,
  host: CONFIG_MANAGER_HOST,
  strategy: configManagerStrategy,
  consoleName: 'config-manager',
  description: 'Config Manager — server-scope auditor + intra-surface mutator',
  buildContext: buildConfigManagerContext,
  assemblePrompt: assembleConfigManagerPrompt,
};

export interface ConfigManagerConsoleOpts {
  readonly bus: Bus;
  readonly mcpDeps: McpServerDeps;
  readonly consoleDb: ConsoleDb;
  readonly getAdminManual?: () => AdminManual | undefined;
  readonly getShowManagerSteps?: () => boolean | undefined;
  readonly fileWatcher?: FileWatcher;
}

export class ConfigManagerConsole extends ServerScopeConsole {
  constructor(opts: ConfigManagerConsoleOpts) {
    super({
      bus: opts.bus,
      mcpDeps: opts.mcpDeps,
      consoleDb: opts.consoleDb,
      getAdminManual: opts.getAdminManual,
      getShowManagerSteps: opts.getShowManagerSteps,
      fileWatcher: opts.fileWatcher,
      spec: CONFIG_MANAGER_SPEC,
    });
  }
}
