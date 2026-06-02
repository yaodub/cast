/**
 * Root tRPC router — merges all sub-routers into a single appRouter.
 */
import { router } from '../trpc.js';
import { statusRouter } from './status.js';
import { agentRouter } from './agent.js';
import { idpRouter } from './idp.js';
import { authRouter } from './auth.js';
import { routeRouter } from './route.js';
import { serverRouter } from './server.js';
import { extensionRouter } from './extension/index.js';
import { mcpServersRouter } from './mcp-servers.js';
import { hostRouter } from './host.js';
import { modelsRouter } from './models.js';
import { tokensRouter } from './tokens.js';

export const appRouter = router({
  status: statusRouter,
  agent: agentRouter,
  idp: idpRouter,
  auth: authRouter,
  route: routeRouter,
  server: serverRouter,
  extension: extensionRouter,
  mcpServers: mcpServersRouter,
  host: hostRouter,
  models: modelsRouter,
  tokens: tokensRouter,
});
