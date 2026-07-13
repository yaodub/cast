/**
 * Console MCP server plumbing.
 *
 * `registerConsoleTools` dispatches to the strategy's own tool set (via the
 * registry) and registers shared tools on every console (delegate, expire).
 * `startConsoleMcpServer` owns the HTTP transport — one session per
 * conversation, no strategy branches here.
 *
 * Types (`ConsoleMcpDeps`, `ConsoleMcpContext`) live in `./strategy.ts` and
 * are re-exported here so existing callers (`conversation-runner`,
 * `agent-manager`, `console-manager`) keep working without import churn.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { isToolDisabled } from '@getcast/agent-schema/v1';

import { mcpTransport } from '../container/mcp-transport.js';
import { logger } from '../logger.js';
import { generateId } from '../lib/utils.js';
import { startMcpKeepalive } from '../lib/mcp-keepalive.js';

import { registerMessageLogTools } from '../agent/register-message-log-tools.js';
import { registerConversationEndTool, registerPushToChannelTool } from '../agent/mcp-server.js';
import type { LocalPushActor } from '../agent/push-actor.js';
import { conversations } from '../lib/gates.js';
import type { IdleTimeoutMeta } from '../conversations/types.js';

import { getConsoleStrategy, parseConsoleName } from './registry.js';
import { registerAdminNavigateTool } from './shared/admin-directives.js';
import { registerDelegateTool } from './shared/delegate.js';
import { registerExpireTool } from './shared/expire.js';
import { registerManagerTools } from './shared/manager-tools.js';
import type { ConsoleMcpContext, ConsoleMcpDeps } from './strategy.js';

// Per-agent consoles share the host agent's identity (so `target_agent` is
// implicit) but sit in the **operator** trust tier — different from
// user-channel agents which sit in user trust. They register the agent-side
// `conversation__push_to_channel` with a `per-agent-console` PushActor; the
// handler's parser/guards/gates branch off `actor.kind`. Server-scope
// consoles (DM/CM/SM) are free-floating bus entities and register the
// delegate.ts variant (required `target_agent`, `handoff_brief`).
const PER_AGENT_CONSOLES = new Set(['design', 'configure']);

function isPerAgentConsoleChannel(channel: string): channel is '__design' | '__configure' {
  return channel === '__design' || channel === '__configure';
}

export type { ConsoleMcpContext, ConsoleMcpDeps } from './strategy.js';

const DEFAULT_END_COOLDOWN_MS = 300_000;
const MIN_END_COOLDOWN_MS = 60_000;

/**
 * Structural subset of any console SpawnContext that this function reads.
 * Both `ConsoleSpawnContext` and `ServerScopeSpawnContext` extend it — the
 * function is scope-agnostic.
 */
interface ConsoleEndableCtx {
  channelName: string;
  participant?: string;
}

/**
 * Console-side equivalent of `AgentManager.requestConversationEnd`. Lives here
 * (not in agent-manager) because `loadChannelsConfig` filters `__`-prefixed
 * channel names — the agent channel lookup returns `undefined` for console
 * channels, so the cooldown timer's `IdleTimeoutMeta` is built from the
 * strategy registry instead.
 *
 * Console strategies all set `cleanupEnabled: false`, so when the cooldown
 * elapses the slot frees with no cleanup turn — `Conversation.expire` sees
 * `cleanup: null` and short-circuits to hardExpire.
 */
export function requestConsoleConversationEnd(
  scope: string,
  conversationKey: string,
  cooldownMs?: number,
): { accepted: boolean; cooldownSeconds: number; reason?: string } {
  const view = conversations.get<ConsoleEndableCtx>(scope, conversationKey);
  if (!view) return { accepted: false, cooldownSeconds: 0, reason: 'No active conversation.' };
  const endable = view.canEndManually();
  if (!endable.ok) return { accepted: false, cooldownSeconds: 0, reason: endable.reason };
  const channelName = view.ctx?.channelName;
  if (!channelName) {
    return { accepted: false, cooldownSeconds: 0, reason: 'No active conversation.' };
  }
  const name = parseConsoleName(channelName);
  const channel = name ? getConsoleStrategy(name).channel : undefined;
  // Defensive — every console strategy declares an idle_timeout. A missing or
  // null entry here would mean a registry bug, not a single-shot console.
  if (!channel || channel.idle_timeout === null) {
    return { accepted: false, cooldownSeconds: 0, reason: 'This console session cannot be ended manually.' };
  }
  const requested = cooldownMs ?? DEFAULT_END_COOLDOWN_MS;
  const clamped = Math.max(MIN_END_COOLDOWN_MS, Math.min(requested, channel.idle_timeout));
  const meta: IdleTimeoutMeta = {
    conversationKey,
    channelName,
    cleanup: channel.cleanup,
    cleanupEnabled: channel.cleanupEnabled,
    participant: view.ctx?.participant,
    idle_timeout: channel.idle_timeout,
    manualEnd: true,
  };
  conversations.scheduleTtl<ConsoleEndableCtx>(scope, conversationKey, meta, clamped);
  return { accepted: true, cooldownSeconds: Math.round(clamped / 1000) };
}

// --- Registration ---

