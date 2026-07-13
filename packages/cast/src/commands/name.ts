import type { IdentityProvider } from '../auth/identity.js';
import type { SystemCommandDef } from './types.js';

export function createNameCommand(idp: IdentityProvider): SystemCommandDef {
  return {
    command: '/name',
    description: '/name [name] — show or set your display name',
    handler: (ctx, args) => {
      if (!ctx.identity) {
        return { text: 'No identity is linked to this handle yet.' };
      }

      const name = args.trim();

      // Get mode
      if (!name) {
        const record = idp.getIdentity(ctx.identity);
        if (!record) return { text: 'Identity not found.' };
        return { text: record.declaredName };
      }

      // Set mode
      if (name.length > 64) {
        return { text: 'Name must be 64 characters or fewer.' };
      }
      if (/[\x00-\x1f\x7f]/.test(name)) {
        return { text: 'Name must not contain control characters.' };
      }

      idp.updateDeclaredName(ctx.identity, name);
      return { text: `Name updated to "${name}".` };
    },
  };
}
