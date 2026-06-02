/**
 * Host-side MCP proxy — connects to external MCP servers and exposes their
 * tools via a Unix domain socket for the in-container agent to consume.
 *
 * Each proxy:
 *   1. Connects to the external server as an MCP client (stdio, SSE, or HTTP)
 *   2. Discovers available tools via listTools()
 *   3. Creates a local MCP server on a Unix socket at mcp/{name}.sock
 *   4. Proxies tool calls from the container through to the external server
 *
 * The container-side agent-runner scans /mcp/*.sock and creates SDK proxies
 * for each, so external MCP tools appear as mcp__{name}__{toolName}.
 */
import type { ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { AddressInfo } from 'net';

import { agentPath, mcpDir } from '../config.js';
import { mcpTransport } from '../container/mcp-transport.js';
import type { ResolvedMcpServer } from '../config.js';
import { generateId } from '../lib/utils.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Transport creation
// ---------------------------------------------------------------------------

/**
 * Resolve container-convention paths in stdio args to host paths.
 * MCP server declarations use paths relative to the container layout (/assets/, /home/, /memory/).
 * Since the proxy runs on the host, these must be mapped to actual host paths.
 */
function resolveStdioArgs(args: string[] | undefined, agentFolder: string): string[] | undefined {
  if (!args) return args;
  const containerToHost: Record<string, string> = {
    '/assets/': agentPath(agentFolder, 'blueprint', 'assets') + '/',
    '/home/agent/': agentPath(agentFolder, 'home') + '/',
    '/memory/': agentPath(agentFolder, 'memory') + '/',
  };
  return args.map((arg) => {
    for (const [prefix, hostPrefix] of Object.entries(containerToHost)) {
      if (arg.startsWith(prefix)) return hostPrefix + arg.slice(prefix.length);
    }
    return arg;
  });
}

function createTransport(
  config: ResolvedMcpServer,
  agentFolder: string,
): { transport: InstanceType<typeof StdioClientTransport> | InstanceType<typeof SSEClientTransport> | InstanceType<typeof StreamableHTTPClientTransport>; process?: ChildProcess } {
  switch (config.transport) {
    case 'stdio': {
      if (!config.command) throw new Error(`MCP server "${config.name}": stdio transport requires "command"`);
      // StdioClientTransport expects Record<string, string> — filter out undefined values from process.env
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) { if (v !== undefined) env[k] = v; }
      Object.assign(env, config.env);
      const transport = new StdioClientTransport({
        command: config.command,
        args: resolveStdioArgs(config.args, agentFolder),
        env,
      });
      return { transport };
    }
    case 'sse': {
      if (!config.url) throw new Error(`MCP server "${config.name}": sse transport requires "url"`);
      const transport = new SSEClientTransport(new URL(config.url));
      return { transport };
    }
    case 'streamable-http': {
      if (!config.url) throw new Error(`MCP server "${config.name}": streamable-http transport requires "url"`);
      const transport = new StreamableHTTPClientTransport(new URL(config.url));
      return { transport };
    }
    default:
      throw new Error(`MCP server "${config.name}": unsupported transport "${config.transport}"`);
  }
}

// ---------------------------------------------------------------------------
// Socket server (mirrors mcp-server.ts pattern)
// ---------------------------------------------------------------------------

interface SocketSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

