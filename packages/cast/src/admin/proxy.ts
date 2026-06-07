/**
 * Service admin reverse-proxy — forwards requests to agent service Unix sockets.
 *
 * Ported from web/routes.ts. The Cast server proxies /agents/{folder}/admin/*
 * to the service's admin HTTP handler on its Unix socket.
 *
 * Two ways in:
 *   - API callers: admin Bearer header (unchanged).
 *   - Browsers: a path-scoped cookie session, set by the authenticated
 *     `service.adminPageUrl` tRPC call (see service-page-access.ts).
 */
import http from 'http';
import { Router } from 'express';

import { ADMIN_SOCKET_NAME, agentPath } from '../config.js';
import { isValidSession, extractToken } from './trpc.js';
import type { AdminDeps } from './trpc.js';
import { SESSION_COOKIE, isValidSessionCookie } from './service-page-access.js';

export function createProxyRouter(deps: AdminDeps): Router {
  const proxyRouter = Router();

  // `{/*path}` (optional wildcard) so the bare page URL `/agents/{folder}/admin`
  // matches too — a plain `/*path` requires a non-empty tail in Express 5.
  proxyRouter.all('/:agent/admin{/*path}', (req, res) => {
    const agent = req.params.agent!;

    const cookies = (req as { cookies?: Record<string, string> }).cookies ?? {};
    const browserSession = isValidSessionCookie(cookies[SESSION_COOKIE], agent);
    if (!browserSession && !isValidSession(extractToken(req.headers.authorization))) {
      res.status(401).json({ error: 'Admin session required' });
      return;
    }

    const mgr = deps.getManager(agent);
    if (!mgr) {
      res.status(404).json({ error: `Agent "${agent}" not found` });
      return;
    }

    // Extract the path after /agents/{agent}/admin. Express 5 wildcard params
    // are arrays of segments (path-to-regexp v8); absent for the bare URL.
    const pathParam = req.params.path as unknown as string[] | string | undefined;
    const adminPath = '/' + (Array.isArray(pathParam) ? pathParam.join('/') : pathParam || '');
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
