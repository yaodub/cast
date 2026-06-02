import type { SystemCommandDef } from './types.js';

export function createHelpCommand(commands: SystemCommandDef[]): SystemCommandDef {
  const def: SystemCommandDef = {
    command: '/help',
    description: '/help — show this help',
    handler: () => {
      const lines = ['System commands:'];
      for (const cmd of commands) {
        lines.push(`  ${cmd.description}`);
      }
      // Include self
      lines.push(`  ${def.description}`);
      // Always include /pair in help (handled by gateway, not registered here)
      lines.push('  /pair <code> — pair with an agent using a pairing code');
      return { text: lines.join('\n') };
    },
  };
  return def;
}
