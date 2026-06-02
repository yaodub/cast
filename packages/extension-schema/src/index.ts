/**
 * @getcast/extension-schema — shared types and utilities for Cast extensions.
 *
 * Defines the contract between extensions, the server host, and service hosts.
 * Extensions import from this package — never from server internals.
 *
 * Runtime exports: textResult(), defineExtension(), noopLogger
 * Type exports: Logger, ToolDefinition, ToolCallContext, ToolResult,
 *               ExtensionContext, ExtensionInstance, ExtensionDefinition
 */
import type { z } from 'zod';

// ---------------------------------------------------------------------------
// Logger — abstract, pino-compatible but agnostic
// ---------------------------------------------------------------------------

/** Structured logger interface. Pino, winston, bunyan all satisfy this. */
export interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Silent logger — used when host does not inject one. */
export const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

// ---------------------------------------------------------------------------
// Tool types
// ---------------------------------------------------------------------------

/** Zod schema for a single tool's parameters (passed to server.tool()). */
export type ToolParamSchema = Record<string, z.ZodTypeAny>;

/**
 * Context passed to an approval filter. Lets filters consult approval history
 * so one tool can inherit trust from an earlier approval of a related tool
 * (e.g. whatsapp__download skips approval if whatsapp__messages was already
 * approved for the same chat).
 */
export interface ApprovalFilterContext {
  /**
   * Returns true if an approved row exists in the *current conversation* for
   * any of `tools` whose args JSON satisfies `match`. Scope is the conversation
   * itself — when the conversation ends, so does the implicit trust.
   *
   * Returns false when called outside a conversation context (no conversation_key).
   */
  wasApproved: (tools: string[], match: (args: Record<string, unknown>) => boolean) => boolean;
}

/** MCP tool definition — mirrors the arguments to McpServer.tool(). */
export interface ToolDefinition {
  name: string;
  description: string;
  schema: ToolParamSchema;
  /** When present, the framework wraps this tool's handler with the approval flow. */
  approval?: {
    /** Whether approval is currently required (resolved from extension config at activation time). */
    enabled: boolean;
    /** Seconds until the approval request expires. Default: 3600 (1 hour). */
    expiry?: number;
    /** Generate the user-facing approval preview. Required — raw args are not acceptable UX. */
    preview: (args: Record<string, unknown>) => { summary: string; details?: string };
    /** Optional per-call filter. Returns 'approve' | 'skip' | 'block'. Omit for all-or-nothing. */
    filter?: (args: Record<string, unknown>, ctx: ApprovalFilterContext) => 'approve' | 'skip' | 'block';
  };
}

/** Per-conversation context passed to extension tool handlers. */
export interface ToolCallContext {
  /** Pre-resolved staging/in path for this conversation (extension → agent). */
  stagingDir: string;
  /** Pre-resolved staging/out path for this conversation (agent → extension). */
  stagingOutDir: string;
  /** Caller identity (user or service). Undefined in agent-level (non-conversation) context. */
  participant?: string;
}

/** MCP tool result — matches the MCP SDK's CallToolResult shape. */
// Type alias (not interface) required: MCP SDK expects `[x: string]: unknown` index signature.
export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/** Build a text ToolResult. */
export function textResult(text: string, isError?: boolean): ToolResult {
  const result: ToolResult = { content: [{ type: 'text', text }] };
  if (isError) result.isError = true;
  return result;
}

// ---------------------------------------------------------------------------
// Extension instance (what create() returns)
// ---------------------------------------------------------------------------

/** An activated extension instance for a specific agent. */
export interface ExtensionInstance {
  /** Extension name (e.g. 'web-fetch'). */
  name: string;
  /** Tools this extension provides for this agent. */
  tools: ToolDefinition[];
  /** Handle a tool call. */
  handle: (
    toolName: string,
    args: Record<string, unknown>,
    call: ToolCallContext,
  ) => Promise<ToolResult>;
  /** Optional system prompt section contributed by this extension. */
  promptSection?: string;
  /** Start per-agent background tasks (IDLE connections, timers). Called after construction. */
  onAgentStart?: () => Promise<void>;
  /** Stop per-agent background tasks. Called at agent/server shutdown. */
  onAgentStop?: () => void;
}

