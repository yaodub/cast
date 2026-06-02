/**
 * SecurityManagerConsole — code-declared virtual service at
 * `console:security-manager`.
 *
 * Thin subclass of `ServerScopeConsole`. SM adds zero console-specific deps.
 * Inherits the shared tool surface — including `admin__navigate`, used to
 * dock the page that holds the evidence behind a finding when that helps
 * the operator act on it.
 *
 * See `console/shared/server-scope.ts` for BusHandler, Conversations-façade
 * scope wiring, and invalidation hooks.
 */
import type { McpServerDeps } from '../../agent/mcp-server.js';
import type { FileWatcher } from '../../lib/file-watcher.js';
import type { Bus } from '../../gateway/bus.js';
import type { Host } from '../../types.js';

import type { ConsoleDb } from '../console-db.js';
import { ServerScopeConsole, type ServerScopeConsoleSpec } from '../shared/server-scope.js';
import type { AdminManual } from '@getcast/admin-schema/v1';

import { SECURITY_MANAGER_DESCRIPTOR } from './descriptor.js';
import { assembleSecurityManagerPrompt, buildSecurityManagerContext } from './prompt.js';
import { securityManagerStrategy } from './strategy.js';

const SECURITY_MANAGER_HOST: Host = { name: 'security-manager', folder: '.security-manager' };

const SECURITY_MANAGER_SPEC: ServerScopeConsoleSpec = {
  descriptor: SECURITY_MANAGER_DESCRIPTOR,
  host: SECURITY_MANAGER_HOST,
  strategy: securityManagerStrategy,
  consoleName: 'security-manager',
  description: 'Security Manager — server-scope finalize auditor + conversational posture advisor',
  buildContext: buildSecurityManagerContext,
  assemblePrompt: assembleSecurityManagerPrompt,
};

export interface SecurityManagerConsoleOpts {
  readonly bus: Bus;
  readonly mcpDeps: McpServerDeps;
  readonly consoleDb: ConsoleDb;
  readonly getAdminManual?: () => AdminManual | undefined;
  readonly getShowManagerSteps?: () => boolean | undefined;
  readonly fileWatcher?: FileWatcher;
}

export class SecurityManagerConsole extends ServerScopeConsole {
  constructor(opts: SecurityManagerConsoleOpts) {
    super({
      bus: opts.bus,
      mcpDeps: opts.mcpDeps,
      consoleDb: opts.consoleDb,
      getAdminManual: opts.getAdminManual,
      getShowManagerSteps: opts.getShowManagerSteps,
      fileWatcher: opts.fileWatcher,
      spec: SECURITY_MANAGER_SPEC,
    });
  }
}
