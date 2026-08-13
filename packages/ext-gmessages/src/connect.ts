/**
 * Google Messages extension — admin connect hook.
 *
 * connect(): reports pairing status for admin UI display. Pairing itself is
 * handled by the live extension instance's pair() method (cookies in,
 * verification code out, human confirms on the handset) — never here.
 *
 * Deliberately does not open a session: the session store has one writer (the
 * running agent's client), and a second connection would clobber cookie/token
 * rotation. Conversation discovery for the admin picker goes through the live
 * instance, same as ext-whatsapp.
 */
import fs from 'fs';
import path from 'path';

import { GmessagesAdminState } from './schemas.js';

export const SESSION_FILE = 'session.json';

export function isPaired(privateDir: string): boolean {
  return fs.existsSync(path.join(privateDir, SESSION_FILE));
}

type ConnectResult = {
  ok: boolean;
  message: string;
  state?: unknown;
};

export async function connect(ctx: { privateDir: string }): Promise<ConnectResult> {
  if (!isPaired(ctx.privateDir)) {
    const state = GmessagesAdminState.parse({ paired: false });
    return { ok: false, message: 'Not paired — no session found. Pair with cookies from a signed-in browser.', state };
  }
  const state = GmessagesAdminState.parse({ paired: true });
  return { ok: true, message: 'Paired — session present', state };
}
