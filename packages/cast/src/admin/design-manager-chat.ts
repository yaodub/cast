/**
 * Design Manager admin chat send endpoint — POST only.
 *
 * Target fixed at `console:design-manager`, so top-level (no `:folder` param).
 * Mirrors `admin/config-manager-chat.ts`.
 *
 * Surface:
 *   POST /api/admin/design-manager/chat/send        { text }
 *
 * Live events arrive via the multiplexed `/api/admin/events` stream;
 * transcript history is owned client-side (IndexedDB).
 */
import { Router } from 'express';

import { DESIGN_MANAGER_DESCRIPTOR } from '../console/design-manager/descriptor.js';
import type { Bus } from '../gateway/bus.js';
import type { MessageGateway } from '../gateway/message-gateway.js';
import { logger } from '../logger.js';

import { extractToken, isValidSession } from './trpc.js';

export interface AdminDesignManagerChatDeps {
  bus: Bus;
  gateway: MessageGateway;
}

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ADMIN_HANDLE = 'admin:local';
const DM_CHANNEL = 'default';

export function createAdminDesignManagerChatRouter(deps: AdminDesignManagerChatDeps): Router {
  const router = Router();

  router.use((req, res, next) => {
    const ip = req.socket.remoteAddress;
    if (!ip || !LOCALHOST_ADDRS.has(ip)) {
      res.status(403).json({ error: 'Design Manager chat is localhost-only' });
      return;
    }
    const token = extractToken(req.headers.authorization);
    if (!token || !isValidSession(token)) {
      res.status(401).json({ error: 'Admin session required' });
      return;
    }
    next();
  });

  router.post('/send', (req, res) => {
    const { text } = (req.body ?? {}) as { text?: string };
    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text required' });
      return;
    }
    deps.gateway.ingestInbound(
      ADMIN_HANDLE,
      DESIGN_MANAGER_DESCRIPTOR.address,
      text,
      'Operator',
      { channel: DM_CHANNEL },
    );
    res.status(204).end();
  });

  logger.info('Design Manager chat send route mounted at /api/admin/design-manager/chat');
  return router;
}

export function mountAdminDesignManagerChat(app: import('express').Express, deps: AdminDesignManagerChatDeps): void {
  app.use('/api/admin/design-manager/chat', createAdminDesignManagerChatRouter(deps));
}
