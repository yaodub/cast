/**
 * Security Manager admin chat send endpoint — POST only.
 *
 * Target fixed at `console:security-manager`, so top-level (no `:folder` param).
 * Mirrors `admin/config-manager-chat.ts` and `admin/design-manager-chat.ts`.
 *
 * Surface:
 *   POST /api/admin/security-manager/chat/send        { text }
 *
 * Live events arrive via the multiplexed `/api/admin/events` stream;
 * transcript history is owned client-side (IndexedDB).
 *
 * Conversational drawer transport. The mechanical finalize hook
 * (`POST /api/admin/security-manager/analyze`) is a separate route.
 */
import { Router } from 'express';

import { SECURITY_MANAGER_DESCRIPTOR } from '../console/security-manager/descriptor.js';
import type { Bus } from '../gateway/bus.js';
import type { MessageGateway } from '../gateway/message-gateway.js';
import { logger } from '../logger.js';

import { extractToken, isValidSession } from './trpc.js';

export interface AdminSecurityManagerChatDeps {
  bus: Bus;
  gateway: MessageGateway;
}

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ADMIN_HANDLE = 'admin:local';
const SM_CHANNEL = 'default';

export function createAdminSecurityManagerChatRouter(deps: AdminSecurityManagerChatDeps): Router {
  const router = Router();

  router.use((req, res, next) => {
    const ip = req.socket.remoteAddress;
    if (!ip || !LOCALHOST_ADDRS.has(ip)) {
      res.status(403).json({ error: 'Security Manager chat is localhost-only' });
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
      SECURITY_MANAGER_DESCRIPTOR.address,
      text,
      'Operator',
      { channel: SM_CHANNEL },
    );
    res.status(204).end();
  });

  logger.info('Security Manager chat send route mounted at /api/admin/security-manager/chat');
  return router;
}

export function mountAdminSecurityManagerChat(app: import('express').Express, deps: AdminSecurityManagerChatDeps): void {
  app.use('/api/admin/security-manager/chat', createAdminSecurityManagerChatRouter(deps));
}
