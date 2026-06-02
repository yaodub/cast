/**
 * ConsoleStrategy — the per-console wiring contract. Each console (design,
 * configure, config-manager, design-manager) supplies an implementation;
 * `ConsoleManager` dispatches per-agent consoles through the registry in
 * `./registry.ts`; server-scope consoles own their own host class.
 *
 * The strategy keeps per-console wiring (channels, mounts, prompt, tools,
 * console-manager hooks) inside its own subdirectory. Adding a new console
 * is a new entry in the registry plus a new subdirectory — never a new
 * branch in shared code.
 *
 * MCP deps + context types live here (not in `./tools.ts`) so strategies
 * and shared tool modules can import them without a circular dep through
 * tools.ts.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { UiDirective } from '@getcast/admin-schema/v1';

import type { AgentDb } from '../agent/agent-db.js';
import type { DeliverToAgent, DeliverToChannel, DeliveryResult } from '../agent/mcp-server.js';
import type { MessageLogStore } from '../lib/message-log-store.js';
import type { VolumeMount } from '../container/container-mounts.js';
import type { AgentChannel } from '../conversations/types.js';
import type { Host } from '../types.js';

import type { ConsoleName } from './index.js';

// --- MCP deps + context ---

export interface ExtensionSecretStatus {
  extension: string;
  key: string;
  isSet: boolean;
}

export type { UiDirective };

/**
 * Outcome of delivery verbs. Re-exported from `agent/mcp-server.ts` so the
 * console deps surface stays in sync with the agent-side surface — per-agent
 * consoles (`__design`, `__configure`) share the same delivery callbacks as
 * the host agent's user-channel MCP, and the types must match.
 */
export type { DeliveryResult };

