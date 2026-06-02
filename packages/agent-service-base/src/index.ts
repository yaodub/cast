/**
 * @getcast/agent-service-base — reusable runtime framework for agent services.
 *
 * Provides IPC, MCP server, prompt template management, and lifecycle management.
 * Services import `createService` and use the returned object to register
 * tools and prompt contributions.
 *
 * ```typescript
 * import { createService } from '@getcast/agent-service-base';
 *
 * const svc = createService({ name: 'my-service' });
 * svc.tool('myservice__search', 'Search data', { query: z.string() }, async ({ query }) => { ... });
 * svc.prompt.init('## My Service\n{{status}}');
 * svc.prompt.set('status', '42 items indexed');
 * svc.prompt.commit();
 * await svc.start();
 * ```
 */
export { createService, ServiceConfigSchema } from './service.js';
export type { Service, ServiceConfig, ServiceOptions, AdminRequest, AdminResponse } from './service.js';
export type { PromptManager } from './prompt.js';
export { routeMessage, log, sendIpc } from './ipc.js';
export type { IpcOutMessage } from './ipc.js';
export { createTokenManager } from './token-manager.js';
export type { TokenManager, TokenManagerOpts } from './token-manager.js';
export { loadCredentials, saveCredentials } from './credentials.js';
export type { CredentialEntry } from './credentials.js';
export * as oauth from './oauth.js';
export type { OAuthConfig, OAuthTokens } from './oauth.js';
