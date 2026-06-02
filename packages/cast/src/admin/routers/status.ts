/**
 * Status router — server uptime, auth mode, IdP identifier.
 */
import { z } from 'zod';
import { env } from '../../env.js';
import { publicProcedure, router } from '../trpc.js';

const startTime = Date.now();

export const statusRouter = router({
  get: publicProcedure.query(({ ctx }) => {
    const auth = ctx.deps.getAuth();
    return {
      uptimeMs: Date.now() - startTime,
      authMode: auth?.mode ?? null,
      tokenExpiry: auth && 'expiresAt' in auth.meta ? auth.meta.expiresAt : null,
      idpIdentifier: ctx.deps.idp.idpIdentifier,
      version: env.version,
    };
  }),
});