export interface ConsoleMcpDeps {
  /**
   * Same-agent cross-channel delivery. The hop is local: validate + route to
   * another channel on this agent. Returns after queueing. Per-agent consoles
   * call this with the full 7-arg agent-side signature; server-scope consoles
   * (delegate.ts) pass only the first three.
   */
  deliverToChannel?: DeliverToChannel;
  /**
   * Cross-agent delivery. Validate source-side authorization (push `p` bit
   * on the target channel) then bus-route to the target. Returns after queueing.
   * Self-target is routed locally via `dispatchLocalPush` rather than bus.
   */
  deliverToAgent?: DeliverToAgent;
  /** Resolve a peer-agent label to its registered bus address (e.g.
   *  `a:<folder>@<issuer>`). NOT a folder path — use `ctx.agentId` / the
   *  returned value when comparing identities. */
  resolveAgentByLabel?: (label: string) => string | undefined;
  /** Expire all non-console conversations so they pick up config / blueprint changes. */
  onExpireConversations?: () => { expired: number };
  /** Live runtime snapshot used by design__agent_status. */
  getAgentStatus?: () => {
    serviceStatus: string;
    activeConversations: number;
    channelBreakdown: { channel: string; active: number }[];
    model: string | undefined;
    modelOverrideCount: number;
    owner: string;
  };
  /** Access to the per-agent SQLite DB — Configure's configure__list_participants. */
  getAgentDb?: () => AgentDb;
  /** Generate a 6-digit pairing code for a handle — Configure's configure__pair_user. */
  pairUser?: (handle: string) => string;
  /** Revoke a paired user by identity id — Configure's configure__revoke_user. */
  revokeUser?: (identityId: string) => { ok: boolean; error?: string };
  /** List extension secrets (key names + isSet flags only, never values) — Configure. */
  listExtensionSecrets?: () => ExtensionSecretStatus[];
  /** Emit a ui_directive to the operator's SSE stream — shared admin__navigate tool.
   *  Implementation routes through `bus.routeEvent` so any transport can render it. */
  emitUiDirective?: (
    from: string,
    to: string,
    channel: string,
    directive: UiDirective,
  ) => void;
  /** Materialize a new scratch agent + register it with the server. An
   *  optional `description` is seeded into the manifest at create time (read
   *  by discovery before bus registration, so no metadata refresh is needed).
   *  Server-scope consoles only (Design Manager uses this via
   *  `design_manager__create_agents`). */
  createAgent?: (
    name: string,
    description?: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Dispatch a security-review request for the host agent. Synthesizes an
   *  operator-originated message into Security Manager's `default` channel,
   *  including a primed prompt that tells SM to read the agent and converse
   *  with the operator before calling `security__finalize_agent`. The agent's
   *  `manifest.status` is NOT mutated here — SM owns the flip. Per-agent Design
   *  uses this from `design__request_review`. */
  requestSecurityReview?: (changeId: string) => void;
  /** Set the host agent's manifest `description` and refresh the live bus
   *  metadata so the roster, peer lists, and admin UI reflect it without a
   *  re-register. Per-agent Design uses this from `design__set_description`.
   *  Returns a caller-correctable error rather than throwing. */
  setDescription?: (description: string) => { ok: true } | { ok: false; reason: string };
  /** Shorten the console session's idle timeout to a cooldown period. The
   *  console's session host installs a manual-end timer; participant traffic
   *  resets it. Console strategies set `cleanupEnabled: false`, so on elapse
   *  the slot frees with no cleanup turn — different from user channels.
   *  Implemented per-host: per-agent consoles use ConsoleManager's session
   *  host, server-scope consoles use their own. AgentManager's equivalent
   *  can't be reused because `loadChannelsConfig` filters `__`-prefixed
   *  channel names. */
  onEndConversation?: (
    conversationKey: string,
    cooldownMs?: number,
  ) => { accepted: boolean; cooldownSeconds: number; reason?: string };
}

export interface ConsoleMcpContext {
  /** Persistence-space folder for the host agent — `mnt/agents/<folder>/`.
   *  Named `hostFolder` (not `agentFolder`) to break the visual proximity
   *  to address-space `agentId`; the two are different identifier spaces. */
  hostFolder: string;
  agentId: string;
  /** Participant address (owner). */
  participant: string | null;
  channelName: string;
  consoleName: ConsoleName;
  /** Console-scope message log bundle — `console_log__*` tools read/write here.
   *  Per-agent consoles get the agent's `console.db`; server-scope consoles get
   *  the shared `server-console.db`. Undefined skips tool registration. */
  messageLog?: MessageLogStore;
  /** Effective IANA timezone for ISO rendering in `console_log__*` tool output. */
  timezone?: string;
  /** Tools to suppress (channel-level disabled_tools). */
  disabledTools?: string[];
  /** Live conversation-key resolver — `conversation__end` reads this at call
   *  time to address the session host. Console sessions are one-key-per-
   *  spawn, but keeping the indirection matches the agent-side pattern in
   *  `McpAgentContext`. */
  getConversationKey?: () => string | null;
}

// --- Strategy ---

/**
 * Per-console wiring. All members are read at session-open time; none should
 * close over mutable agent state (e.g. config, service status) — dynamic data
 * flows in through `ConsoleContext` + `ConsoleMcpDeps`.
 */
export interface ConsoleStrategy {
  /** Console identifier (matches `ConsoleName`). */
  readonly name: ConsoleName;
  /** Derived channel name — `__<name>`. */
  readonly channelName: string;
  /** Channel config (TTL, log flags, lifecycle). */
  readonly channel: AgentChannel;
  /** Container workdir; `undefined` → container image default. */
  readonly workdir: string | undefined;
  /**
   * Container network policy. `'full'` = general internet; `'sdk-only'` =
   * Anthropic API only; `undefined` = inherit agent config.
   */
  readonly containerNetwork: 'full' | 'sdk-only' | undefined;
  /** Per-console prompt header appended after the shared overview + console manual. */
  readonly promptHeader: string;
  /** Mount additions on top of `buildBaseMounts`. Called per session open. */
  buildMountAdditions(agent: Host, conversationKey: string): VolumeMount[];
  /** Pre-spawn hook — e.g. Design snapshots `blueprint/`. No-op by default. */
  onSessionOpen?(agentFolder: string, conversationKey: string): void;
  /** Runner-removed hook — e.g. Design cleans its snapshot. No-op by default. */
  onRunnerRemoved?(agentFolder: string, conversationKey: string): void;
  /**
   * Startup sweep — deletes orphan artifacts (e.g. Design snapshots left
   * behind after a crash). `activeKeys` is the set of live runner keys
   * tracked by the session host; anything on disk not in the set is orphan.
   * Called once from `ConsoleManager`'s constructor.
   */
  sweepOrphanArtifacts?(agentFolder: string, activeKeys: Set<string>): void;
  /** Register console-specific MCP tools. Shared tools are registered separately. */
  registerTools(server: McpServer, ctx: ConsoleMcpContext, deps: ConsoleMcpDeps): void;
  /**
   * Whether the SDK streams intermediate assistant text (narration between
   * tool calls) to the participant. `true` gives the operator motion while
   * the agent works; `false` buffers everything until the final reply.
   *
   * Per-agent consoles read this from `agentConfig.showConsoleSteps`
   * (default `true`). Server-scope consoles (DM, CM, SM) set it here — DM
   * + CM want `true` so multi-step pushes aren't a silent wall; SM wants
   * `false` so its findings output is a single clean reply. If undefined,
   * the server-scope default is `false` (conservative).
   */
  readonly showSteps?: boolean;
  /**
   * If true, drop `emitUiDirective` from this console's mcpDeps so the shared
   * `admin__navigate` tool short-circuits at registration. Opt out when this
   * console's natural workflow hands navigation to a sibling surface rather
   * than doing it itself. Per-agent Design is the only opt-out today: it
   * composes blueprints and pushes into the same-agent Configure, which does
   * the form-pointing.
   */
  readonly omitAdminNavigate?: boolean;
}
