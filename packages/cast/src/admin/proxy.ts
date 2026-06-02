/**
 * Service admin reverse-proxy — forwards requests to agent service Unix sockets.
 *
 * Ported from web/routes.ts. The Cast server proxies /agents/{folder}/admin/*
 * to the service's admin HTTP handler on its Unix socket.
 */
import http from 'http';
import { Router } from 'express';

import { ADMIN_SOCKET_NAME, agentPath } from '../config.js';
import { isValidSession, extractToken } from './trpc.js';
import type { AdminDeps } from './trpc.js';

export function createProxyRouter(deps: AdminDeps): Router {
  const proxyRouter = Router();

  proxyRouter.all('/:agent/admin/*path', (req, res) => {
    if (!isValidSession(extractToken(req.headers.authorization))) {
      res.status(401).json({ error: 'Admin session required' });
      return;
    }
    const agent = req.params.agent!;
    const mgr = deps.getManager(agent);
    if (!mgr) {
      res.status(404).json({ error: `Agent "${agent}" not found` });
      return;
    }

    // Extract the path after /agents/{agent}/admin
    const adminPath = '/' + (req.params.path || '');
    const socketPath = agentPath(agent!, ADMIN_SOCKET_NAME);

    const proxyReq = http.request({
      socketPath,
      path: adminPath + (req.url?.includes('?') ? '?' + req.url.split('?')[1] : ''),
      method: req.method,
      headers: req.headers,
    }, (proxyRes) => {
      try {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      } catch { /* client disconnected */ }
    });

    proxyReq.on('error', () => {
      res.status(503).json({
        error: `No admin page available for agent "${agent}". The service may not be running.`,
      });
    });

    req.pipe(proxyReq);
  });

  return proxyRouter;
}
