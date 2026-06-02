/**
 * Service factory — the main entry point for agent services.
 *
 * `createService()` returns an object with methods to register MCP tools
 * and prompt contributions. Call `start()` to begin serving.
 */
import fs from 'fs';
import http from 'http';

import dotenv from 'dotenv';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  IpcInMessageSchema,
  log,
  resolveRoute,
  routeMessage,
  sendIpc,
} from './ipc.js';
import { type McpHandle, startMcpServer } from './mcp.js';
import { type PromptManager, createPromptManager } from './prompt.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServiceOptions {
  /** Service name — used for MCP server identity and logging. */
  name: string;
}

/** Admin request passed to the handler registered via `svc.admin()`. */
export interface AdminRequest {
  path: string;
  method: string;
  query: Record<string, string>;
}

/** Admin response returned by the handler. */
export interface AdminResponse {
  status: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

/** Config injected by the cast server via CAST_SERVICE_CONFIG. */
export const ServiceConfigSchema = z.object({
  agentDir: z.string(),
  agentFolder: z.string(),
  serviceDir: z.string(),
  sharedDir: z.string(),
  webBaseUrl: z.string(),
  adminSocketPath: z.string(),
  mcpSocketPath: z.string(),
  serviceContextPath: z.string(),
});

export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;

export interface Service {
  /** Validated config injected by the cast server. */
  readonly config: ServiceConfig;

  /** Agent instance directory path. */
  readonly agentDir: string;
  /** Agent folder name. */
  readonly agentFolder: string;
  /** Service private runtime directory (ext/service/, service CWD). */
  readonly serviceDir: string;
  /** Service shared output directory (shared/ext/service/, mounted at /shared/service). */
  readonly sharedDir: string;
  /** Loaded secrets from config/ext/service/.env. */
  readonly secrets: Record<string, string>;

  /** Register an MCP tool. Same signature as McpServer.tool(). */
  tool: McpServer['tool'];

  /** Prompt template manager — setTemplate(), set(), commit(). */
  readonly prompt: PromptManager;

  /** Send a message to the agent via IPC. Returns when the server responds. */
  routeMessage(channel: string, text: string, target?: string): Promise<{ result: string | null; error: string | null }>;

  /** Well-known socket path for the admin HTTP server. */
  readonly adminSocketPath: string;

  /** Request human approval for a tool call. Returns the approval ID (fire-and-forget). */
  requestApproval(data: {
    tool: string;
    args: Record<string, unknown>;
    summary: string;
    details?: string;
    participant: string;
    channel?: string;
    conversationKey?: string;
    expiresIn?: number;
  }): string;

  /** Register a simple admin page handler. Starts an HTTP server on adminSocketPath. */
  admin(handler: (req: AdminRequest) => AdminResponse | Promise<AdminResponse>): void;

