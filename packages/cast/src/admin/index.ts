/**
 * Admin API server — Express app with tRPC, session auth, service proxy.
 *
 * Pure API server. The web UI runs as a separate process (vite dev)
 * and connects via VITE_API_BASE. Binds to 127.0.0.1 only.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { createExpressMiddleware } from '@trpc/server/adapters/express';

import { findAvailablePort } from '../lib/port.js';
import { logger } from '../logger.js';
import { sessionRouter } from './session.js';
import { createProxyRouter } from './proxy.js';
import { createContext, setDeps } from './trpc.js';
import type { AdminDeps } from './trpc.js';
import { appRouter } from './routers/index.js';
import { createExtensionOAuthRouter } from './routers/extension/index.js';
import { mountChangesStream } from './changes.js';
import { mountAdminChat } from './chat.js';
import { mountAdminEventsStream } from './events-stream.js';
import { mountAdminConfigManagerChat } from './config-manager-chat.js';
import { mountAdminDesignManagerChat } from './design-manager-chat.js';
import { mountAdminSecurityManagerChat } from './security-manager-chat.js';

export type { AdminDeps } from './trpc.js';
export type AppRouter = typeof appRouter;

// Re-exports for web-ui type consumption — keeps @getcast/agent-schema /
// @getcast/server-internal types out of web-ui's direct dependency surface.
export type { AgentConfig } from '@getcast/agent-schema/v1';
export type { ChannelJsonConfig } from '../conversations/types.js';

/** Start the admin server on the given port, bound to localhost only. */
export async function startAdminServer(port: number, deps: AdminDeps): Promise<ReturnType<typeof express.application.listen>> {
  const actualPort = await findAvailablePort(port, 'Admin');
  setDeps(deps);

  const app = express();
  // Localhost only — admin API is not designed for public-facing deployment.
  app.use(cors({ origin: /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/, credentials: true }));
  app.use(cookieParser());

  // --- Service admin reverse-proxy ---
  // Mounted BEFORE express.json: the proxy streams request bodies through to
  // the service socket (`req.pipe`), and a body parser ahead of it would
  // consume JSON POSTs, piping nothing. Needs cookieParser (browser sessions).
  app.use('/agents', createProxyRouter(deps));

  app.use(express.json({ limit: '100kb' }));

  // --- Session auth (plain Express, handles cookies) ---
  app.use('/api/auth/session', sessionRouter);

  // --- OAuth redirect routes (plain Express — collected from extension routers) ---
  app.use('/api/oauth', createExtensionOAuthRouter({ bus: deps.bus }));

  // --- tRPC (mixed open + admin-gated via middleware) ---
  app.use('/api/trpc', createExpressMiddleware({ router: appRouter, createContext }));

  // --- File-change SSE stream (admin UI blanket invalidation) ---
  mountChangesStream(app, deps.watcher);

  // --- Multiplexed admin events stream (single SSE for every (alias,channel)) ---
  mountAdminEventsStream(app, {
    bus: deps.bus,
    consoleTransport: deps.consoleTransport,
  });

  // --- Admin chat send endpoint (POST only — events flow via the
  //     multiplexed `/api/admin/events` stream above). ---
  mountAdminChat(app, {
    bus: deps.bus,
    gateway: deps.gateway,
  });

  // --- Config Manager chat (server-scope console:config-manager) ---
  mountAdminConfigManagerChat(app, {
    bus: deps.bus,
    gateway: deps.gateway,
  });

  // --- Design Manager chat (server-scope console:design-manager) ---
  mountAdminDesignManagerChat(app, {
    bus: deps.bus,
    gateway: deps.gateway,
  });

  // --- Security Manager chat (server-scope console:security-manager) ---
  mountAdminSecurityManagerChat(app, {
    bus: deps.bus,
    gateway: deps.gateway,
  });

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const srv = app.listen(actualPort, '127.0.0.1', () => {
      logger.info({ port: actualPort }, 'Admin server listening on 127.0.0.1');
      resolve(srv);
    });
    srv.on('error', reject);
  });

  return server;
}
