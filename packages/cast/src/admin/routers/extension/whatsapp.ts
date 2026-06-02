/**
 * WhatsApp extension admin router — pairing, policy config, unpair.
 *
 * Pairing flow: UI calls `pair` with phone number → server returns 6-digit code →
 * user enters code in WhatsApp → UI polls `getConfig` until `paired` flips to true.
 * Socket lifecycle managed by ext-whatsapp's pair() function.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { isRegistered, WhatsAppExtension } from '@getcast/ext-whatsapp';
import { WhatsAppConfigSchema } from '@getcast/ext-whatsapp/schemas';
import { agentPath } from '../../../config.js';
import { adminProcedure, router } from '../../trpc.js';
import {
  aliasToFolder,
  readExtensionConfig,
  writeExtensionConfig,
  LockableFieldSchema,
} from './helpers.js';

const EXT_NAME = 'whatsapp';
const aliasInput = z.object({ alias: z.string() });
const WhatsAppConfigPartial = WhatsAppConfigSchema.partial();

// getConfig response contract — hybrid (lockable config + live pair/connect/
// chats state). Validated on return; parse failure is a server bug.
const WhatsAppAdminResponseSchema = z.object({
  config: z.record(z.string(), LockableFieldSchema(z.unknown())),
  paired: z.boolean(),
  connected: z.boolean(),
  chats: z.array(z.object({
    jid: z.string(),
    name: z.string(),
    isGroup: z.boolean(),
  })),
});

export const whatsappRouter = router({
  getConfig: adminProcedure.input(aliasInput).query(({ input, ctx }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const config = readExtensionConfig(folder, EXT_NAME);

    const authDir = agentPath(folder, 'ext', EXT_NAME, 'auth');
    const paired = isRegistered(authDir);

    // Query the live extension for chats (avoids opening a competing socket)
    let chats: Array<{ jid: string; name: string; isGroup: boolean }> = [];
    const ext = ctx.deps.getManager(folder)?.getExtension(EXT_NAME) as WhatsAppExtension | undefined;
    const connected = ext?.isConnected() ?? false;
    if (ext) {
      chats = ext.listChatsResolved(500);
    }

    return WhatsAppAdminResponseSchema.parse({ config, paired, connected, chats });
  }),

  setConfig: adminProcedure
    .input(
      z.object({
        alias: z.string(),
        config: WhatsAppConfigPartial,
      }),
    )
    .mutation(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      writeExtensionConfig(folder, EXT_NAME, input.config);
      return { ok: true };
    }),

  /** Start pairing — returns a 6-digit code for the user to enter in WhatsApp. */
  pair: adminProcedure
    .input(z.object({
      alias: z.string(),
      phoneNumber: z.string().min(5),
    }))
    .mutation(async ({ input, ctx }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      const ext = ctx.deps.getManager(folder)?.getExtension(EXT_NAME) as WhatsAppExtension | undefined;
      if (!ext) {
        return { ok: false, message: 'WhatsApp extension not active for this agent' };
      }
      try {
        const code = await ext.pair(input.phoneNumber);
        return { ok: true, code, message: 'Enter this code in WhatsApp → Linked Devices → Link with phone number' };
      } catch (err) {
        return { ok: false, message: `Pairing failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }),

  /**
   * Remove the WhatsApp auth session, forcing a re-pair. Preserves
   * `lid-mapping-*.json` files — those are identity-fact caches (LID ↔ PN
   * for a contact) that remain true across sessions for the same account.
   * Keeping them means a relink re-uses every pair we've ever learned, so
   * dormant contacts don't end up split between PN-form and LID-form chats
   * just because they didn't message us between unpair and relink.
   */
  unpair: adminProcedure.input(aliasInput).mutation(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const authDir = agentPath(folder, 'ext', EXT_NAME, 'auth');
    if (!fs.existsSync(authDir)) return { ok: true };
    for (const name of fs.readdirSync(authDir)) {
      if (name.startsWith('lid-mapping-')) continue;
      fs.rmSync(path.join(authDir, name), { recursive: true, force: true });
    }
    return { ok: true };
  }),
});
