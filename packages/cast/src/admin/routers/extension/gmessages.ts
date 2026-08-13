/**
 * Google Messages extension admin router — pairing, policy config, unpair.
 *
 * Pairing flow: UI posts a signed-in account's cookies → `pair` starts the
 * handshake and returns the verification code → the HANDSET then shows a
 * request carrying the same code, which the user approves there → the UI polls
 * `getConfig` until `paired` flips.
 *
 * The ordering above is load-bearing and counterintuitive: the phone cannot
 * display anything until the finish request goes out, and finish goes out as
 * soon as the code is shown. So the code is returned immediately and the
 * approval happens after — never wait for the tap before returning.
 *
 * Conversation discovery goes through the LIVE extension instance, never a
 * second connection: the session store has one writer, and a competing client
 * would clobber cookie/token rotation.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { GmessagesExtension, isPaired } from '@getcast/ext-gmessages';
import { GmessagesConfigSchema } from '@getcast/ext-gmessages/schemas';
import { agentPath } from '../../../config.js';
import { adminProcedure, router } from '../../trpc.js';
import {
  aliasToFolder,
  readExtensionConfig,
  writeExtensionConfig,
  LockableFieldSchema,
} from './helpers.js';

const EXT_NAME = 'gmessages';
const aliasInput = z.object({ alias: z.string() });
const GmessagesConfigPartial = GmessagesConfigSchema.partial();

/** getConfig response — lockable config plus live pair/connect/conversation state. */
const GmessagesAdminResponseSchema = z.object({
  config: z.record(z.string(), LockableFieldSchema(z.unknown())),
  paired: z.boolean(),
  connected: z.boolean(),
  conversations: z.array(
    z.object({
      conversationId: z.string(),
      label: z.string(),
      kind: z.enum(['sms', 'rcs', 'unknown']),
    }),
  ),
});

const liveExtension = (
  ctx: { deps: { getManager: (folder: string) => { getExtension: (name: string) => unknown } | undefined } },
  folder: string,
): GmessagesExtension | undefined =>
  ctx.deps.getManager(folder)?.getExtension(EXT_NAME) as GmessagesExtension | undefined;

/**
 * In-flight pairing state, per agent.
 *
 * `pairFromCookies` does not resolve until the relay answers the FINISH request, and that answer only
 * arrives once the human has approved on the handset — which they cannot do without seeing the code.
 * So the code has to reach the browser while the call is still running, and a tRPC mutation that
 * returns once cannot carry it. The pairing therefore runs detached, publishes its prompt here the
 * moment `onVerification` fires, and the UI polls `pairingStatus` for it.
 *
 * Memory-only and deliberately so: a pairing attempt is worthless across a restart (the relay drops
 * it after ~5 minutes), and the prompt is derived from a handshake key that no longer exists.
 */
type PairingState =
  | { status: 'running' }
  | { status: 'code'; emoji: string | null; numeric: string }
  | { status: 'done' }
  | { status: 'error'; message: string };

const pairingState = new Map<string, PairingState>();

export const gmessagesRouter = router({
  getConfig: adminProcedure.input(aliasInput).query(({ input, ctx }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const config = readExtensionConfig(folder, EXT_NAME);
    const paired = isPaired(agentPath(folder, 'ext', EXT_NAME));

    // Cached listing only — synchronous, and never opens a connection. The UI
    // calls `refreshConversations` explicitly when it wants a live fetch.
    const ext = liveExtension(ctx, folder);
    const connected = ext?.isConnected() ?? false;
    const conversations = ext?.listConversationsResolved() ?? [];

    return GmessagesAdminResponseSchema.parse({ config, paired, connected, conversations });
  }),

  setConfig: adminProcedure
    .input(z.object({ alias: z.string(), config: GmessagesConfigPartial }))
    .mutation(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      writeExtensionConfig(folder, EXT_NAME, input.config);
      return { ok: true };
    }),

  /** Pull a fresh conversation listing from the live session, for the policy picker. */
  refreshConversations: adminProcedure.input(aliasInput).mutation(async ({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const ext = liveExtension(ctx, folder);
    if (!ext) return { ok: false, message: 'Extension not active for this agent', conversations: [] };
    const conversations = await ext.refreshConversations();
    return { ok: true, message: `${conversations.length} conversations`, conversations };
  }),

  /**
   * Start pairing from a signed-in account's cookies. Returns the verification
   * code for the user to match on the handset.
   *
   * The cookies are account-wide Google credentials: consumed by the handshake,
   * never persisted here and never echoed back in the response.
   */
  pair: adminProcedure
    .input(z.object({ alias: z.string(), cookies: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      const ext = liveExtension(ctx, folder);
      if (!ext) return { ok: false, message: 'Google Messages extension not active for this agent' };

      // Detached on purpose — see `PairingState`. Awaiting here would hold the code hostage until
      // after the approval it is needed for.
      pairingState.set(folder, { status: 'running' });
      void ext
        .pair(input.cookies, (prompt) => {
          // Fires mid-handshake, before FINISH goes out. Publishing here is what lets the operator
          // see the code in time to match it on the phone.
          pairingState.set(folder, {
            status: 'code',
            emoji: prompt.emoji,
            numeric: prompt.numeric,
          });
        })
        .then(() => {
          pairingState.set(folder, { status: 'done' });
        })
        .catch((err: unknown) => {
          pairingState.set(folder, {
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        });

      return { ok: true, message: 'Pairing started — the code will appear shortly.' };
    }),

  /** Poll target for an in-flight pairing: carries the code the operator must match on the handset. */
  pairingStatus: adminProcedure.input(aliasInput).query(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    return pairingState.get(folder) ?? { status: 'idle' as const };
  }),

  /**
   * Delete the session, forcing a re-pair.
   *
   * This only removes OUR credential; the device registration lives on the
   * account until it is unpaired from the handset (Messages → device list),
   * which is the real revocation.
   */
  unpair: adminProcedure.input(aliasInput).mutation(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const sessionFile = path.join(agentPath(folder, 'ext', EXT_NAME), 'session.json');
    if (fs.existsSync(sessionFile)) fs.rmSync(sessionFile, { force: true });
    return { ok: true };
  }),
});
