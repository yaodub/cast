/**
 * Server router — server-wide configuration (server.json).
 */
import { readServerConfig, writeServerConfig, ServerConfigSchema } from '../../config.js';
import { getUpdateStatus } from '../../lib/cast-services.js';
import { logger } from '../../logger.js';
import { serverUpdateConfigInput } from '../schemas.js';
import { adminProcedure, router } from '../trpc.js';

export const serverRouter = router({
  getConfig: adminProcedure.query(() => readServerConfig()),

  /** Latest update check result from cast-services (null until first poll). */
  updateStatus: adminProcedure.query(() => getUpdateStatus()),

  updateConfig: adminProcedure
    .input(serverUpdateConfigInput)
    .mutation(({ input }) => {
      const existing = readServerConfig();
      const updated: Record<string, unknown> = { ...existing };

      for (const [key, value] of Object.entries(input)) {
        if (value === undefined) continue;
        if (value === null) {
          delete updated[key];
        } else {
          updated[key] = value;
        }
      }

      const validated = ServerConfigSchema.parse(updated);
      writeServerConfig(validated);
      return validated;
    }),

  /**
   * Trigger a graceful shutdown of the Cast server. Sends SIGTERM to self
   * after a short delay so the HTTP response flushes before the existing
   * SIGTERM handler kicks in. The handler runs the standard graceful drain
   * (drain runners, mark approvals interrupted, sweep containers, close DBs).
   *
   * **Bringing the server back up is the supervisor's responsibility** —
   * systemd, launchd, pm2, docker, or manual restart depending on
   * deployment shape.
   */
  shutdown: adminProcedure.mutation(() => {
    logger.warn('Server shutdown requested via admin tRPC');
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);
    return { ok: true as const, signaledIn: 100 };
  }),
});
