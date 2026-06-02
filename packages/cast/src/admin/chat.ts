/**
 * Admin chat send endpoint — POST only.
 *
 * The admin UI is the single operator. Traffic enters as handle
 * `admin:<session-prefix>`; `idp.resolve('admin:*')` short-circuits to
 * the `local` identity sentinel so `checkAcl()` grants full access (see
 * `auth/identity.ts` + `auth/acl.ts`). No web-identity bridging, no ACL
 * setup, no owner wiring.
 *
 * Trust model: the admin server binds to 127.0.0.1 only; additionally we
 * assert `req.socket.remoteAddress` here as defense-in-depth. Same guarantee
 * CLI has.
 *
 * Surface:
 *   POST /api/admin/agents/:alias/chat/send   { channel, text }
 *
 * Live events and transcript history live elsewhere:
 *   - Events: `/api/admin/events` (multiplexed SSE, see `events-stream.ts`).
 *   - History: client-owned IndexedDB (`web-ui/src/lib/db.ts`).
 */
import { Router } from 'express';

import type { Bus } from '../gateway/bus.js';
import type { MessageGateway } from '../gateway/message-gateway.js';
import { logger } from '../logger.js';

import { extractToken, isValidSession } from './trpc.js';

export interface AdminChatDeps {
  bus: Bus;
  gateway: MessageGateway;
}

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Stable handle for the local admin UI endpoint. Identity and handle
 * are separate concepts: identity (`local`) is who; handle (`admin:local`)
 * is the endpoint. Session tokens authenticate HTTP requests but do NOT
 * enter the address grammar — conflating session with handle broke history
 * across server restarts and partitioned multi-tab views.
 *
 * Other transports follow the same shape: `tg:<user-id>`, `web:<reg-id>`,
 * `cli:<--as>`. Handles identify the endpoint; auth is orthogonal.
 *
 * `idp.resolve('admin:*')` short-circuits to identity `local` — see
 * `auth/identity.ts`.
 */
const ADMIN_HANDLE = 'admin:local';

export function createAdminChatRouter(deps: AdminChatDeps): Router {
  const router = Router({ mergeParams: true });

  router.use((req, res, next) => {
    const ip = req.socket.remoteAddress;
    if (!ip || !LOCALHOST_ADDRS.has(ip)) {
      res.status(403).json({ error: 'Console chat is localhost-only' });
      return;
    }
    const token = extractToken(req.headers.authorization);
    if (!token || !isValidSession(token)) {
      res.status(401).json({ error: 'Admin session required' });
      return;
    }
    next();
  });

  // --- POST /send ---
  router.post('/send', (req, res) => {
    const alias = (req.params as { alias: string }).alias;
    const { channel, text } = (req.body ?? {}) as { channel?: string; text?: string };
    if (!channel || typeof channel !== 'string') {
      res.status(400).json({ error: 'channel required' });
      return;
    }
    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text required' });
      return;
    }
    const agentId = deps.bus.resolveByLabel(alias);
    if (!agentId) {
      res.status(404).json({ error: `Unknown agent "${alias}"` });
      return;
    }
    deps.gateway.ingestInbound(ADMIN_HANDLE, agentId, text, 'Operator', { channel });
    res.status(204).end();
  });

  logger.info('Admin chat send route mounted at /api/admin/agents/:alias/chat');
  return router;
}

export function mountAdminChat(app: import('express').Express, deps: AdminChatDeps): void {
  app.use('/api/admin/agents/:alias/chat', createAdminChatRouter(deps));
}
