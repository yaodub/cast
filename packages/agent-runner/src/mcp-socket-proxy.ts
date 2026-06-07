/**
 * MCP Socket Proxy — connects to host-side MCP server via Unix domain socket,
 * discovers tools, and creates an in-process SDK MCP server that proxies calls.
 *
 * Eliminates the need for a spawned MCP child process inside the container.
 * Uses createSdkMcpServer (type: 'sdk') — zero extra processes, zero extra memory.
 */

import http from 'http';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// --- Unix socket fetch adapter ---

function createUnixSocketFetch(socketPath: string) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    return new Promise((resolve, reject) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const parsedUrl = new URL(urlStr);

      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => { headers[k] = v; });
        } else {
          Object.assign(headers, init.headers);
        }
      }

      const req = http.request(
        {
          socketPath,
          path: parsedUrl.pathname + parsedUrl.search,
          method: init?.method || 'GET',
          headers,
        },
        (res) => {
          const respHeaders = new Headers();
          for (const [key, val] of Object.entries(res.headers)) {
            if (val) respHeaders.set(key, Array.isArray(val) ? val.join(', ') : val);
          }

          if ((res.headers['content-type'] || '').includes('text/event-stream')) {
            // SSE: streaming Response for server-sent events
            const stream = new ReadableStream({
              start(controller) {
                res.on('data', (chunk: Buffer) => controller.enqueue(chunk));
                res.on('end', () => controller.close());
                res.on('error', (err) => controller.error(err));
              },
            });
            resolve(new Response(stream, {
              status: res.statusCode || 200,
              statusText: res.statusMessage || '',
              headers: respHeaders,
            }));
          } else {
            // Buffer non-streaming responses
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              resolve(new Response(Buffer.concat(chunks).toString(), {
                status: res.statusCode || 200,
                statusText: res.statusMessage || '',
                headers: respHeaders,
              }));
            });
          }
        },
      );

      req.on('error', reject);
      if (init?.body) {
        req.write(typeof init.body === 'string' ? init.body : JSON.stringify(init.body));
      }
      req.end();
    });
  };
}

// --- Proxy creation ---

type McpProxyResult = { sdkServer: ReturnType<typeof createSdkMcpServer>; close: () => Promise<void> };

/** Per-call context the runner attests onto service tool calls as MCP `_meta`.
 *  Mirrors the canonical `participant`/`channelName` fields in agent-schema's
 *  container-io.ts (no cross-import — process boundary). */
export type CallMeta = { participant?: string; channelName?: string; conversationKey?: string };

/** Returns the current `CallMeta`, read at call time so it tracks the spawn's
 *  conversation. Only passed for the service socket — never the host or external
 *  servers (the host already has the participant; external servers must not see
 *  internal identities). */
type GetCallMeta = () => CallMeta | undefined;

/** Connect to an MCP server, discover tools, and build an in-process SDK proxy. */
async function buildProxyFromTransport(
  transport: StreamableHTTPClientTransport,
  serverName: string,
  getCallMeta?: GetCallMeta,
): Promise<McpProxyResult> {
  const client = new Client({ name: `${serverName}-proxy`, version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();

  const proxyTools = tools.map((tool) => {
    // Convert JSON Schema → Zod using Zod 4's built-in fromJSONSchema
    const zodSchema = tool.inputSchema
      ? z.fromJSONSchema(tool.inputSchema as any) // MCP SDK types inputSchema as Record<string, unknown>
      : z.object({});

    // Extract the shape from the Zod object schema for createSdkMcpServer
    const shape = (zodSchema as { shape?: Record<string, z.ZodType> }).shape ?? {};

    return {
      name: tool.name,
      description: tool.description || '',
      inputSchema: shape,
      handler: async (args: Record<string, unknown>) => {
        const _meta = getCallMeta?.();
        const result = await client.callTool(
          _meta ? { name: tool.name, arguments: args, _meta } : { name: tool.name, arguments: args },
        );
        return result as CallToolResult;
      },
    };
  });

  const sdkServer = createSdkMcpServer({
    name: serverName,
    version: '1.0.0',
    tools: proxyTools,
  });

  return {
    sdkServer,
    close: async () => { await client.close(); },
  };
}

/**
 * Connect to a host-side MCP server via Unix socket and create an in-process
 * SDK MCP server that proxies all tool calls through the socket.
 */
export async function createMcpSocketProxy(
  socketPath: string,
  serverName: string,
  getCallMeta?: GetCallMeta,
): Promise<McpProxyResult> {
  const transport = new StreamableHTTPClientTransport(
    new URL('http://localhost/mcp'), // hostname ignored — socket path determines target
    { fetch: createUnixSocketFetch(socketPath) as unknown as typeof globalThis.fetch }, // Node http.request → fetch bridge for Unix sockets
  );
  return buildProxyFromTransport(transport, serverName, getCallMeta);
}

/**
 * Connect to a host-side MCP server via TCP and create an in-process
 * SDK MCP server that proxies all tool calls through the URL.
 * Used when Docker Desktop macOS can't mount Unix sockets.
 */
export async function createMcpTcpProxy(
  url: string,
  serverName: string,
  getCallMeta?: GetCallMeta,
): Promise<McpProxyResult> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  return buildProxyFromTransport(transport, serverName, getCallMeta);
}
