/**
 * Config Manager admin chat send endpoint — POST only.
 *
 * Target is fixed (`console:config-manager`), so the route is top-level (no
 * `:folder` param). Otherwise mirrors the per-agent admin chat shape in
 * `./chat.ts`.
 *
 * Surface:
 *   POST /api/admin/config-manager/chat/send        { text }
 *
 * Live events arrive via the multiplexed `/api/admin/events` stream;
 * transcript history is owned client-side (IndexedDB).
 */
import { Router } from 'express';

import { CONFIG_MANAGER_DESCRIPTOR } from '../console/config-manager/descriptor.js';
import type { Bus } from '../gateway/bus.js';
import type { MessageGateway } from '../gateway/message-gateway.js';
import { logger } from '../logger.js';

import { extractToken, isValidSession } from './trpc.js';

export interface AdminConfigManagerChatDeps {
  bus: Bus;
  gateway: MessageGateway;
}

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ADMIN_HANDLE = 'admin:local';
const CONFIG_MANAGER_CHANNEL = 'default';

export function createAdminConfigManagerChatRouter(deps: AdminConfigManagerChatDeps): Router {
  const router = Router();

  router.use((req, res, next) => {
    const ip = req.socket.remoteAddress;
    if (!ip || !LOCALHOST_ADDRS.has(ip)) {
      res.status(403).json({ error: 'Config Manager chat is localhost-only' });
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
    const { text } = (req.body ?? {}) as { text?: string };
    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text required' });
      return;
    }
    deps.gateway.ingestInbound(
      ADMIN_HANDLE,
      CONFIG_MANAGER_DESCRIPTOR.address,
      text,
      'Operator',
      { channel: CONFIG_MANAGER_CHANNEL },
    );
    res.status(204).end();
  });

  logger.info('ConfigManager chat send route mounted at /api/admin/config-manager/chat');
  return router;
}

export function mountAdminConfigManagerChat(app: import('express').Express, deps: AdminConfigManagerChatDeps): void {
  app.use('/api/admin/config-manager/chat', createAdminConfigManagerChatRouter(deps));
}