  /** Start MCP server, IPC listener. Sends ready signal. */
  start(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Secret loading
// ---------------------------------------------------------------------------

function loadSecrets(serviceDir: string): Record<string, string> {
  const envPath = `${serviceDir}/.env`;
  try {
    return dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createService(opts: ServiceOptions): Service {
  const rawConfig = process.env.CAST_SERVICE_CONFIG;
  if (!rawConfig) {
    console.error('Missing CAST_SERVICE_CONFIG — service must be launched by the cast server');
    process.exit(1);
  }

  let config: ServiceConfig;
  try {
    config = ServiceConfigSchema.parse(JSON.parse(rawConfig));
  } catch (err) {
    console.error('Invalid CAST_SERVICE_CONFIG:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { agentDir, agentFolder, serviceDir, sharedDir, adminSocketPath, mcpSocketPath, serviceContextPath } = config;

  const secrets = loadSecrets(serviceDir);
  // Deferred tool registrations — replayed on the real McpServer at start().
  // Stored as raw argument tuples; callers get type safety via the McpServer['tool'] signature.
  const toolArgs: unknown[][] = [];
  // Tool handler registry — populated during tool() calls for approval re-invocation.
  // Key: tool name, Value: the handler function (last arg of the McpServer.tool overload).
  const toolHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const prompt = createPromptManager(agentFolder, serviceContextPath);
  let adminServer: http.Server | null = null;
  let approvalIdCounter = 0;

  const svc: Service = {
    config,
    agentDir,
    agentFolder,
    serviceDir,
    sharedDir,
    secrets,
    prompt,

    tool(name: string, ...rest: unknown[]): void {
      toolArgs.push([name, ...rest]);
      // Capture the handler (last arg) for approval re-invocation
      const handler = rest[rest.length - 1];
      if (typeof handler === 'function') {
        toolHandlers.set(name, handler as (...args: unknown[]) => Promise<unknown>);
      }
    },

    routeMessage,

    requestApproval(data) {
      const id = `sa-${Date.now().toString(36)}-${(++approvalIdCounter).toString(36)}`;
      sendIpc({
        type: 'request-approval',
        id,
        tool: data.tool,
        args: JSON.stringify(data.args),
        summary: data.summary,
        details: data.details,
        participant: data.participant,
        channel: data.channel,
        conversationKey: data.conversationKey,
        expiresIn: data.expiresIn,
      });
      return id;
    },

    adminSocketPath,

    admin(handler): void {
      // Clean up stale socket from previous run
      try { fs.unlinkSync(adminSocketPath); } catch { /* no stale socket */ }

      adminServer = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', `http://localhost`);
        const query: Record<string, string> = {};
        url.searchParams.forEach((v, k) => { query[k] = v; });

        try {
          const result = await handler({ path: url.pathname, method: req.method || 'GET', query });
          res.writeHead(result.status, { 'Content-Type': result.contentType, ...result.headers });
          res.end(result.body);
        } catch (err) {
          log(agentFolder, `Admin handler error: ${err instanceof Error ? err.message : String(err)}`);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal server error');
        }
      });
      adminServer.on('error', (err) => {
        log(agentFolder, `Admin server failed to bind: ${err.message}`);
        throw err;
      });
      adminServer.listen(adminSocketPath, () => {
        log(agentFolder, `Admin server listening on ${adminSocketPath}`);
      });
    },

    async start(): Promise<void> {
      // 1. Start MCP server
      let mcpHandle: McpHandle | undefined;

      if (toolArgs.length > 0) {
        mcpHandle = await startMcpServer(mcpSocketPath, opts.name, (server) => {
          for (const args of toolArgs) {
            (server.tool as (...a: unknown[]) => void)(...args);
          }
        });
        log(agentFolder, `MCP server listening on ${mcpSocketPath}`);
      }

      // 2. IPC listener
      process.on('message', (raw: unknown) => {
        const parsed = IpcInMessageSchema.safeParse(raw);
        if (!parsed.success) {
          log(agentFolder, `Unhandled IPC message: ${JSON.stringify(raw)}`);
          return;
        }

        const msg = parsed.data;

        if (msg.type === 'route-result') {
          if (!resolveRoute(msg.id, msg.result, msg.error)) {
            log(agentFolder, `route-result for unknown id: ${msg.id}`);
          }
          return;
        }

        if (msg.type === 'execute-approved-tool') {
          const handler = toolHandlers.get(msg.tool);
          if (!handler) {
            sendIpc({ type: 'approval-tool-result', id: msg.id, result: `Tool "${msg.tool}" not found`, isError: true });
            return;
          }
          const args = JSON.parse(msg.args);
          handler(args)
            .then((result) => {
              // MCP tool handlers return { content: [{type:'text', text}], isError? }
              const r = result as { content?: { text: string }[]; isError?: boolean };
              const text = r?.content?.map((c) => c.text).join('\n') ?? String(result);
              sendIpc({ type: 'approval-tool-result', id: msg.id, result: text, isError: r?.isError });
            })
            .catch((err) => {
              sendIpc({ type: 'approval-tool-result', id: msg.id, result: String(err), isError: true });
            });
          return;
        }

        if (msg.type === 'shutdown') {
          log(agentFolder, 'Shutdown requested');
          mcpHandle?.close();
          adminServer?.close();
          setTimeout(() => process.exit(0), 5_000);
        }
      });

      // 3. Ready signal
      sendIpc({ type: 'ready' });
      log(agentFolder, 'Service ready');
    },
  };

  return svc;
}
