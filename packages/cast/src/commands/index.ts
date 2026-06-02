/**
 * System commands — server-level commands dispatched before reaching the agent.
 *
 * Commands start with `/` and are handled synchronously. Unknown `/` commands
 * return null (fall through to agent). Non-`/` text is never matched.
 */
import type { IdentityProvider } from '../auth/identity.js';
import { createHelpCommand } from './help.js';
import { createNameCommand } from './name.js';
import { createWhoamiCommand } from './whoami.js';
import type { SystemCommandContext, SystemCommandResult, SystemCommandDef } from './types.js';

export type { SystemCommandContext, SystemCommandResult, SystemCommandDef };

export class SystemCommandDispatcher {
  private commands = new Map<string, SystemCommandDef>();

  constructor(idp: IdentityProvider) {
    // Register built-in commands
    const name = createNameCommand(idp);
    const whoami = createWhoamiCommand(idp);

    this.register(name);
    this.register(whoami);

    // Help is last — it reads the registry to auto-generate output
    const help = createHelpCommand([name, whoami]);
    this.register(help);
  }

  /** Register a command definition. */
  register(def: SystemCommandDef): void {
    this.commands.set(def.command, def);
  }

  /** All registered command definitions (for transport menu registration). */
  listCommands(): SystemCommandDef[] {
    return [...this.commands.values()];
  }

  /**
   * Try to dispatch a system command.
   * Returns a response if handled, null if not a system command.
   */
  dispatch(ctx: SystemCommandContext, rawText: string): SystemCommandResult | null {
    const trimmed = rawText.trim();
    if (!trimmed.startsWith('/')) return null;

    const spaceIdx = trimmed.indexOf(' ');
    const command = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    const def = this.commands.get(command);
    if (!def) return null;

    return def.handler(ctx, args);
  }
}
