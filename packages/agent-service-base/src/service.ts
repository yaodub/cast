/**
 * Service factory — the main entry point for agent services.
 *
 * `createService()` returns an object with methods to register MCP tools
 * and prompt contributions. Call `start()` to begin serving.
 */
import fs from 'fs';
import http from 'http';

import { z, type ZodRawShape } from 'zod';

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
// Tool approval + per-call context
//
// Deliberately mirrors extension-schema's ToolDefinition.approval / the
// participant in ToolCallContext, rather than importing them: services run in a
// separate process (and the runner that stamps the context is on a different
// Zod major), so this is the codebase's cross-boundary idiom — duplicate the
// shape, cite the canonical source, never couple. The framework wraps an
// approval-declared tool exactly as the host wraps an extension tool.
// ---------------------------------------------------------------------------

/** MCP tool result (the SDK's CallToolResult text form). */
export type ServiceToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Host-attested per-call context, carried in MCP `_meta` and stamped by the
 *  agent-runner. Faithful mirror of the canonical wire keys in agent-schema's
 *  container-io.ts — `channelName`, not `channel` (the host's IPC vocab). */
export type ServiceCallMeta = { participant?: string; channelName?: string; conversationKey?: string };

/** Declarative approval on a service tool — parallel to extension-schema's
 *  ToolDefinition.approval. `filter`/`wasApproved` (conversation-scoped trust
 *  inheritance) are deferred; they need a cross-process history lookup. */
export interface ServiceToolApproval {
  /** Whether approval is required. A function is re-read per call, so it can
   *  reflect a live setting (e.g. `() => svc.settings.REQUIRE_APPROVAL !== false`). */
  enabled: boolean | (() => boolean);
  /** Seconds until the request expires (default: host default). */
  expiry?: number;
  /** User-facing preview of the pending action. Async so it may fetch context;
   *  throw to abort with no approval raised (fail-fast validation). */
  preview: (args: Record<string, unknown>) =>
    | { summary: string; details?: string }
    | Promise<{ summary: string; details?: string }>;
}

/** Inferred args for a tool's Zod shape (matches McpServer.tool's inference). */
type ToolArgs<S extends ZodRawShape> = z.objectOutputType<S, z.ZodTypeAny>;
type ToolHandler<S extends ZodRawShape> =
  (args: ToolArgs<S>, extra?: unknown) => ServiceToolResult | Promise<ServiceToolResult>;

/** Register an MCP tool. Mirrors McpServer.tool(); the optional `{ approval }`
 *  slot before the handler (echoing MCP's annotations-before-callback overload)
 *  makes the tool approval-gated, handled by the framework. */
export interface ServiceToolRegistrar {
  <S extends ZodRawShape>(name: string, description: string, schema: S, handler: ToolHandler<S>): void;
  <S extends ZodRawShape>(name: string, description: string, schema: S, options: { approval: ServiceToolApproval }, handler: ToolHandler<S>): void;
}

/** Boundary validator for the `_meta` the runner stamps — Zod at the edge,
 *  never `as any`. Mirrors the canonical wire keys verbatim: `participant`,
 *  `channelName`, `conversationKey` (the runner stamps `channelName`; mapping to
 *  the host's `channel` IPC field happens only at emitApprovalRequest). */
const ToolCallMetaSchema = z.object({
  participant: z.string(),
  channelName: z.string(),
  conversationKey: z.string(),
}).partial();

/** Extract the host-attested call context from an MCP handler's `extra`.
 *  Exported for tests. */
export function parseCallMeta(extra: unknown): ServiceCallMeta {
  const parsed = z.object({ _meta: ToolCallMetaSchema.optional() }).safeParse(extra);
  return parsed.success && parsed.data._meta ? parsed.data._meta : {};
}

function errorResult(text: string): ServiceToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

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
  /** Raw request body (forms POSTing through the host proxy). Absent on
   *  body-less requests. Parse it yourself (URLSearchParams / JSON.parse). */
  body?: string;
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
  /**
   * Secrets from config/ext/service/secrets.json, snapshotted at startup.
   * Keys are declared in blueprint/service/manifest.json (`secrets` field);
   * the server restarts the service when the file changes, so the snapshot
   * is always current — there is no live reload.
   */
  readonly secrets: Record<string, string>;
  /**
   * Settings from config/ext/service/config.json, snapshotted at startup —
   * the non-credential sibling of `secrets` (declared via the manifest's
   * `config` field, native JSON types). Named `settings` because `config`
   * is taken by the injected ServiceConfig above. Same freshness rule: the
   * server restarts the service when the file changes. Declared defaults
   * are a form-display concern; apply fallbacks in service code
   * (`svc.settings.INTERVAL ?? 30`).
   */
  readonly settings: Record<string, string | number | boolean>;

  /** Register an MCP tool. Mirrors McpServer.tool(), plus an optional
   *  `{ approval }` slot before the handler for a framework-wrapped, declarative
   *  approval gate (parallel to how extensions declare approval). */
  tool: ServiceToolRegistrar;

  /** Read the host-attested per-call context (participant/channel/
   *  conversationKey) from a tool handler's `extra`. The approval wrapper uses
   *  this internally; non-approval tools can call it to learn the caller. */
  callMeta(extra: unknown): ServiceCallMeta;

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

/** Read a flat JSON map, keeping only values that pass `keep`. Missing or
 *  invalid file → {} — a service must be able to start unconfigured. */
function loadFlatJson<T>(filePath: string, keep: (v: unknown) => v is T): Record<string, T> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (keep(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Service secrets snapshot from config/ext/service/secrets.json (flat strings). Exported for tests. */
export function loadSecrets(agentDir: string): Record<string, string> {
  return loadFlatJson(`${agentDir}/config/ext/service/secrets.json`, (v): v is string => typeof v === 'string');
}

/** Service settings snapshot from config/ext/service/config.json (string | number | boolean). Exported for tests. */
export function loadSettings(agentDir: string): Record<string, string | number | boolean> {
  return loadFlatJson(
    `${agentDir}/config/ext/service/config.json`,
    (v): v is string | number | boolean =>
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  );
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

  const secrets = loadSecrets(agentDir);
  const settings = loadSettings(agentDir);
  // Deferred tool registrations — replayed on the real McpServer at start().
  // Stored as raw argument tuples; callers get type safety via the McpServer['tool'] signature.
  const toolArgs: unknown[][] = [];
  // Tool handler registry — populated during tool() calls for approval re-invocation.
  // Key: tool name, Value: the handler function (last arg of the McpServer.tool overload).
  const toolHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const prompt = createPromptManager(agentFolder, serviceContextPath);
  let adminServer: http.Server | null = null;
  let approvalIdCounter = 0;

  /** Single home for raising an approval request over IPC — shared by the
   *  declarative wrapper and the public `svc.requestApproval`. */
  const emitApprovalRequest = (data: {
    tool: string;
    args: Record<string, unknown>;
    summary: string;
    details?: string;
    participant: string;
    channel?: string;
    conversationKey?: string;
    expiresIn?: number;
  }): string => {
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
  };

  /** Wrap a raw handler with the approval gate. The raw handler is what runs on
   *  approval (stored separately in `toolHandlers`); this wrapper only ever runs
   *  the request phase, so the approved path cannot re-request — the two phases
   *  are different functions, not a flag. */
  const wrapWithApproval = (
    name: string,
    approval: ServiceToolApproval,
    raw: (...a: unknown[]) => Promise<unknown>,
  ) => async (args: Record<string, unknown>, extra?: unknown): Promise<ServiceToolResult> => {
    const enabled = typeof approval.enabled === 'function' ? approval.enabled() : approval.enabled;
    if (!enabled) return raw(args, extra) as Promise<ServiceToolResult>; // toggle off → direct
    const meta = parseCallMeta(extra);
    if (!meta.participant) {
      return errorResult(`"${name}" requires approval, but this turn has no participant to ask (e.g. a scheduled or multi-party turn). Not proceeding.`);
    }
    let preview: { summary: string; details?: string };
    try {
      preview = await approval.preview(args);
    } catch (err) {
      return errorResult(`Cannot prepare "${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
    emitApprovalRequest({
      tool: name,
      args,
      summary: preview.summary,
      details: preview.details,
      participant: meta.participant,
      channel: meta.channelName,
      conversationKey: meta.conversationKey,
      expiresIn: approval.expiry,
    });
    return { content: [{ type: 'text', text: `Sent to ${meta.participant} for approval. It will run once approved.` }] };
  };

  const svc: Service = {
    config,
    agentDir,
    agentFolder,
    serviceDir,
    sharedDir,
    secrets,
    settings,
    prompt,

    tool(name: string, ...rest: unknown[]): void {
      // Capture the RAW handler (last arg) for approval re-invocation — never the
      // wrapper, so the approved path can't loop back into a request.
      const handler = rest[rest.length - 1];
      if (typeof handler === 'function') {
        toolHandlers.set(name, handler as (...args: unknown[]) => Promise<unknown>);
      }
      // Our approval options ride in the slot before the handler (echoing MCP's
      // annotations-before-cb). The `approval` key distinguishes it from MCP
      // annotations.
      const optsSlot = rest.length >= 4 ? rest[rest.length - 2] : undefined;
      const approval = optsSlot && typeof optsSlot === 'object' && 'approval' in optsSlot
        ? (optsSlot as { approval?: ServiceToolApproval }).approval
        : undefined;
      if (approval && typeof handler === 'function') {
        // Register the wrapped handler; drop our options object from the MCP args.
        toolArgs.push([name, rest[0], rest[1], wrapWithApproval(name, approval, handler as (...a: unknown[]) => Promise<unknown>)]);
      } else {
        toolArgs.push([name, ...rest]);
      }
    },

    callMeta: parseCallMeta,

    routeMessage,

    requestApproval(data) {
      return emitApprovalRequest(data);
    },

    adminSocketPath,

    admin(handler): void {
      // Clean up stale socket from previous run
      try { fs.unlinkSync(adminSocketPath); } catch { /* no stale socket */ }

      adminServer = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', `http://localhost`);
        const query: Record<string, string> = {};
        url.searchParams.forEach((v, k) => { query[k] = v; });

        // Buffer the request body (the host proxy streams it through). 1 MB
        // cap — admin pages carry forms, not uploads.
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        for await (const chunk of req as AsyncIterable<Buffer>) {
          size += chunk.length;
          if (size > 1_048_576) { tooLarge = true; break; }
          chunks.push(chunk);
        }
        if (tooLarge) {
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Request body too large');
          return;
        }
        const body = chunks.length > 0 ? Buffer.concat(chunks).toString('utf-8') : undefined;

        try {
          const result = await handler({ path: url.pathname, method: req.method || 'GET', query, ...(body !== undefined ? { body } : {}) });
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
          // Deadline fallback for connections that won't drain. The host
          // SIGKILLs later than this (its patience exceeds 5s), so exiting
          // here always beats the kill.
          setTimeout(() => process.exit(0), 5_000);
          mcpHandle?.close();
          if (adminServer) {
            // Exit as soon as the admin server has drained — don't make every
            // restart pay the full 5s.
            adminServer.close(() => process.exit(0));
          } else {
            setImmediate(() => process.exit(0));
          }
        }
      });

      // 3. Ready signal
      sendIpc({ type: 'ready' });
      log(agentFolder, 'Service ready');
    },
  };

  return svc;
}
