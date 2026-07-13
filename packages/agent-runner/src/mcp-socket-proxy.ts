/**
 * MCP Socket Proxy — connects to host-side MCP server via Unix domain socket,
 * discovers tools, and creates an in-process SDK MCP server that proxies calls.
 *
 * Eliminates the need for a spawned MCP child process inside the container.
 * Uses createSdkMcpServer (type: 'sdk') — zero extra processes, zero extra memory.
 *
 * Resilience: the host connection lives behind a `ProxyConnection` that owns a
 * transport *factory*, so a silently-dropped socket self-heals. Every tool call
 * routes through one `callTool` chokepoint that, on a transport-class failure,
 * reconnects and — write-safely — retries only when the request provably never
 * left (connect-class errors). Ambiguous in-flight failures reconnect for future
 * calls but surface a retryable result rather than blindly re-sending a possibly-
 * applied mutation.
 */

import http from 'http';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Per-call request timeout. Bounds a stalled call so a dead route is detected
 *  in seconds, not at the SDK's 60s default. Lives here (agent-runner), not in
 *  the host's config.ts — the container process can't import across the boundary. */
const MCP_CALL_TIMEOUT_MS = 15_000;

// --- Unix socket fetch adapter ---

function createUnixSocketFetch(socketPath: string) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    return new Promise((resolve, reject) => {
      const signal = init?.signal ?? undefined;
      if (signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }

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
              cancel() { res.destroy(); },
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
            // Without this, a socket death after headers-but-before-body leaves the
            // promise hanging until a higher-layer timeout — the request appears to
            // stall rather than fail.
            res.on('error', reject);
          }
        },
      );

      // Tie the request lifecycle to the caller's AbortSignal — the SDK aborts on
      // its per-request timeout and on transport teardown, so honoring it cancels
      // the in-flight socket instead of leaking it until Node's default timeout.
      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy(new DOMException('The operation was aborted.', 'AbortError'));
        }, { once: true });
      }

      req.on('error', reject);
      if (init?.body) {
        req.write(typeof init.body === 'string' ? init.body : JSON.stringify(init.body));
      }
      req.end();
    });
  };
}

// --- Connection (reconnect-aware) ---

/** Per-call context the runner attests onto service tool calls as MCP `_meta`.
 *  Mirrors the canonical `participant`/`channelName` fields in agent-schema's
 *  container-io.ts (no cross-import — process boundary). */
export type CallMeta = { participant?: string; channelName?: string; conversationKey?: string };

/** Returns the current `CallMeta`, read at call time so it tracks the spawn's
 *  conversation. Only passed for the service socket — never the host or external
 *  servers (the host already has the participant; external servers must not see
 *  internal identities). */
type GetCallMeta = () => CallMeta | undefined;

type ConnState =
  | { status: 'connected'; client: Client }
  | { status: 'closed' };

/** A request that throws from `callTool` failed at the transport, not the tool
 *  (tool-level failures come back as `isError` results, never throws). `unsent`
 *  means the request provably never left (connect failed / transport down) and is
 *  safe to retry; `inflight` is ambiguous (timeout, reset) and must not be re-sent. */
export function classifyTransportError(err: unknown): 'unsent' | 'inflight' {
  const code = (err as { code?: unknown }).code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 'ECONNREFUSED' || code === 'ENOENT' || /not connected/i.test(msg)) {
    return 'unsent';
  }
  return 'inflight';
}

/** A non-throwing tool result that tells the model the transport reset and the
 *  call may safely be retried (for reads) or verified-then-retried (for writes). */
function retryableErrorResult(toolName: string, err: unknown): CallToolResult {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{
      type: 'text',
      text: `MCP transport to the host reset while calling ${toolName} (${detail}). `
        + 'The connection has been re-established. Retry the call if it was a read; '
        + 'if it may have applied a change, check state before retrying.',
    }],
  };
}

export class ProxyConnection {
  private state: ConnState = { status: 'closed' };
  /** Dedupes concurrent reconnects: parallel tool calls that hit the same dead
   *  client share one reconnect instead of opening N replacement clients. */
  private reconnecting: Promise<Client> | null = null;

  constructor(
    private readonly makeTransport: () => StreamableHTTPClientTransport,
    private readonly serverName: string,
  ) {}

