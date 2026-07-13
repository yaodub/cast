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
      return { text: lines.join('\n') };
    },
  };
  return def;
}
