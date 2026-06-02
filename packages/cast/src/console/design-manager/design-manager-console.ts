/**
 * DesignManagerConsole — code-declared virtual service at `console:design-manager`.
 *
 * Subclass of `ServerScopeConsole`. DM's delta vs. Config Manager:
 *   - Full-net surface (vs CM's sdk-only) — enforced via `designManagerStrategy.containerNetwork`
 *   - Outbound ACL grants delegation into `__design` (CM's grants into `__configure`)
 *   - `design_manager__create_agents` — batch folder materialization. `createAgent`
 *     dep wired here, overriding `buildConsoleMcpDeps` to merge it on top of the
 *     server-scope defaults.
 */
import type { McpServerDeps } from '../../agent/mcp-server.js';
import { AgentCreateError, createAgentScratch } from '../../admin/agent-create.js';
import type { AgentVerifyResult } from '../../auth/identity.js';
import type { FileWatcher } from '../../lib/file-watcher.js';
import type { Bus } from '../../gateway/bus.js';
import type { Host } from '../../types.js';

import type { ConsoleDb } from '../console-db.js';
import { ServerScopeConsole, type ServerScopeConsoleSpec } from '../shared/server-scope.js';
import type { AdminManual } from '@getcast/admin-schema/v1';
import type { ConsoleMcpDeps, ConsoleMcpContext } from '../strategy.js';

import { DESIGN_MANAGER_DESCRIPTOR } from './descriptor.js';
import { assembleDesignManagerPrompt, buildDesignManagerContext } from './prompt.js';
import { designManagerStrategy } from './strategy.js';

type DiscoverResult =
  | { ok: true; name: string; description?: string; agentAuth: AgentVerifyResult }
  | { ok: false; reason: string };

const DESIGN_MANAGER_HOST: Host = { name: 'design-manager', folder: '.design-manager' };

const DESIGN_MANAGER_SPEC: ServerScopeConsoleSpec = {
  descriptor: DESIGN_MANAGER_DESCRIPTOR,
  host: DESIGN_MANAGER_HOST,
  strategy: designManagerStrategy,
  consoleName: 'design-manager',
  description: 'Design Manager — server-scope orchestrator, proposes multi-agent decompositions',
  buildContext: buildDesignManagerContext,
  assemblePrompt: assembleDesignManagerPrompt,
};

export interface DesignManagerConsoleOpts {
  readonly bus: Bus;
  readonly mcpDeps: McpServerDeps;
  readonly consoleDb: ConsoleDb;
  readonly getAdminManual?: () => AdminManual | undefined;
  readonly getShowManagerSteps?: () => boolean | undefined;
  readonly fileWatcher?: FileWatcher;
  /**
   * Re-runs agent discovery + registration for a folder. Passed in from the
   * server's startup glue so DM can call it when `design_manager__create_agents`
   * writes a new folder. Same callback the fs-watcher + admin UI `agent.create`
   * tRPC procedure use — DM's createAgent dep is a thin wrapper over it.
   */
  readonly discoverAndRegisterAgent: (folder: string) => Promise<DiscoverResult>;
}

export class DesignManagerConsole extends ServerScopeConsole {
  private readonly discoverAndRegisterAgent: (folder: string) => Promise<DiscoverResult>;

  constructor(opts: DesignManagerConsoleOpts) {
    super({
      bus: opts.bus,
      mcpDeps: opts.mcpDeps,
      consoleDb: opts.consoleDb,
      getAdminManual: opts.getAdminManual,
      getShowManagerSteps: opts.getShowManagerSteps,
      fileWatcher: opts.fileWatcher,
      spec: DESIGN_MANAGER_SPEC,
    });
    this.discoverAndRegisterAgent = opts.discoverAndRegisterAgent;
  }

  /**
   * DM's `createAgent` — writes a scratch folder, registers it, fires the
   * invalidation event so DM's own runner picks up the new mount on the next
   * message. Thin wrapper over the same pair `agent.create` tRPC uses.
   */
  private readonly createAgent: NonNullable<ConsoleMcpDeps['createAgent']> = async (name, description) => {
    try {
      createAgentScratch(name, description);
    } catch (err) {
      if (err instanceof AgentCreateError) return { ok: false, reason: err.message };
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const res = await this.discoverAndRegisterAgent(name);
    if (!res.ok) return { ok: false, reason: `Registered on disk but discovery failed: ${res.reason}` };
    // `discoverAndRegisterAgent` called bus.register, which fired the
    // `registered` lifecycle event server-scope consoles consume.
    return { ok: true };
  };

  protected override buildConsoleMcpDeps(): ConsoleMcpDeps {
    return {
      ...super.buildConsoleMcpDeps(),
      createAgent: this.createAgent,
    };
  }
}

// Re-export for tests
export type { ConsoleMcpContext };