function startProxySocketServer(
  socketPath: string,
  serverName: string,
  tools: Tool[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>,
): { ready: Promise<void>; close: () => void; port?: number } {
  if (mcpTransport().mode === 'socket') {
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  const sessions = new Map<string, SocketSession>();

  function createSessionServer(): McpServer {
    const server = new McpServer({ name: serverName, version: '1.0.0' });

    for (const tool of tools) {
      const inputSchema = tool.inputSchema
        ? z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0])
        : z.object({});
      const shape = (inputSchema as { shape?: Record<string, z.ZodType> }).shape ?? {};

      server.tool(
        tool.name,
        tool.description ?? '',
        shape,
        async (args) => callTool(tool.name, args as Record<string, unknown>),
      );
    }

    return server;
  }

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

      const server = createSessionServer();
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

  let assignedPort: number | undefined;

  const transport = mcpTransport();
  const ready = new Promise<void>((resolve, reject) => {
    if (transport.mode === 'tcp') {
      httpServer.listen(0, transport.bindAddr, () => {
        const addr = httpServer.address() as AddressInfo;
        assignedPort = addr.port;
        resolve();
      });
    } else {
      httpServer.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o777); } catch { /* best effort */ }
        resolve();
      });
    }
    httpServer.on('error', reject);
  });

  return {
    ready,
    get port() { return assignedPort; },
    close: () => {
      for (const session of sessions.values()) {
        session.transport.close().catch((err) => logger.debug({ err }, 'mcp-proxy transport close error'));
      }
      sessions.clear();
      httpServer.close();
      if (mcpTransport().mode === 'socket') {
        try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// McpProxy — single external MCP server
// ---------------------------------------------------------------------------

export class McpProxy {
  private client: Client | null = null;
  private socketServer: { ready: Promise<void>; close: () => void; port?: number } | null = null;
  readonly socketPath: string;
  readonly name: string;

  constructor(
    private config: ResolvedMcpServer,
    private agentFolder: string,
  ) {
    this.name = config.name;
    this.socketPath = path.join(mcpDir(agentFolder), `${config.name}.sock`);
  }

  /** TCP port assigned after start() resolves (only set in TCP mode). */
  get port(): number | undefined {
    return this.socketServer?.port;
  }

  async start(): Promise<void> {
    const { transport } = createTransport(this.config, this.agentFolder);

    this.client = new Client({ name: `${this.config.name}-proxy`, version: '1.0.0' });
    await this.client.connect(transport);

    const { tools } = await this.client.listTools();
    logger.info(
      { agentFolder: this.agentFolder, mcpServer: this.config.name, toolCount: tools.length, tools: tools.map(t => t.name) },
      'External MCP server connected',
    );

    const client = this.client;
    this.socketServer = startProxySocketServer(
      this.socketPath,
      this.config.name,
      tools,
      async (name, args) => {
        const result = await client.callTool({ name, arguments: args });
        return result as CallToolResult;
      },
    );

    await this.socketServer.ready;
    logger.info(
      { agentFolder: this.agentFolder, mcpServer: this.config.name, socketPath: this.socketPath, port: this.socketServer.port },
      'MCP proxy listening',
    );
  }

  async stop(): Promise<void> {
    if (this.socketServer) {
      this.socketServer.close();
      this.socketServer = null;
    }
    if (this.client) {
      await this.client.close().catch((err) => logger.debug({ err }, 'mcp-proxy client close error'));
      this.client = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Delta diffing
// ---------------------------------------------------------------------------

/**
 * Canonical hash over the lifecycle-relevant fields of a ResolvedMcpServer.
 * Equality of the hash means two configs would produce identical proxy
 * behavior; any difference triggers a stop+start cycle. Env keys are sorted
 * so stable input order doesn't change the hash.
 *
 * Logged values: only the hash and `name`. Raw env never enters logs.
 */
export function hashServer(s: ResolvedMcpServer): string {
  const sortedEnvEntries = Object.keys(s.env).sort().map((k) => [k, s.env[k]]);
  const canonical = JSON.stringify({
    name: s.name,
    transport: s.transport,
    command: s.command ?? null,
    args: s.args ?? [],
    url: s.url ?? null,
    env: sortedEnvEntries,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface DeltaSummary {
  added: string[];
  removed: string[];
  changed: string[];
}

export type DeltaResult =
  | { type: 'noop' }
  | { type: 'changed'; summary: DeltaSummary };

interface PendingSlot {
  servers: ResolvedMcpServer[];
  resolve: (r: DeltaResult) => void;
  reject: (e: unknown) => void;
  promise: Promise<DeltaResult>;
}

interface ProxyEntry {
  proxy: ProxyHandle;
  hash: string;
}

/** Minimal interface — satisfied by McpProxy and test fakes alike. */
export interface ProxyHandle {
  readonly name: string;
  readonly port: number | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type ProxyFactory = (config: ResolvedMcpServer, agentFolder: string) => ProxyHandle;

const defaultProxyFactory: ProxyFactory = (config, folder) => new McpProxy(config, folder);

// ---------------------------------------------------------------------------
// McpProxyManager — all external MCP proxies for an agent
// ---------------------------------------------------------------------------

/**
 * Lifecycle owner for one agent's external MCP proxy fleet.
 *
 * `startAll` is the initial-state entry; `applyDelta` is the live-edit entry.
 * Concurrent `applyDelta` calls serialize through a single-slot rerun queue:
 * the trailing run uses the *last-arrived* server list (collapsing N pending
 * edits → 1 trailing run). All callers in the same coalesced batch share the
 * same returned promise.
 */
export class McpProxyManager {
  private proxies = new Map<string, ProxyEntry>();

  // Concurrency invariant: at most one slot pending at a time. The run loop
  // pops and processes; new calls overwrite `pending.servers` rather than
  // queueing additional runs. `running` is true exactly while runLoop holds
  // the processing turn.
  private running = false;
  private pending: PendingSlot | null = null;

  constructor(
    private folder: string,
    private proxyFactory: ProxyFactory = defaultProxyFactory,
  ) {}

  /** Initial start. Cleans stale external sockets, starts each proxy
   *  sequentially (failures are logged but don't poison the others). */
  async startAll(servers: ResolvedMcpServer[]): Promise<void> {
    // Clean stale external MCP sockets (not cast.sock or agent.sock)
    if (mcpTransport().mode === 'socket') {
      const sockDir = mcpDir(this.folder);
      if (fs.existsSync(sockDir)) {
        const stale = fs.readdirSync(sockDir).filter(
          f => f.endsWith('.sock') && f !== 'cast.sock' && f !== 'agent.sock',
        );
        for (const f of stale) {
          try { fs.unlinkSync(path.join(sockDir, f)); } catch { /* ignore */ }
        }
      }
    }

    for (const server of servers) {
      await this.startOne(server);
    }
  }

  /**
   * Diff against the current proxy set; stop removed, start added, restart
   * changed (hash-based). Concurrent calls coalesce through a single-slot
   * rerun queue.
   *
   * Caller contract: the AgentManager invokes `markAllInvalidated()` (and the
   * lifecycle event) only when `result.type === 'changed'`. Even when a proxy
   * with the same name is restarted, the host unlinks and re-creates its
   * socket inode; the container's already-open MCP `Client` keeps talking to
   * the dead inode unless the runner respawns. So invalidation is mandatory
   * on any non-empty diff, never internally optional.
   */
  async applyDelta(servers: ResolvedMcpServer[]): Promise<DeltaResult> {
    if (this.pending) {
      // Coalesce: overwrite servers; all in-flight callers in this batch
      // share the same trailing-run promise.
      this.pending.servers = servers;
      return this.pending.promise;
    }
    let resolveFn!: (r: DeltaResult) => void;
    let rejectFn!: (e: unknown) => void;
    const promise = new Promise<DeltaResult>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    this.pending = { servers, resolve: resolveFn, reject: rejectFn, promise };
    if (!this.running) {
      void this.runLoop();
    }
    return promise;
  }

  private async runLoop(): Promise<void> {
    this.running = true;
    while (this.pending) {
      const slot = this.pending;
      this.pending = null;
      try {
        const result = await this.runDelta(slot.servers);
        slot.resolve(result);
      } catch (err) {
        slot.reject(err);
      }
    }
    this.running = false;
  }

  private async runDelta(servers: ResolvedMcpServer[]): Promise<DeltaResult> {
    const newConfigs = new Map<string, ResolvedMcpServer>();
    const newHashes = new Map<string, string>();
    for (const s of servers) {
      newConfigs.set(s.name, s);
      newHashes.set(s.name, hashServer(s));
    }

    const summary: DeltaSummary = { added: [], removed: [], changed: [] };

    // Diff against the current proxy set: anything we hold that isn't in the
    // new config is removed; anything new or with a changed hash needs to be
    // added or replaced.
    for (const name of this.proxies.keys()) {
      if (!newConfigs.has(name)) summary.removed.push(name);
    }
    for (const [name, hash] of newHashes) {
      const existing = this.proxies.get(name);
      if (!existing) summary.added.push(name);
      else if (existing.hash !== hash) summary.changed.push(name);
    }

    if (
      summary.added.length === 0 &&
      summary.removed.length === 0 &&
      summary.changed.length === 0
    ) {
      return { type: 'noop' };
    }

    for (const name of summary.removed) {
      await this.stopOne(name);
    }
    for (const name of summary.changed) {
      await this.stopOne(name);
      const cfg = newConfigs.get(name);
      if (cfg) await this.startOne(cfg);
    }
    for (const name of summary.added) {
      const cfg = newConfigs.get(name);
      if (cfg) await this.startOne(cfg);
    }

    logger.info(
      {
        agentFolder: this.folder,
        added: summary.added,
        removed: summary.removed,
        changed: summary.changed,
      },
      'MCP proxy delta applied',
    );
    return { type: 'changed', summary };
  }

  /** Start one proxy. Failures are logged and skipped — the failed entry is
   *  not added to `proxies`, so a subsequent applyDelta sees it as "added"
   *  again and can retry once the user fixes the config. */
  private async startOne(server: ResolvedMcpServer): Promise<void> {
    const proxy = this.proxyFactory(server, this.folder);
    try {
      await proxy.start();
      this.proxies.set(server.name, { proxy, hash: hashServer(server) });
    } catch (err) {
      logger.error(
        { agentFolder: this.folder, mcpServer: server.name, err },
        'Failed to start external MCP proxy (non-fatal)',
      );
    }
  }

  private async stopOne(name: string): Promise<void> {
    const entry = this.proxies.get(name);
    if (!entry) return;
    this.proxies.delete(name);
    try {
      await entry.proxy.stop();
    } catch (err) {
      logger.warn(
        { agentFolder: this.folder, mcpServer: name, err },
        'Error stopping MCP proxy (continuing)',
      );
    }
  }

  /** TCP port mappings for all started proxies (only populated in TCP mode). */
  getPortMappings(): Record<string, number> {
    const ports: Record<string, number> = {};
    for (const entry of this.proxies.values()) {
      if (entry.proxy.port !== undefined) ports[entry.proxy.name] = entry.proxy.port;
    }
    return ports;
  }

  async stopAll(): Promise<void> {
    const entries = [...this.proxies.values()];
    this.proxies.clear();
    await Promise.allSettled(entries.map((e) => e.proxy.stop()));
  }
}
