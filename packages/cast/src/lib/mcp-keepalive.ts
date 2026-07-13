/**
 * SSE keepalive for host-side MCP socket servers.
 *
 * The host MCP servers (agent, console, external-proxy) hold a server→client SSE
 * stream over a Unix socket that is bind-mounted into the agent container. The
 * container runtime's socket-forwarding layer can silently idle-drop that
 * connection; the agent only discovers the death on its next tool call, which
 * then stalls. A periodic MCP `ping` keeps the stream warm and surfaces a dead
 * connection early.
 *
 * Defense-in-depth: the agent-runner proxy already reconnects on a broken
 * connection (mcp-socket-proxy.ts), so this only reduces how often that triggers.
 * It is also inert when the client hasn't opened an SSE stream — the ping has
 * nowhere to land and simply times out, which is harmless (the in-flight guard
 * bounds concurrency to one and the timer is unref'd).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { MCP_KEEPALIVE_INTERVAL_MS } from '../config.js';
import { logger } from '../logger.js';

/**
 * Start pinging the client on `MCP_KEEPALIVE_INTERVAL_MS`. Returns a `stop()` to
 * clear the timer; call it from the transport's `onclose` (which every teardown
 * path — DELETE, server close — funnels through via `transport.close()`).
 *
 * `log` is merged into the pino binding so a failed ping is attributable.
 */
export function startMcpKeepalive(server: McpServer, log: Record<string, unknown>): () => void {
  let inFlight = false;
  const timer = setInterval(() => {
    // Skip if the previous ping hasn't resolved — on a dead/absent stream the
    // ping hangs to its own timeout; never let pings pile up.
    if (inFlight) return;
    inFlight = true;
    server.server.ping()
      .catch((err) => logger.debug({ ...log, err }, 'MCP keepalive ping failed'))
      .finally(() => { inFlight = false; });
  }, MCP_KEEPALIVE_INTERVAL_MS);
  // Never keep the process alive for a keepalive timer.
  timer.unref();
  return () => clearInterval(timer);
}