// ---------------------------------------------------------------------------
// Extension context (injected by host)
// ---------------------------------------------------------------------------

/** Context passed to the extension constructor — everything the extension needs to set up for one agent. */
export interface ExtensionContext<TConfig = unknown, TSecrets = unknown> {
  agentFolder: string;
  /** Merged config (author locked-by-default + operator overrides). Validated. */
  config: TConfig;
  /** Parsed secrets from config/ext/{name}/secrets.json. Validated. */
  secrets: TSecrets;
  /** Private runtime directory: ext/{name}/ (DBs, caches, auth tokens — never mounted). */
  privateDir: string;
  /** Shared output directory visible to agent: shared/ext/{name}/ (mounted read-only at /shared/{name}). */
  sharedDir: string;
  /** Whether the host configured a dedicated channel for this extension's notifications. */
  hasChannel: boolean;
  /** Push a message to this agent from the extension. Routes directly (bypasses ACL).
   *  Channel is baked in by the host — extensions pass replyTo only.
   *  On success, `result` carries the agent's first output (null if no response). */
  deliver: (
    text: string,
    opts?: { replyTo?: string },
  ) => Promise<{ ok: true; result: string | null } | { ok: false; error: string }>;
  /** Structured logger. Optional — extensions fall back to noopLogger. */
  log?: Logger;
}

// ---------------------------------------------------------------------------
// Extension definition (what defineExtension() returns)
// ---------------------------------------------------------------------------

/**
 * Extension definition — the unit of extension registration.
 *
 * Three generics, all inferred from the definition object:
 * - TConfig from configSchema (Zod)
 * - TSecrets from secretsSchema (Zod)
 * - TInstance from create()'s return type — preserves public methods for service-side direct access
 */
export interface ExtensionDefinition<
  TConfig,
  TSecrets,
  TInstance extends ExtensionInstance,
> {
  name: string;
  /** Zod schema for behavioral config (from capabilities.json + operator override). */
  configSchema: z.ZodType<TConfig>;
  /** Zod schema for credentials (from config/ext/{name}/secrets.json). */
  secretsSchema: z.ZodType<TSecrets>;
  /** Server-level startup (optional — shared resource pools). */
  onServerStart?: (log: Logger) => Promise<void>;
  /** Server-level shutdown (optional). */
  onServerStop?: (log: Logger) => Promise<void>;
  /** Construct an instance for a specific agent. */
  create: (ctx: ExtensionContext<TConfig, TSecrets>) => TInstance;
  /**
   * Optional admin hook — verify credentials and discover available resources.
   * Called by the admin dashboard's "Connect" / "Test Connection" button.
   * Authenticates, optionally returns a resource inventory (calendars, chats, folders, etc.).
   *
   * Receives:
   *   - `secrets` — already parsed via `secretsSchema`; storage format is the
   *     server's concern, never the extension's.
   *   - `privateDir` — full path to the extension's per-agent runtime dir
   *     (e.g. `<agent>/ext/<name>/`). Use only when the connect probe needs
   *     to inspect runtime artifacts (e.g. WhatsApp Baileys auth files).
   *     Most extensions consult `secrets` and ignore this.
   */
  connect?: (ctx: { secrets: TSecrets; privateDir: string }) => Promise<{
    ok: boolean;
    message: string;
    state?: unknown;
  }>;
}

/**
 * Define an extension. Identity function — exists for type inference.
 *
 * ```typescript
 * export const email = defineExtension({
 *   name: 'email',
 *   configSchema: EmailConfigSchema,
 *   secretsSchema: EmailSecretsSchema,
 *   create: (ctx) => new EmailExtension(ctx),
 * });
 * ```
 */
export function defineExtension<
  TConfig,
  TSecrets,
  TInstance extends ExtensionInstance,
>(
  def: ExtensionDefinition<TConfig, TSecrets, TInstance>,
): ExtensionDefinition<TConfig, TSecrets, TInstance> {
  return def;
}