export function registerConsoleTools(
  server: McpServer,
  ctx: ConsoleMcpContext,
  deps: ConsoleMcpDeps,
): void {
  const strategy = getConsoleStrategy(ctx.consoleName);
  strategy.registerTools(server, ctx, deps);
  registerExpireTool(server, deps);
  // conversation__end — registered for any console whose host wires
  // `onEndConversation`. Console channels are all persistent (no single-shot
  // gate needed) and the handler is shared with the agent-side path.
  if (
    deps.onEndConversation
    && ctx.getConversationKey
    && !isToolDisabled('conversation__end', ctx.disabledTools ?? [])
  ) {
    registerConversationEndTool(server, {
      getConversationKey: ctx.getConversationKey,
      onEndConversation: deps.onEndConversation,
    });
  }
  if (PER_AGENT_CONSOLES.has(ctx.consoleName)) {
    // Agent-side push verb with a `per-agent-console` actor. The handler
    // picks the operator-trust parser (admits `__*` channel names) and
    // composes [selfLoopGuard, consoleSourceUserTargetGuard, intraAgentInfraGuard].
    // Downstream `dispatchLocalPush` skips `participantExists` and
    // `gateInbound` for this actor — the admin handle resolves to identity
    // `local` which already holds `ALL_BITS` in `checkAcl`, and isn't
    // registered as a peer participant by design.
    if (
      deps.deliverToChannel
      && ctx.participant
      && isPerAgentConsoleChannel(ctx.channelName)
      && !isToolDisabled('conversation__push_to_channel', ctx.disabledTools ?? [])
    ) {
      const actor: LocalPushActor = {
        kind: 'per-agent-console',
        agentId: ctx.agentId,
        channel: ctx.channelName,
        participant: ctx.participant,
      };
      registerPushToChannelTool(server, {
        actor,
        deliverToChannel: deps.deliverToChannel,
        deliverToAgent: deps.deliverToAgent,
        resolveAgentByLabel: deps.resolveAgentByLabel,
      });
    }
  } else {
    // Server-scope consoles (DM/CM/SM) — free-floating bus entities with
    // explicit two-coordinate addressing. `handoff_brief` is first-class
    // because the receiving session doesn't share the agent's memory mount.
    registerDelegateTool(server, ctx, deps);
  }
  registerAdminNavigateTool(server, ctx, deps);
  // manager__list / manager__read / manager__resurvey — gated inside on
  // ctx.consoleName so Design/Configure get nothing. No-op for those.
  registerManagerTools(server, ctx);
  // console_log__* — message-log tools pointed at the console-scope DB.
  // Same registrar as agent-scope `message_log__*`, different prefix and
  // different backing store (consoleDb.messages). Physical separation by
  // file is the load-bearing guarantee; the prefix split makes the scope
  // obvious in agent prompts and traces.
  if (ctx.messageLog) {
    registerMessageLogTools(server, {
      store: ctx.messageLog,
      participant: ctx.participant,
      toolPrefix: 'console_log__',
      agentTz: ctx.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      disabledTools: ctx.disabledTools,
    });
  }
}

// --- Server plumbing (parallel to startMcpSocketServer) ---

interface ConsoleSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  stopKeepalive: () => void;
}

export function startConsoleMcpServer(
  socketPath: string,
  ctx: ConsoleMcpContext,
  deps: ConsoleMcpDeps,
): { ready: Promise<void>; close: () => Promise<void>; port?: number } {
  if (mcpTransport().mode === 'socket') {
    // No clean-stale unlink: `socketPath` carries a per-spawn nonce
    // (sessionCastSocketPath), so it never collides with a prior instance's live
    // socket. Crash leftovers are swept at agent init (cleanupStaleSockets).
    // Only mkdir the socket parent in socket mode — TCP doesn't listen on the
    // path, so that dir would be dead.
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  }

  const sessions = new Map<string, ConsoleSession>();

  const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (session) {
        sessions.delete(sessionId!);
        try { await session.transport.close(); } catch { /* already closed */ }
      }
      res.writeHead(200).end();
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }

    if (req.method === 'POST') {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => generateId('session'),
      });
      const server = new McpServer({ name: `cast-${ctx.consoleName}`, version: '1.0.0' });
      registerConsoleTools(server, ctx, deps);
      await server.connect(transport);
      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        const stopKeepalive = startMcpKeepalive(server, { agentFolder: ctx.hostFolder, console: ctx.consoleName, sessionId: transport.sessionId });
        sessions.set(transport.sessionId, { transport, server, stopKeepalive });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (!sid) return;
          sessions.get(sid)?.stopKeepalive();
          sessions.delete(sid);
        };
      }
      return;
    }

    res.writeHead(405).end();
  });

  let assignedPort: number | undefined;

  const transport = mcpTransport();
  const ready = new Promise<void>((resolve, reject) => {
    if (transport.mode === 'tcp') {
      httpServer.listen(0, transport.bindAddr, () => {
        const addr = httpServer.address() as AddressInfo;
        assignedPort = addr.port;
        logger.info({ port: assignedPort, agentFolder: ctx.hostFolder, console: ctx.consoleName }, 'Console MCP TCP server listening');
        resolve();
      });
    } else {
      httpServer.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o777); } catch { /* best effort */ }
        logger.info({ socketPath, agentFolder: ctx.hostFolder, console: ctx.consoleName }, 'Console MCP socket server listening');
        resolve();
      });
    }
    httpServer.on('error', reject);
  });

  return {
    ready,
    get port() { return assignedPort; },
    close: async () => {
      for (const session of sessions.values()) {
        try { session.transport.close(); } catch { /* already closed */ }
      }
      sessions.clear();
      // Await real teardown so callers that re-spawn on the same socket
      // path don't race with a still-closing server.
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      if (mcpTransport().mode === 'socket') {
        try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
      }
    },
  };
}
