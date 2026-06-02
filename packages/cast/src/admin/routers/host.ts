/**
 * Host router — host-tier structured event log.
 *
 * Mirrors `agent.events` at host scope. The events themselves are written by
 * orchestrator-process subsystems (bus, gateway, transports, container-runner,
 * lifecycle hooks); this router exposes read + clear over tRPC for the admin
 * Activity page.
 */
import { z } from 'zod';

import { adminProcedure, router } from '../trpc.js';

const HOST_COMPONENTS = ['bus', 'gateway', 'transport', 'auth', 'firewall', 'container', 'lifecycle'] as const;

export const hostRouter = router({
  /**
   * Read recent host activity events. Mirrors `agent.events` semantics:
   * returns `{ events, total, truncated }`. `total` is the unbounded count
   * under the same filters; `truncated` is `events.length < total`.
   */
  activityLog: adminProcedure
    .input(z.object({
      limit: z.number().int().positive().max(500).optional(),
      level: z.enum(['error', 'warn', 'info']).optional(),
      component: z.enum(HOST_COMPONENTS).optional(),
      since: z.string().optional(),
    }))
    .query(({ ctx, input }) => {
      const limit = input.limit ?? 100;
      const queryOpts = {
        level: input.level,
        component: input.component,
        since: input.since,
      };
      const events = ctx.deps.hostActivityLog.readEvents({ ...queryOpts, limit });
      const total = ctx.deps.hostActivityLog.countEvents(queryOpts);
      return { events, total, truncated: events.length < total };
    }),

  /** Wipe the host activity log. Returns the count of rows deleted. */
  clearActivityLog: adminProcedure.mutation(({ ctx }) => {
    return { deleted: ctx.deps.hostActivityLog.clearEvents() };
  }),
});
