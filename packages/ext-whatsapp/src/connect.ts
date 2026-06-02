/**
 * WhatsApp extension — admin connect hook.
 *
 * connect(): checks auth session status for admin UI display.
 * Pairing is handled by ConnectionManager.pair() via the live extension instance.
 */
import path from 'path';

import { WhatsAppAdminState } from './schemas.js';
import { isRegistered } from './helpers.js';

type ConnectResult = {
  ok: boolean;
  message: string;
  state?: unknown;
};

export async function connect(ctx: { privateDir: string }): Promise<ConnectResult> {
  const authDir = path.join(ctx.privateDir, 'auth');
  if (!isRegistered(authDir)) {
    const state = WhatsAppAdminState.parse({ paired: false, chats: [] });
    return { ok: false, message: 'Not paired — no auth session found', state };
  }

  // Don't spin up a second Baileys socket — it conflicts with the running agent's
  // connection (WhatsApp kicks one out with 440 before chats sync). Just report paired status.
  // Chat discovery happens via the live extension's MCP tools, not the admin hook.
  const state = WhatsAppAdminState.parse({ paired: true, chats: [] });
  return { ok: true, message: 'Paired — device linked', state };
}
