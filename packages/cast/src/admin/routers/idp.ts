/**
 * IdP router — read-only views of agent registrations and user identities.
 *
 * User management is not server admin. View-only for debugging.
 */
import { adminProcedure, router } from '../trpc.js';

export const idpRouter = router({
  /** List all agent registrations. */
  agents: adminProcedure.query(({ ctx }) => {
    return ctx.deps.idp.listAgentRegistrations();
  }),

  /** List all user identities with linked handles. */
  users: adminProcedure.query(({ ctx }) => {
    return ctx.deps.idp.listIdentities();
  }),

  /** Server IdP metadata. */
  meta: adminProcedure.query(({ ctx }) => {
    return {
      idpIdentifier: ctx.deps.idp.idpIdentifier,
    };
  }),
});
