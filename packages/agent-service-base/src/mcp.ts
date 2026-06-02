/**
 * MCP server setup for agent services.
 *
 * Starts a Streamable HTTP MCP server on a Unix domain socket.
 * Services register tools via a callback; this module handles the
 * socket lifecycle, session management, and HTTP routing.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SocketSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export type ToolRegistrar = (server: McpServer) => void;

export interface McpHandle {
  close: () => void;
}

// ---------------------------------------------------------------------------
// MCP socket server
// ---------------------------------------------------------------------------

/**
 * Start an MCP server on a Unix domain socket.
 *
 * @param socketPath Path for the Unix socket (e.g. mnt/agents/{name}/mcp/agent.sock)
 * @param name Service name for the MCP server identity
 * @param registerTools Callback to register MCP tools on each new session's server
 * @returns Promise that resolves with a close handle once the server is listening
 */
export function startMcpServer(
  socketPath: string,
  name: string,
  registerTools: ToolRegistrar,
): Promise<McpHandle> {
  // Clean stale socket from prior crash
  try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  const sessions = new Map<string, SocketSession>();

  const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        await session.transport.close();
        sessions.delete(sessionId);
      }
      res.writeHead(200).end();
      return;
    }

    // Route to existing session
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }

    // New session
    if (req.method === 'POST') {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () =>
          `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });

      const server = new McpServer({ name, version: '1.0.0' });
      registerTools(server);
      await server.connect(transport);
      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, { transport, server });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
      }
      return;
    }

    res.writeHead(405).end();
  });

  return new Promise((resolve) => {
    httpServer.listen(socketPath, () => {
      resolve({
        close: () => {
          for (const session of sessions.values()) {
            session.transport.close().catch(() => {});
          }
          sessions.clear();
          httpServer.close();
          try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
        },
      });
    });
  });
}