  private async openClient(): Promise<Client> {
    const client = new Client({ name: `${this.serverName}-proxy`, version: '1.0.0' });
    await client.connect(this.makeTransport());
    return client;
  }

  /** Initial connect + tool discovery. Throws on failure — the caller logs and
   *  proceeds without this MCP server (same as before). */
  async connect(): Promise<Awaited<ReturnType<Client['listTools']>>['tools']> {
    const client = await this.openClient();
    this.state = { status: 'connected', client };
    const { tools } = await client.listTools();
    return tools;
  }

  private async reconnect(deadClient: Client): Promise<Client> {
    // Another caller already swapped in a fresh client for this dead one.
    if (this.state.status === 'connected' && this.state.client !== deadClient) {
      return this.state.client;
    }
    if (this.reconnecting) return this.reconnecting;
    this.reconnecting = (async () => {
      await deadClient.close().catch(() => { /* already dead */ });
      const client = await this.openClient();
      this.state = { status: 'connected', client };
      return client;
    })();
    try {
      return await this.reconnecting;
    } finally {
      this.reconnecting = null;
    }
  }

  /** One cast, contained: the SDK infers a looser result union (`toolResult`
   *  variant, `Record` `_meta`) than the exported `CallToolResult`, though the
   *  wire shape is identical. MCP SDK type drift. */
  private async rawCall(
    client: Client,
    params: { name: string; arguments: Record<string, unknown>; _meta?: CallMeta },
  ): Promise<CallToolResult> {
    return await client.callTool(params, undefined, { timeout: MCP_CALL_TIMEOUT_MS }) as CallToolResult;
  }

  async callTool(name: string, args: Record<string, unknown>, meta?: CallMeta): Promise<CallToolResult> {
    if (this.state.status === 'closed') {
      throw new Error(`MCP proxy "${this.serverName}" is closed`);
    }
    const usedClient = this.state.client;
    const params = meta ? { name, arguments: args, _meta: meta } : { name, arguments: args };
    try {
      return await this.rawCall(usedClient, params);
    } catch (err) {
      const cls = classifyTransportError(err);
      let fresh: Client;
      try {
        fresh = await this.reconnect(usedClient);
      } catch {
        return retryableErrorResult(name, err);
      }
      // Safe to retry only when the request provably never left.
      if (cls === 'unsent') {
        try {
          return await this.rawCall(fresh, params);
        } catch (retryErr) {
          return retryableErrorResult(name, retryErr);
        }
      }
      // Ambiguous in-flight failure: transport restored for the next call, but the
      // original may have applied — don't re-send. Let the model re-decide.
      return retryableErrorResult(name, err);
    }
  }

  async close(): Promise<void> {
    if (this.state.status === 'connected') {
      await this.state.client.close().catch(() => { /* already closed */ });
    }
    this.state = { status: 'closed' };
  }
}

// --- Proxy creation ---

type McpProxyResult = { sdkServer: ReturnType<typeof createSdkMcpServer>; close: () => Promise<void> };

/** Connect to an MCP server (via a transport factory), discover tools, and build
 *  an in-process SDK proxy whose handlers route through the reconnect-aware
 *  connection. */
async function buildProxy(
  makeTransport: () => StreamableHTTPClientTransport,
  serverName: string,
  getCallMeta?: GetCallMeta,
): Promise<McpProxyResult> {
  const conn = new ProxyConnection(makeTransport, serverName);
  const tools = await conn.connect();

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
      handler: (args: Record<string, unknown>) => conn.callTool(tool.name, args, getCallMeta?.()),
    };
  });

  const sdkServer = createSdkMcpServer({
    name: serverName,
    version: '1.0.0',
    tools: proxyTools,
  });

  return {
    sdkServer,
    close: async () => { await conn.close(); },
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
  const makeTransport = () => new StreamableHTTPClientTransport(
    new URL('http://localhost/mcp'), // hostname ignored — socket path determines target
    { fetch: createUnixSocketFetch(socketPath) as unknown as typeof globalThis.fetch }, // Node http.request → fetch bridge for Unix sockets
  );
  return buildProxy(makeTransport, serverName, getCallMeta);
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
  const makeTransport = () => new StreamableHTTPClientTransport(new URL(url));
  return buildProxy(makeTransport, serverName, getCallMeta);
}
