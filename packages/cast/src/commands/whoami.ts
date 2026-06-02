import type { IdentityProvider } from '../auth/identity.js';
import type { SystemCommandDef } from './types.js';

export function createWhoamiCommand(idp: IdentityProvider): SystemCommandDef {
  return {
    command: '/whoami',
    description: '/whoami — show your identity and handles',
    handler: (ctx) => {
      if (!ctx.identity) {
        return { text: `Handle: ${ctx.handle}\nNot paired to any identity.` };
      }

      const record = idp.getIdentity(ctx.identity);
      if (!record) {
        return { text: `Identity: ${ctx.identity}\n(record not found)` };
      }

      const lines = [
        `Identity: ${record.id}`,
        `Name: ${record.declaredName}`,
      ];
      if (record.handles.length > 0) {
        lines.push(`Handles: ${record.handles.join(', ')}`);
      }
      return { text: lines.join('\n') };
    },
  };
}
