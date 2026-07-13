/**
 * AgentManager — per-agent runtime manager, implements BusHandler.
 *
 * Owns everything related to running a single agent:
 * - ConversationRunner registry and concurrency
 * - Agent service process lifecycle (IPC, crash recovery)
 * - MCP socket server lifecycle
 */
import type { ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { AgentManifestSchema, type AgentConfig, type BackupConfig } from '@getcast/agent-schema/v1';
import type { ExtensionInstance } from '@getcast/extension-schema';
import { AgentExtensions } from '../extensions/registry.js';
import type { FileWatcher } from '../lib/file-watcher.js';

import { snapshotAgent } from './agent-backup.js';
import { AgentService } from './agent-service.js';
import { AgentScheduler } from './agent-scheduler.js';
import {
  extractHandle,
  extractIdentity,
  isAgent,
  isParticipantAddress,
  isSystemSender,
  isUser,
} from '../auth/address.js';
import type { IdentityId } from '../auth/address.js';
import { readRoster } from '../lib/identity-roster.js';
import type { IdentityProvider } from '../auth/identity.js';
import type { LogHostEventFn } from '../server/host-activity-log.js';
import { readAgentConfig } from '../container/container-runner.js';
import { EgressController } from '../container/egress-controller.js';
import { readJson, readText } from '../lib/config-reader.js';
import type { AgentSummary, Bus, BusHandler, EventDeliveryDecision } from '../gateway/bus.js';
import { checkAcl, getPeerChannels, hasBit } from '../auth/acl.js';
import { deriveChannelContract } from '../auth/channel-contract.js';
import {
  CONFIG_RELOAD_DEBOUNCE_MS,
  EGRESS_REFRESH_MS,
  MAX_ATTACHMENT_BYTES,
  PUSH_ROW_SWEEP_MS,
  PUSH_ROW_TTL_MS,
  TIMEZONE,
  agentPath,
  castSocketPath,
  resolveCapabilities,
  resolveMcpServers,
} from '../config.js';
import { createDebounced, type DebounceHandle } from '../lib/debounce.js';
import { McpProxyManager } from './mcp-proxy.js';
import { FileWatchService } from './file-watch-service.js';
import type { ConversationRunnerOpts } from './conversation-runner.js';
import {
  buildSpawnHooks as externalBuildSpawnHooks,
  emitOutboundRequest,
  HeldOutboundRequestSchema,
  systemUndelivered,
} from './agent-spawn-hooks.js';
import { ApprovalHandler } from './approval-handler.js';
import { type Routing, type SiblingAgentInfo } from './agent-bus-payload.js';
import {
  deliverHeldInboundRequest,
  deliverHeldMessage,
  deliverHeldPush,
  handleBusMessage,
  HeldInboundRequestSchema,
  HeldMessageSchema,
  HeldPushDeliverySchema,
  rejectHeldInboundRequest,
  rejectHeldMessage,
  rejectHeldPush,
  type BusHandlerDeps,
} from './agent-bus-handler.js';
import { buildAgentMcpDeps, declineLocalPush, emitLocalPush, emitPush, HeldLocalPushSchema, HeldPushSchema } from './agent-mcp-deps.js';
import {
  closeConversationByAddress,
  routeMessage as externalRouteMessage,
  type AgentRouteDeps,
} from './agent-route.js';
import type { DeliverKind } from './conversation-runner.js';
import {
  buildConsoleContext as externalBuildConsoleContext,
  buildConsoleMcpDeps as externalBuildConsoleMcpDeps,
  type ConsoleBuilderDeps,
} from './console-builders.js';
import { getChannel, loadChannelsConfig } from '../conversations/channel-config.js';
import { resolveConversationKey, serializeConversationKey } from '../conversations/resolve-key.js';
import {
  DEFAULT_CHANNEL,
  DEFAULT_CHANNEL_NAME,
} from '../conversations/types.js';
import type { AgentChannel } from '../conversations/types.js';
import { isConsoleChannel, type ConsoleName } from '../console/index.js';
import { parseConsoleName } from '../console/registry.js';
import type { ConsoleContext } from '../console/prompt.js';
import { ConsoleManager } from '../console/console-manager.js';
import { ConsoleDb } from '../console/console-db.js';
import type { ConsoleMcpDeps } from '../console/tools.js';
import { logger } from '../logger.js';
import { startMcpSocketServer, type McpServerDeps } from './mcp-server.js';
import { AgentDb } from './agent-db.js';
import { getProfile } from '../profiles/index.js';
import type { ConversationPkt } from '../gateway/packets.js';
import { assembleSystemPrompt } from './prompt-assembly.js';
import { AgentStateStore } from './state-store.js';
import type {
  Attachment,
  AttachmentMeta,
  Evt,
  Host,
  LifecyclePhase,
  RouteResult,
} from '../types.js';
import { persistAttachment } from '../lib/attachment-store.js';
import { stripFrameworkTags } from '../lib/format.js';
import { generateId, roughTimeAgo } from '../lib/utils.js';

import { slotPool, conversations } from '../lib/gates.js';
import {
  type BuildSpawnHooks,
  type ConversationView,
  type RunnerFactory,
  type IdleTimeoutMeta as ConvIdleTimeoutMeta,
} from '../conversations/index.js';
import { ConversationRunner } from './conversation-runner.js';
import type { RouteContext as AgentSpawnContext } from './agent-route.js';

export type { AgentSpawnContext };

// --- Types ---

interface AgentManagerOpts {
  host: Host;
  bus: Bus;
  mcpDeps?: McpServerDeps;
  identityProvider?: IdentityProvider;
  agentId: string;
  watcher: FileWatcher;
  listSiblingAgents?: () => SiblingAgentInfo[];
  /** Surfaces agent-tier security/host events (e.g. a dropped forged approval
   *  response) to the operator's host-events view. */
  logHostEvent?: LogHostEventFn;
  /** Stop any container processes still tagged with this agent's folder. Best-effort,
   *  fire-and-forget; called from shutdown() AFTER drainRunners SIGKILLs stragglers
   *  so containers that didn't get to run their own cleanup get reaped. */
  containerSweep?: (folder: string) => void;
}

export class AgentManager implements BusHandler {
  readonly folder: string;
  readonly agentId: string;
  private host: Host;
  private bus: Bus;
  private mcpDeps: McpServerDeps | undefined;
  private idp: IdentityProvider | undefined;
  private logHostEvent: LogHostEventFn | undefined;

  /** Scope key for this agent on the `conversations` façade. */
  private get agentScope(): string { return `agent:${this.folder}`; }

  // --- Console-session orchestrator ---
  private consoleManager!: ConsoleManager;

  // --- Service process ---
  private service: AgentService;

  // --- Approval handler (initialized in init() after extensions are ready) ---
  private approvals!: ApprovalHandler;

  // --- MCP socket ---
  private mcpCloser: { ready: Promise<void>; close: () => void } | null = null;

  // --- State store ---
  private store: AgentStateStore;

  // --- Agent database (always open — participants table is a security gate) ---
  private agentDb: AgentDb;

  // --- Console database (per-agent, isolated from agent.db). Stores Design
  //     and Configure session history; discriminated by `channel` on the row. ---
  private consoleDb: ConsoleDb;

  // --- Scheduler ---
  private scheduler: AgentScheduler;

  // --- Backup ---
  private backupTimer: ReturnType<typeof setTimeout> | null = null;
  /** Snapshot of the last backup config the timer was armed against — used by
   *  `maybeRestartBackupTimer` to skip a no-op restart on every reload tick. */
  private lastBackupConfigJson: string | null = null;

  /** Periodic TTL sweep for outbound_pushes rows (the rejection-correlation
   *  table). Pushes have no positive-ack terminal, so rows age out by TTL. */
  private pushSweepTimer: ReturnType<typeof setInterval> | null = null;

  /** sdk-only egress pin refresher: re-resolves this agent's allowlist on a
   *  timer (and on config hot-reload) and reconciles each running container's
   *  CAST_EGRESS chain + /etc/hosts. Holds per-container pin state. */
  private egress = new EgressController();
  private egressTimer: ReturnType<typeof setInterval> | null = null;

  /** Disposer for the agent's `ConversationEventBus` subscription — set in
   *  the constructor right after `conversations.registerScope`, called on
   *  shutdown. The bus is the sole observation surface for queue UX +
   *  expiry side-effects. */
  private conversationEventDispose: (() => void) | null = null;

  /** Effective IANA timezone for this agent (config override, else server default).
   *  Read-through: re-reads `config/agent.json` on every access (FileWatcher-cached). */
  get timezone(): string { return this.effectiveTimezone; }

  // ---- Read-through derived values ----
  // These re-read their backing files on every access so config edits land
  // without a constructor rebuild. `readAgentConfig` and `readJson` both go
  // through the FileWatcher cache, so per-call cost is a Map lookup, not a
  // syscall.

  private get profileName(): string {
    const settings = readJson(
      agentPath(this.folder, 'blueprint', 'props', 'settings.json'),
    );
    if (
      settings && typeof settings === 'object' && 'profile' in settings &&
      typeof settings.profile === 'string'
    ) {
      return settings.profile;
    }
    return 'standard';
  }

  private get effectiveTimezone(): string {
    return readAgentConfig(this.folder).timezone || TIMEZONE;
  }

  private get backupConfig(): BackupConfig | undefined {
    return readAgentConfig(this.folder).backup;
  }

  /** True when the manifest sets `status: 'draft'`. Read-through via the FileWatcher
   *  cache (agent root is watched at depth 0), so flipping draft↔ready in the Design
   *  console takes effect on the next inbound message — no restart. */
  private get isDraft(): boolean {
    const manifest = readJson(agentPath(this.folder, 'manifest.json'));
    return (
      typeof manifest === 'object' &&
      manifest !== null &&
      'status' in manifest &&
      (manifest as { status?: unknown }).status === 'draft'
    );
  }

  // --- Extensions ---
  private extensions!: AgentExtensions;

  // --- File watcher ---
  private watcher: FileWatcher;

  // --- External MCP proxies ---
  private mcpProxies: McpProxyManager | null = null;

  // --- File-watch service ---
  private fileWatchService: FileWatchService | null = null;

  // --- Debounced config reload ---
  // Live LLM-led editing produces tight save bursts; debouncing the heavy
  // reload (extension reactivate, MCP delta, runner invalidation) coalesces
  // those into a single trailing run after CONFIG_RELOAD_DEBOUNCE_MS of quiet.
  // Document any window change in `manuals/console/configure.md`.
  private configReloadDebounce: DebounceHandle | null = null;
  /** Per-file extension paths that arrived during the current quiet window —
   *  drained when the debounced handler fires so onConfigChanged routes each
   *  path through its capabilities.json/per-ext branch. */
  private pendingExtConfigPaths = new Set<string>();

  /** Get a running extension instance by name (for admin queries). */
  getExtension(name: string): ExtensionInstance | undefined {
    return this.extensions.instances.find(e => e.name === name);
  }

  /** File-watch service handle (MCP tools consume this). */
  getFileWatchService(): FileWatchService | null {
    return this.fileWatchService;
  }

  // --- Sibling agents ---
  private listSiblingAgents: (() => SiblingAgentInfo[]) | undefined;

  // --- Container sweep (best-effort, called from shutdown) ---
  private containerSweep: ((folder: string) => void) | undefined;

  /**
   * sha256 of `secrets/agent.key` captured at construction time. Used by the
   * AGENTS_DIR reconciler to detect rapid-churn rebuilds: if a folder is
   * unlinked and immediately recreated within the debounce window, the
   * snapshot diff sees "folder still here, manager still here" and would
   * leave a stale manager pointed at fresh disk state with a new identity.
   * Comparing this fingerprint against the current on-disk key tells the
   * reconciler when to force a re-register cycle.
   *
   * Empty string if the key file is unreadable at construction (treated as
   * "always mismatch" by the reconciler — safer than crashing init).
   */
  readonly keyFingerprint: string;

  /** Compute the sha256 of an agent's `secrets/agent.key` from disk. Returns
   *  empty string if the file is unreadable. */
  static computeKeyFingerprint(folder: string): string {
    try {
      const buf = fs.readFileSync(agentPath(folder, 'secrets', 'agent.key'));
      return createHash('sha256').update(buf).digest('hex');
    } catch {
      return '';
    }
  }

  constructor(opts: AgentManagerOpts) {
    this.host = opts.host;
    this.folder = opts.host.folder;
    this.agentId = opts.agentId;
    this.keyFingerprint = AgentManager.computeKeyFingerprint(this.folder);
    this.bus = opts.bus;
    this.idp = opts.identityProvider;
    this.logHostEvent = opts.logHostEvent;
    this.watcher = opts.watcher;
    this.store = new AgentStateStore(agentPath(this.folder, 'state'));
    this.agentDb = new AgentDb(agentPath(this.folder, 'state', 'agent.db'));
    this.consoleDb = new ConsoleDb(agentPath(this.folder, 'state', 'console.db'));
    this.mcpDeps = opts.mcpDeps
      ? buildAgentMcpDeps(opts.mcpDeps, {
          agentId: this.agentId,
          folder: this.folder,
          bus: this.bus,
          agentDb: this.agentDb,
          route: (address, senderId, text, routing, rawText, declaredName, attachments, kind, attrs) =>
            this.route(address, senderId, text, routing, rawText, declaredName, attachments, kind, attrs),
          getApprovals: () => this.approvals,
          listSiblingAgents: opts.listSiblingAgents,
          requestConversationEnd: (key, cooldownMs) => this.requestConversationEnd(key, cooldownMs),
          getFileWatchService: () => this.fileWatchService!,
        })
      : undefined;

    this.listSiblingAgents = opts.listSiblingAgents;
    this.containerSweep = opts.containerSweep;
    const logEvent = this.agentDb.logEvent.bind(this.agentDb);
    this.scheduler = new AgentScheduler({
      folder: this.folder,
      agentId: this.agentId,
      store: this.store,
      route: (address, senderId, text, routing) =>
        this.route(address, senderId, text, routing, undefined, undefined, undefined, 'schedule'),
      isDraft: () => this.isDraft,
      onLogEvent: logEvent,
    });
    this.service = new AgentService({
      folder: this.folder,
      onRouteMessage: (channel, text, target) =>
        this.route(
          this.agentId,
          this.agentId,
          text,
          { channel, targetParticipant: target ?? this.agentId },
          undefined,
          undefined,
          undefined,
          'service',
        ),
      onRequestApproval: (data) => {
        const approvalId = this.approvals.createRequest(data);
        logger.info({ agentFolder: this.folder, approvalId, tool: data.tool }, 'Service approval requested');
        return approvalId;
      },
      onApprovalToolResult: (id, result, isError) => {
        const row = this.agentDb.approvals.getApproval(id);
        if (!row) return;
        const prefix = isError ? `Approved tool "${row.tool}" failed` : `Approval granted for "${row.summary}". Result`;
        this.approvals.notifyOutcome(row, `${prefix}:\n${result}`);
      },
      onLogEvent: logEvent,
    });

    // Conversations façade — owns agent traffic. The typed
    // `AgentSpawnContext` flows through `deliver` / `scheduleTtl` so the
    // factory + buildSpawnHooks see fully-typed per-conversation context
    // with no side-channel map.
    conversations.registerScope<AgentSpawnContext>(this.agentScope, {
      factory: this.buildConversationsFactory(),
      buildSpawnHooks: this.buildSpawnHooks,
      store: this.store,
    });

    // Subscribe to the event bus once for this agent's
    // scope and dispatch from one site to host-specific reactions. The
    // alternative (per-Conversation inline `ConversationCallbacks`) gave
    // every host three separate fire sites that diverged independently
    // (Class 4 — hooks not tied to state transitions). One subscription
    // per scope, filtered by `scope`, collapses that fan-out.
    //
    // `subscribeScope` is the typed chokepoint — derives the
    // bus `kinds` filter from which handler fields are populated and
    // narrows views to `ConversationView<AgentSpawnContext>` once at the
    // façade boundary. `runner-removed` is a no-op for agent traffic
    // (snapshot consoles handle their own cleanup) — omitted here so the
    // bus skips dispatch entirely.
    this.conversationEventDispose = conversations.subscribeScope<AgentSpawnContext>(
      this.agentScope,
      {
        onQueued: (view, active) => this.routeQueuedEvent(view, active),
        onExpiryComplete: (view) => this.handleExpiryComplete(view),
      },
    );

    // ConsoleManager owns console-session orchestration. Shares the
    // process-wide `slotPool` (via the Conversations façade) with agent
    // traffic — slot pressure is resolved by catalog swap-eviction, not by
    // gate isolation.
    this.consoleManager = new ConsoleManager({
      host: this.host,
      agentId: this.agentId,
      bus: this.bus,
      store: this.store,
      agentDb: this.agentDb,
      consoleDb: this.consoleDb,
      getTimezone: () => this.effectiveTimezone,
      buildConsoleContext: (consoleName) => this.buildConsoleContext(readAgentConfig(this.folder), consoleName),
      buildConsoleMcpDeps: () => this.buildConsoleMcpDeps(),
      upsertParticipant: (participant) => {
        if (!isSystemSender(participant)) this.agentDb.upsertParticipant(participant);
      },
    });
  }

  /** Build the RunnerFactory for the Conversations façade. The closure
   *  captures `this`, so all dynamic AgentManager state (store, extensions,
   *  mcpProxies, agent config) is read-through at construction time. The
   *  per-conversation `ctx` is delivered as a typed parameter — no
   *  side-channel map. */
  private buildConversationsFactory(): RunnerFactory<AgentSpawnContext> {
    return (rcOpts, ctx) => {
      const previousSessions = ctx.participant
        ? this.store.getPreviousSessions(ctx.channelName, ctx.participant)
        : [];
      const otherChannel = ctx.participant && ctx.channel.show_co_participants !== false
        ? this.getOtherChannelParticipants(ctx.channelName, ctx.participant)
        : { entries: [], more: false };
      const innerOpts = this.buildRunnerOpts({
        address: ctx.address,
        conversationKey: rcOpts.conversationKey,
        channel: ctx.channel,
        channelName: ctx.channelName,
        participant: ctx.participant,
        replyTo: ctx.replyTo,
        qualifier: ctx.qualifier,
        sessionIdOverride: rcOpts.ccSessionId,
        isNewConversation: rcOpts.isNewConversation,
        previousSessions,
        otherChannelParticipants: otherChannel.entries,
        moreChannelParticipants: otherChannel.more,
        declaredName: ctx.declaredName,
      });
      return new ConversationRunner({
        ...innerOpts,
        onIdle: rcOpts.onIdle,
        isExpired: rcOpts.isExpired,
        requestCleanup: rcOpts.requestCleanup,
      });
    };
  }

  /** Other participants who sent inbound messages on this channel within the
   *  past week — ambient awareness surfaced in the conversation context.
   *  Capped; `more` indicates the cap was hit. Names resolved via roster. */
  private getOtherChannelParticipants(
    channelName: string,
    participant: string,
  ): { entries: { name: string; lastActive: string }[]; more: boolean } {
    const CAP = 5;
    const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const rows = this.agentDb.messages.recentOtherInboundParticipants({
      channel: channelName,
      exclude: participant,
      since,
      limit: CAP + 1,
    });
    const roster = readRoster(this.folder);
    // Agent peers aren't in the per-agent roster (a human address book) —
    // resolve them to their alias via the bus-derived sibling list (keyed by
    // canonical address) so they read as e.g. "chief-executive" rather than a
    // raw identity hash.
    const siblingAlias = new Map(
      (this.listSiblingAgents?.() ?? []).map((s) => [s.canonical, s.alias]),
    );
    const entries = rows.slice(0, CAP).map((r) => {
      const id = extractIdentity(r.participant);
      const name = isAgent(r.participant)
        ? siblingAlias.get(id) ?? id
        : roster[id]?.name ?? extractHandle(r.participant) ?? id;
      return { name, lastActive: roughTimeAgo(new Date(r.last_active).getTime()) };
    });
    return { entries, more: rows.length > CAP };
  }

  /** Build the per-spawn hooks for this agent's scope. This is the only
   *  per-conversation function the host supplies — transition observation
   *  moved to the event bus (see the bus subscription set up in the
   *  constructor). A later change collapsed the prior single-field
   *  `ConversationCallbacks` interface to a direct `BuildSpawnHooks`
   *  function type; this method is the bound callable. */
  private buildSpawnHooks: BuildSpawnHooks<AgentSpawnContext> = (conv) =>
    externalBuildSpawnHooks(
      {
        agentId: this.agentId,
        folder: this.folder,
        bus: this.bus,
        agentDb: this.agentDb,
        store: this.store,
        getTimezone: () => this.effectiveTimezone,
        getApprovals: () => this.approvals,
      },
      conv,
    );

  /** Bus-driven reaction: a conversation queued or unqueued on the slot pool.
   *  Translates the typed event into the lifecycle packet the participant's
   *  transport renders as "Waiting…". */
  private routeQueuedEvent(
    view: ConversationView<AgentSpawnContext>,
    active: boolean,
  ): void {
    const participant = view.ctx?.participant;
    const channel = view.ctx?.channelName;
    if (!participant || !channel) return;
    this.bus.routeEvent({
      from: this.agentId,
      to: participant,
      type: 'lifecycle',
      data: { phase: 'queued', active, channel },
    });
  }

  /** Bus-driven reaction: expiry side-effects complete (runner gone, store
   *  marked expired). Mirror the cleanup into agent.db so requests don't
   *  outlive the conversation. */
  private handleExpiryComplete(view: ConversationView<AgentSpawnContext>): void {
    this.store.expireConversation(view.key);
    const participant = view.ctx?.participant;
    const channelName = view.ctx?.channelName;
    if (participant && channelName) {
      this.agentDb.closeAllRequests(channelName, participant);
    }
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /** Single entry point for all per-agent subsystems. */
  async init(): Promise<void> {
    this.initExtensionsAndApprovals();
    await this.initFileWatcherAndExtensions();
    this.initConfigReloadHandlers();
    this.cleanupStaleSockets();
    await this.initMcpProxiesAndSocket();
    this.initIdleTimers();
    this.scheduler.start();
    await this.initFileWatchService();
    this.startBackupTimer();
    this.startPushSweepTimer();
    this.startEgressRefreshTimer();
    await this.service.start().catch((err) => {
      logger.error(
        { agentFolder: this.folder, err },
        'Agent service failed to start (non-fatal)',
      );
    });

    this.agentDb.logEvent('info', 'agent', 'registered', `Agent ${this.folder} registered with host`, {
      context: { agentId: this.agentId },
    });
  }

  /**
   * Build the AgentExtensions container (deliver-bypassing-ACL) and the
   * ApprovalHandler that depends on it. Order matters — approvals consume
   * `this.extensions` to dispatch approved tools.
   */
  private initExtensionsAndApprovals(): void {
    this.extensions = new AgentExtensions(
      this.folder,
      (extName, channel) => (text, opts) => {
        // Stopgap: extension delivery bypasses the bus ingest
        // boundary, so it never reaches `formatParticipantMessage`. Strip the
        // forge-able framework `<cast:*>` family here so a prompt-injected
        // email/webhook body can't smuggle fake framework stimulus into the
        // agent. Full `ext: = zero authority` enforcement lands in Phase 1
        // (carried-origin); this closes the literal-tag injection vector now.
        const sanitized = stripFrameworkTags(text);
        if (sanitized !== text.trim()) {
          this.agentDb.logEvent(
            'warn', 'conversation', 'framework_tag_stripped',
            `Stripped framework tag(s) from ext:${extName} delivery`,
            { context: { ext: extName, channel } },
          );
        }
        return this.route(this.agentId, `ext:${extName}`, sanitized, {
          channel,
          targetParticipant: opts?.replyTo ?? this.agentId,
        });
      },
    );

    this.approvals = new ApprovalHandler({
      agentId: this.agentId,
      folder: this.folder,
      bus: this.bus,
      agentDb: this.agentDb,
      service: this.service,
      extensions: this.extensions,
      idp: this.idp,
      logHostEvent: this.logHostEvent,
      getTimezone: () => this.effectiveTimezone,
      routeOutcome: (row, formatted) => {
        this.route(this.agentId, this.agentId, formatted, {
          channel: row.channel ?? undefined,
          targetParticipant: row.participant,
        });
      },
      // acl-edge resume (2B): on grant, replay the held thing into this agent's
      // conversation; on reject, route the rejection back to the sender. The held
      // carry is one of two kinds — an agent request (HeldInboundRequest) or a
      // first-contact user message (HeldMessage), distinguished structurally by
      // the schema that parses (message requires `msgType`, request requires
      // `requestId` — mutually exclusive). The payload crossed a JSON round-trip
      // + the approval store, so validate.
      deliverHeldRequest: (raw) => {
        // Push-delivery first: its `carry: 'push'` literal disambiguates it from the
        // request/message carries (receiver-side access resume on `io`).
        const push = HeldPushDeliverySchema.safeParse(raw);
        if (push.success) return deliverHeldPush(this.busHandlerDeps(), push.data);
        const req = HeldInboundRequestSchema.safeParse(raw);
        if (req.success) return deliverHeldInboundRequest(this.busHandlerDeps(), req.data);
        const msg = HeldMessageSchema.safeParse(raw);
        if (msg.success) return deliverHeldMessage(this.busHandlerDeps(), msg.data);
        logger.error({ agentId: this.agentId, err: req.error }, 'acl-edge: malformed held carry, cannot deliver');
      },
      rejectHeldRequest: (raw, reason) => {
        const push = HeldPushDeliverySchema.safeParse(raw);
        if (push.success) return rejectHeldPush(this.busHandlerDeps(), push.data, reason);
        const req = HeldInboundRequestSchema.safeParse(raw);
        if (req.success) return rejectHeldInboundRequest(this.busHandlerDeps(), req.data, reason);
        const msg = HeldMessageSchema.safeParse(raw);
        if (msg.success) return rejectHeldMessage(this.busHandlerDeps(), msg.data, reason);
        logger.error({ agentId: this.agentId, err: req.error }, 'acl-edge: malformed held carry, cannot reject');
      },
      // Outbound containment resume (2B.5): on grant, re-emit the held outbound
      // request (the agent now holds q/r to the target); on decline, drop a
      // system notice back into the agent's own conversation (it is its own
      // originator, so there is no remote sender to route a rejection to).
      reEmitHeldRequest: (raw) => {
        const req = HeldOutboundRequestSchema.safeParse(raw);
        if (req.success) return emitOutboundRequest({ agentId: this.agentId, bus: this.bus, agentDb: this.agentDb }, req.data);
        logger.error({ agentId: this.agentId, err: req.error }, 'acl-edge: malformed held outbound carry, cannot re-emit');
      },
      declineHeldRequest: (raw, reason) => {
        const req = HeldOutboundRequestSchema.safeParse(raw);
        if (!req.success) {
          logger.error({ agentId: this.agentId, err: req.error }, 'acl-edge: malformed held outbound carry, cannot decline');
          return;
        }
        const held = req.data;
        const formatted = systemUndelivered(
          `Your ${held.kind} to ${held.target} was declined by the owner${reason ? `: ${reason}` : '.'}`,
          held.text,
          this.effectiveTimezone,
        );
        // kind 'system': framework correction, not participant speech — gets the
        // <cast:system> wrapper on delivery and `sender: 'system'` in message_log.
        this.route(this.agentId, this.agentId, formatted, {
          channel: held.returnToChannel,
          targetParticipant: held.returnToParticipant,
        }, undefined, undefined, undefined, 'system');
      },
      // Push containment resume: on grant, re-emit the held cross-agent
      // push (the agent now holds `p` to the target); on decline, drop a system
      // notice back into the sender's own cell (the conversation it was serving when
      // it tried to push). Mirrors the q/r reEmit/decline pair above.
      reEmitHeldPush: (raw) => {
        const push = HeldPushSchema.safeParse(raw);
        if (push.success) return emitPush({ agentId: this.agentId, bus: this.bus, agentDb: this.agentDb }, push.data);
        logger.error({ agentId: this.agentId, err: push.error }, 'acl-edge: malformed held push carry, cannot re-emit');
      },
      declineHeldPush: (raw, reason) => {
        const push = HeldPushSchema.safeParse(raw);
        if (!push.success) {
          logger.error({ agentId: this.agentId, err: push.error }, 'acl-edge: malformed held push carry, cannot decline');
          return;
        }
        const held = push.data;
        const formatted = systemUndelivered(
          `Your push to ${held.target} was declined by the owner${reason ? `: ${reason}` : '.'}`,
          held.text,
          this.effectiveTimezone,
        );
        // kind 'system': framework correction, not participant speech — gets the
        // <cast:system> wrapper on delivery and `sender: 'system'` in message_log.
        this.route(this.agentId, this.agentId, formatted, {
          channel: held.callerChannel ?? '',
          targetParticipant: held.participant,
        }, undefined, undefined, undefined, 'system');
      },
      // User↔user push resume: on the pushee's consent, replay the held
      // intra-agent push into their conversation; on decline/lapse, echo a rejection
      // back into the pusher's own cell. Both drive the shared local-push helpers.
      deliverHeldUserPush: (raw) => {
        const push = HeldLocalPushSchema.safeParse(raw);
        if (push.success) return emitLocalPush(this.localPushDeps(), push.data);
        logger.error({ agentId: this.agentId, err: push.error }, 'user-push: malformed held carry, cannot deliver');
      },
      declineHeldUserPush: (raw, reason) => {
        const push = HeldLocalPushSchema.safeParse(raw);
        if (push.success) return declineLocalPush(this.localPushDeps(), push.data, reason);
        logger.error({ agentId: this.agentId, err: push.error }, 'user-push: malformed held carry, cannot decline');
      },
    });
  }

  /** The minimal context the intra-agent push helpers (`emitLocalPush` /
   *  `declineLocalPush`) need — used by the 2B.3 user-push approval resume, which
   *  fires outside any single conversation's deps. */
  private localPushDeps(): Parameters<typeof emitLocalPush>[0] {
    return {
      agentId: this.agentId,
      agentDb: this.agentDb,
      route: (address, senderId, text, routing, rawText, declaredName, attachments, kind, attrs) =>
        this.route(address, senderId, text, routing, rawText, declaredName, attachments, kind, attrs),
    };
  }

  /**
   * Set up the per-agent directory watches and activate registered extensions.
   * The agent-root watch at depth 0 is what makes `manifest.json` visible to
   * config readers (admin UI draft-pill, buildConsoleContext). Awaited so
   * `readCapabilities()` sees a warm cache when activate() runs.
   */
  private async initFileWatcherAndExtensions(): Promise<void> {
    await Promise.all([
      this.watcher.watch({ path: agentPath(this.folder), depth: 0 }),
      this.watcher.watch({ path: agentPath(this.folder, 'config', 'ext'), depth: 2 }),
      this.watcher.watch({ path: agentPath(this.folder, 'blueprint', 'props'), depth: 0 }),
      this.watcher.watch({ path: agentPath(this.folder, 'blueprint', 'channels'), depth: 1 }),
      this.watcher.watch({ path: agentPath(this.folder, 'blueprint', 'identity'), depth: 0 }),
      this.watcher.watch({ path: agentPath(this.folder, 'config'), depth: 0 }),
    ]);

    this.extensions.activate();
  }

  /** Wire up debounced config-reload triggers driven by the file watcher. */
  private initConfigReloadHandlers(): void {
    this.configReloadDebounce = createDebounced(
      () => this.runConfigReload(),
      CONFIG_RELOAD_DEBOUNCE_MS,
    );

    this.watcher.onChange(agentPath(this.folder, 'config', 'ext'), (filePath) => {
      this.pendingExtConfigPaths.add(filePath);
      this.configReloadDebounce?.schedule();
    });
    this.watcher.onChange(agentPath(this.folder, 'blueprint', 'props'), (filePath) => {
      // schedule.txt is hot-reloaded by the scheduler in-place — not a runner
      // spawn input, so no invalidation needed.
      if (filePath.endsWith('schedule.txt')) {
        this.scheduler.onScheduleChanged();
        return;
      }
      if (filePath.endsWith('capabilities.json')) {
        this.pendingExtConfigPaths.add(filePath);
      }
      this.configReloadDebounce?.schedule();
    });
    this.watcher.onChange(agentPath(this.folder, 'blueprint', 'channels'), () => {
      this.configReloadDebounce?.schedule();
    });
    this.watcher.onChange(agentPath(this.folder, 'blueprint', 'identity'), () => {
      this.configReloadDebounce?.schedule();
    });
    // config/ — agent.json (timezone, networking), provisions.json (resource
    // bindings), mcp-servers.json (operator MCP env). Filter by basename so
    // unrelated subdirectory churn (e.g. config/ext/*, handled separately) is
    // skipped.
    this.watcher.onChange(agentPath(this.folder, 'config'), (filePath) => {
      const name = path.basename(filePath);
      if (name !== 'agent.json' && name !== 'provisions.json' && name !== 'mcp-servers.json') {
        return;
      }
      this.configReloadDebounce?.schedule();
    });
    // manifest.json sits at the agent root (watched at depth 0). The agent's
    // `description` is denormalized into bus metadata at registration; refresh
    // the live copy on external edits (host-side, manual) so the admin UI, peer
    // lists, and AgentSummary reflect changes without a restart. The in-band
    // Design tool pushes directly too — updateMetadata's value-changed guard
    // dedupes the resulting double-fire. Scoped to `description`: name/alias is
    // identity-bearing and stays on the add/remove/key-rotation path.
    this.watcher.onChange(agentPath(this.folder), (filePath) => {
      if (path.basename(filePath) !== 'manifest.json') return;
      const parsed = AgentManifestSchema.safeParse(readJson(agentPath(this.folder, 'manifest.json')));
      if (!parsed.success) return;
      this.bus.updateMetadata(this.agentId, { description: parsed.data.description }, 'description-changed');
    });
  }

  /** Start external MCP proxies before the cast socket so their tools
   *  are discoverable when the container scans `/mcp/*.sock`. */
  private async initMcpProxiesAndSocket(): Promise<void> {
    const mcpServers = resolveMcpServers(this.folder);
    if (mcpServers.length > 0) {
      this.mcpProxies = new McpProxyManager(this.folder);
      await this.mcpProxies.startAll(mcpServers);
    }
    this.startMcpSocket();
  }

  private async initFileWatchService(): Promise<void> {
    this.fileWatchService = new FileWatchService({
      folder: this.folder,
      host: this.host,
      agentId: this.agentId,
      route: (address, senderId, text, routing, rawText, declaredName, attachments, kind, attrs) =>
        this.route(address, senderId, text, routing, rawText, declaredName, attachments, kind, attrs),
      onLogEvent: this.agentDb.logEvent.bind(this.agentDb),
    });
    await this.fileWatchService.start();
  }

  private getDisabledTools(): string[] {
    return resolveCapabilities(this.folder).disabledTools;
  }

  // =========================================================================
  // BusHandler implementation
  // =========================================================================

  async handleMessage(
    from: string,
    to: string,
    payload: unknown,
  ): Promise<void> {
    return handleBusMessage(this.busHandlerDeps(), from, to, payload);
  }

  async handleEvent(_evt: Evt): Promise<void> {}

  /**
   * Cross-agent ACL projection for a single identity. Returns null when the
   * identity lacks the inspect bit on this agent. Mirrors the per-entity
   * loop body previously inlined in `WebTransport.buildAgentsPayload` —
   * the byte-for-byte stability of the returned shape against a captured
   * baseline packet is the contract this method must preserve.
   *
   * Called via the optional `BusHandler.projectForIdentity` hook from
   * `Bus.listAccessibleAgents` — keeps ACL/policy out of `WebTransport`.
   */
  projectForIdentity(identityId: string): AgentSummary | null {
    const acl = checkAcl(this.bus, this.folder, identityId);
    if (!hasBit(acl.bits, 'i')) return null;

    const peerChannels = getPeerChannels(this.bus, this.folder, identityId) ?? [];
    const wildcard = peerChannels.find((ch) => ch.name === '*');
    const configuredChannels = Object.keys(loadChannelsConfig(this.folder));

    const channels = wildcard
      ? configuredChannels.map((name) => ({ name, bits: wildcard.bits }))
      : peerChannels.filter((ch) => configuredChannels.includes(ch.name));

    const meta = this.bus.getMetadata(this.agentId);
    const summary: AgentSummary = {
      alias: meta?.label ?? this.agentId,
      address: this.agentId,
      channels,
    };
    if (meta?.description !== undefined) summary.description = meta.description;
    return summary;
  }

  /**
   * Per-identity ACL gate for outbound events originating from this agent.
   * Sibling to `projectForIdentity`, same handler-hook pattern. Returns
   * `null` when the identity lacks the `i` bit on the event's channel.
   *
   * The event's own `data.channel` drives both the wire-frame channel and
   * the ACL check, so a peer with `i` on `default` but not on `archive`
   * doesn't receive typing events from the `archive` channel. The
   * `approval_stale` variant has no channel field; the approval flow lives
   * on `default`, so default it is.
   *
   * Called via `BusHandler.projectEventForIdentity` from
   * `Bus.projectEventForIdentity` — keeps event-delivery ACL out of
   * `WebTransport`.
   */
  projectEventForIdentity(evt: Evt, identityId: string): EventDeliveryDecision | null {
    const channel: string = evt.type === 'approval_stale' ? 'default' : evt.data.channel;
    const acl = checkAcl(this.bus, this.folder, identityId, channel);
    if (!hasBit(acl.bits, 'i')) return null;
    const meta = this.bus.getMetadata(this.agentId);
    return { alias: meta?.label ?? this.agentId, channel };
  }

  private busHandlerDeps(): BusHandlerDeps {
    return {
      agentId: this.agentId,
      folder: this.folder,
      bus: this.bus,
      agentDb: this.agentDb,
      idp: this.idp,
      getApprovals: () => this.approvals,
      getTimezone: () => this.effectiveTimezone,
      isDraft: () => this.isDraft,
      route: (address, senderId, text, routing, rawText, declaredName, attachments, kind, attrs) =>
        this.route(address, senderId, text, routing, rawText, declaredName, attachments, kind, attrs),
    };
  }

  // =========================================================================
  // Routing
  // =========================================================================

  private routeDeps(): AgentRouteDeps {
    return {
      agentId: this.agentId,
      folder: this.folder,
      host: this.host,
      bus: this.bus,
      profileName: this.profileName,
      agentDb: this.agentDb,
      store: this.store,
      consoleManager: this.consoleManager,
      isShuttingDown: () => slotPool.shuttingDown,
      conversations,
      agentScope: this.agentScope,
      setIdleTimer: (key, ctx, remainingMs) =>
        this.setIdleTimer(key, ctx, remainingMs),
    };
  }

  route(
    address: string,
    senderId: string,
    text: string,
    routing?: Routing,
    rawText?: string,
    declaredName?: string,
    attachments?: Attachment[],
    kind?: DeliverKind,
    attrs?: Record<string, string>,
  ): Promise<RouteResult> {
    return externalRouteMessage(
      this.routeDeps(),
      address,
      senderId,
      text,
      routing,
      rawText,
      declaredName,
      attachments,
      kind,
      attrs,
    );
  }

  closeConversation(
    address: string,
    routing?: Routing,
  ): void {
    closeConversationByAddress(this.routeDeps(), address, routing);
  }

  // =========================================================================
  // MCP socket
  // =========================================================================

  startMcpSocket(): void {
    if (this.mcpCloser || !this.mcpDeps) return;
    const socketPath = castSocketPath(this.folder);
    const handle = startMcpSocketServer(
      socketPath,
      {
        agentFolder: this.folder,
        agentId: this.agentId,
        participant: null,
        channelName: null,
        store: this.store,
        agentDb: this.agentDb,
        messageLog: this.agentDb.messages,
        activeExtensions: this.extensions.instances,
        timezone: this.effectiveTimezone,
        pipConfig: resolveCapabilities(this.folder).pip,
      },
      this.mcpDeps,
    );
    handle.ready.catch((err) => {
      logger.error(
        { agentFolder: this.folder, err },
        'MCP socket server failed to start',
      );
      this.mcpCloser = null;
    });
    this.mcpCloser = handle;
  }

  closeMcpSocket(): void {
    if (this.mcpCloser) {
      this.mcpCloser.close();
      this.mcpCloser = null;
    }
  }

  // =========================================================================
  // Introspection
  // =========================================================================

  getActiveProcesses(): ChildProcess[] {
    const procs: ChildProcess[] = [];
    const svcProc = this.service.process;
    if (svcProc) procs.push(svcProc);
    for (const view of conversations.inScope(this.agentScope)) {
      if (view.activeProcess) procs.push(view.activeProcess);
    }
    return procs;
  }

  /** Running agent containers for this agent, by name — the targets for live
   *  egress reconciles (see egress-controller.ts). The service process has no
   *  container, so it's excluded; only conversation runners carry a name. */
  getActiveContainers(): { containerName: string; folder: string }[] {
    const out: { containerName: string; folder: string }[] = [];
    for (const view of conversations.inScope(this.agentScope)) {
      if (view.activeContainerName) out.push({ containerName: view.activeContainerName, folder: this.folder });
    }
    return out;
  }

  get currentActiveCount(): number {
    let count = 0;
    for (const view of conversations.inScope(this.agentScope)) {
      if (view.activeProcess !== null) count++;
    }
    return count;
  }

  // =========================================================================
  // Idle-timeout timers — delegate to Conversations façade.
  // =========================================================================

  /** Schedule (or reset) the idle-timeout timer for a conversation. Called
   *  by `agent-route` on user-initiated messages. `scheduleTtl` auto-
   *  materializes the conversation if absent (boot-time restoration arrives
   *  this way too — no separate ensureConversation step needed). */
  setIdleTimer(
    conversationKey: string,
    ctx: AgentSpawnContext,
    remainingMs?: number,
  ): void {
    if (ctx.channel.idle_timeout === null) return;
    const meta: ConvIdleTimeoutMeta = {
      conversationKey,
      channelName: ctx.channelName,
      cleanup: this.composeCleanupMessage(ctx.channel.cleanup, ctx.channel.cleanupEnabled),
      cleanupEnabled: ctx.channel.cleanupEnabled,
      participant: ctx.participant,
      idle_timeout: ctx.channel.idle_timeout,
      manualEnd: false,
    };
    conversations.scheduleTtl<AgentSpawnContext>(
      this.agentScope,
      conversationKey,
      meta,
      remainingMs ?? ctx.channel.idle_timeout,
      ctx,
    );
  }

  /** Compose the cleanup turn's user message: profile prelude + channel tail.
   *  TTL fires `conv.expire(meta.cleanup ?? null)` — passing `undefined` here
   *  hard-expires without a cleanup turn. */
  private composeCleanupMessage(channelCleanup: string | undefined, cleanupEnabled: boolean): string | undefined {
    if (!cleanupEnabled) return undefined;
    const profile = getProfile(this.profileName);
    const parts = [profile.cleanup, channelCleanup].filter(Boolean);
    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }

  /** Agent-requested conversation end. Shortens the idle timeout to a cooldown period. */
  requestConversationEnd(
    conversationKey: string,
    cooldownMs?: number,
  ): { accepted: boolean; cooldownSeconds: number; reason?: string } {
    const view = conversations.get<AgentSpawnContext>(this.agentScope, conversationKey);
    if (view === undefined) {
      return { accepted: false, cooldownSeconds: 0, reason: 'No active conversation.' };
    }
    // J.4a — semantic predicate centralizes the "can this conversation be
    // ended right now?" decision (was scattered with `view.isExpired`
    // checks here and in `console/tools.ts`).
    const endable = view.canEndManually();
    if (!endable.ok) {
      return { accepted: false, cooldownSeconds: 0, reason: endable.reason };
    }

    const ctx = view.ctx;
    const channelName = ctx?.channelName ?? DEFAULT_CHANNEL_NAME;
    const channelConfig = loadChannelsConfig(this.host.folder);
    const channel = channelConfig[channelName];
    if (!channel || channel.idle_timeout === null) {
      return { accepted: false, cooldownSeconds: 0, reason: 'Single-shot conversations end automatically.' };
    }

    const DEFAULT_COOLDOWN = 300_000;
    const MIN_COOLDOWN = 60_000;
    const requested = cooldownMs ?? DEFAULT_COOLDOWN;
    const clamped = Math.max(MIN_COOLDOWN, Math.min(requested, channel.idle_timeout));

    const meta: ConvIdleTimeoutMeta = {
      conversationKey,
      channelName,
      cleanup: this.composeCleanupMessage(channel.cleanup, channel.cleanupEnabled),
      cleanupEnabled: channel.cleanupEnabled,
      participant: ctx?.participant,
      idle_timeout: channel.idle_timeout,
      manualEnd: true,
    };
    conversations.scheduleTtl<AgentSpawnContext>(
      this.agentScope,
      conversationKey,
      meta,
      clamped,
      ctx,
    );

    logger.info(
      { agentFolder: this.folder, conversationKey, cooldownMs: clamped },
      'Agent requested conversation end',
    );
    return { accepted: true, cooldownSeconds: Math.round(clamped / 1000) };
  }

  /**
   * Crash recovery: restore idle-timeout timers for active conversations from
   * the state store. Called once after construction during startup. For each
   * row with a non-null ttl: either mark expired immediately (offline expiry)
   * or materialize the conversation in the catalog (with restored ctx) and
   * schedule the timer.
   */
  initIdleTimers(): void {
    const convs = this.store.getActiveConversations();
    const channels = loadChannelsConfig(this.folder);

    for (const conv of convs) {
      if (conv.ttl === null) continue;

      const elapsed = Date.now() - new Date(conv.lastActive).getTime();
      const remaining = conv.ttl - elapsed;

      const ch =
        channels[conv.channelName] ??
        channels[DEFAULT_CHANNEL_NAME] ??
        DEFAULT_CHANNEL;

      if (remaining <= 0) {
        // Expired while server was offline — mark expired without spawning
        // a cleanup container (the conversation is stale, nothing to summarize).
        this.store.expireConversation(conv.conversationKey);
        if (conv.participant && conv.channelName) {
          this.agentDb.closeAllRequests(conv.channelName, conv.participant);
        }
        continue;
      }

      const ctx: AgentSpawnContext = {
        address: this.agentId,
        channel: ch,
        channelName: conv.channelName,
        // conversations.jsonl is a file boundary — re-validate on read; an
        // invalid stored participant degrades to a system-context cleanup.
        participant: conv.participant && isParticipantAddress(conv.participant) ? conv.participant : undefined,
        replyTo: undefined,
        qualifier: undefined,
        declaredName: undefined,
        isSingleShot: false,
      };
      this.setIdleTimer(conv.conversationKey, ctx, remaining);
    }

    const restoredCount = convs.filter((c) => c.ttl !== null && (c.ttl - (Date.now() - new Date(c.lastActive).getTime())) > 0).length;
    if (restoredCount > 0) {
      logger.info(
        { agentFolder: this.folder, count: restoredCount },
        'Restored idle-timeout timers from state store',
      );
    }
  }

  // =========================================================================
  // Stale socket cleanup
  // =========================================================================

  private cleanupStaleSockets(): void {
    const socketDir = agentPath(this.folder, 'mcp', 'socket');
    try {
      if (!fs.existsSync(socketDir)) return;
      let cleaned = 0;
      for (const file of fs.readdirSync(socketDir)) {
        if (file.endsWith('.sock')) {
          fs.unlinkSync(path.join(socketDir, file));
          cleaned++;
        }
      }
      if (cleaned > 0) {
        logger.info(
          { agentFolder: this.folder, cleaned },
          'Cleaned up stale session MCP sockets',
        );
      }
    } catch {
      /* socket dir may not exist */
    }
  }

  // =========================================================================
  // Shutdown
  // =========================================================================

  /**
   * Drain active conversation runners with a graceful-then-SIGKILL pattern.
   * Iterates `conversations.inScope`, captures live container processes,
   * triggers `unregisterScope` (which calls close + destroy on each
   * Conversation via Conversation.shutdown), and SIGKILLs any straggler
   * processes that didn't exit within the timeout.
   *
   * Mirrors AgentService.stop's pattern (agent-service.ts:208-237). Important
   * for forced removal (e.g. agent folder yanked) — without explicit draining,
   * runners only auto-close on idle timeout, which is unbounded.
   */
  private async drainRunners(timeoutMs = 5000): Promise<void> {
    const isAlive = (p: ChildProcess): boolean => p.exitCode == null && p.signalCode == null;

    // Capture all active processes BEFORE shutdown so we can SIGKILL stragglers.
    const procs: ChildProcess[] = [];
    for (const view of conversations.inScope(this.agentScope)) {
      const proc = view.activeProcess;
      if (proc && isAlive(proc)) procs.push(proc);
    }
    if (procs.length === 0) {
      // Even with no live processes, unregister the scope so the catalog
      // releases any awaiting-slot tokens and clears per-conv state.
      await conversations.unregisterScope(this.agentScope);
      return;
    }

    // Kick off graceful shutdown — Conversation.shutdown calls runner.close()
    // and awaits runner.destroy() (SIGTERM).
    const shutdownPromise = conversations.unregisterScope(this.agentScope);

    // Race against the timeout: if any procs are still alive after timeoutMs,
    // send SIGKILL. unregisterScope continues to settle in the background.
    await Promise.race([
      shutdownPromise.catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);

    const stragglers = procs.filter(isAlive);
    if (stragglers.length > 0) {
      logger.warn(
        { agentFolder: this.folder, stragglers: stragglers.length },
        'Runners did not exit in drain window — sending SIGKILL',
      );
      for (const proc of stragglers) {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }
    }

    // Make sure unregisterScope completes (typically already settled).
    await shutdownPromise.catch(() => {});
  }

  async shutdown(): Promise<void> {
    this.extensions.stopAll();

    this.scheduler.stop();

    // Mark pending approvals + open cross-agent requests as 'interrupted' so
    // post-restart audit trails don't show perpetual-pending rows. Done BEFORE
    // drain so the runners can't race back in to resolve them.
    try {
      const approvals = this.agentDb.approvals.markPendingApprovalsInterrupted();
      const requests = this.agentDb.markOpenRequestsInterrupted();
      if (approvals > 0 || requests.inbound > 0 || requests.outbound > 0) {
        logger.info(
          { folder: this.folder, approvals, requestsInbound: requests.inbound, requestsOutbound: requests.outbound },
          'Marked in-flight approvals/requests interrupted',
        );
      }
    } catch (err) {
      logger.warn({ folder: this.folder, err }, 'Failed to mark in-flight approvals/requests interrupted');
    }

    // Drain active conversation runners before the rest of the teardown so
    // containers exit cleanly even when the agent folder is being yanked.
    // Without this, runners only auto-close on idle timeout (unbounded).
    await this.drainRunners();

    // Sweep any container processes that didn't get cleaned up by drainRunners'
    // SIGKILL — `--rm` doesn't always fire if the child Node was killed mid-
    // cleanup. Symmetric with the unregister path; without it, server shutdown
    // can leave Apple Container stragglers that the next boot has to reap.
    try {
      this.containerSweep?.(this.folder);
    } catch (err) {
      logger.debug({ folder: this.folder, err }, 'Container sweep on shutdown failed (non-fatal)');
    }

    if (this.fileWatchService) {
      await this.fileWatchService.shutdown();
      this.fileWatchService = null;
    }

    // Release per-agent watcher directories
    this.watcher.unwatch(agentPath(this.folder));
    this.watcher.unwatch(agentPath(this.folder, 'config', 'ext'));
    this.watcher.unwatch(agentPath(this.folder, 'blueprint', 'props'));
    this.watcher.unwatch(agentPath(this.folder, 'blueprint', 'channels'));
    this.watcher.unwatch(agentPath(this.folder, 'blueprint', 'identity'));
    this.watcher.unwatch(agentPath(this.folder, 'config'));

    this.stopBackupTimer();
    this.stopPushSweepTimer();
    this.stopEgressRefreshTimer();
    this.configReloadDebounce?.cancel();
    this.configReloadDebounce = null;

    // Drop the event-bus subscription registered in the constructor. Safe to
    // run unconditionally — the disposer is idempotent.
    this.conversationEventDispose?.();
    this.conversationEventDispose = null;

    // Note: drainRunners already called conversations.unregisterScope above,
    // which iterates this agent's Conversations and calls Conversation.shutdown
    // on each. Per-conversation ctx is held on the Conversation itself and is
    // discarded when the Conversation transitions to 'destroyed' — no separate
    // map to clear.

    await this.consoleManager.shutdown();

    await this.service.stop().catch((err) => logger.debug({ err, agentFolder: this.folder }, 'service stop error during shutdown'));
    if (this.mcpProxies) {
      await this.mcpProxies.stopAll();
      this.mcpProxies = null;
    }
    this.closeMcpSocket();
    this.agentDb.close();
    this.consoleDb.close();
  }

  /** Lifecycle status of this agent's service process (for the admin UI). */
  get serviceStatus() {
    return this.service.status;
  }

  /** Restart the agent service process (bypasses crash-recovery backoff). */
  async restartService(): Promise<void> {
    await this.service.restart();
  }

  /** Start a 60s poll that checks whether a backup is due. */
  private startBackupTimer(): void {
    const cfg = this.backupConfig;
    this.lastBackupConfigJson = JSON.stringify(cfg ?? null);
    if (!cfg) return;

    const { retain, hour } = cfg;
    const BACKUP_POLL_INTERVAL = 60_000;

    const tick = () => {
      try {
        snapshotAgent(this.folder, retain, hour, this.agentDb.logEvent.bind(this.agentDb));
      } catch (err) {
        logger.error(
          { agentFolder: this.folder, err },
          'Backup snapshot failed',
        );
        this.agentDb.logEvent('error', 'backup', 'snapshot_failed', `Backup tick threw: ${String(err)}`, {
          context: { error: String(err) },
        });
      }
    };

    // Check immediately on startup, then every 60s
    tick();
    this.backupTimer = setInterval(tick, BACKUP_POLL_INTERVAL);
    this.backupTimer.unref();
    logger.info(
      { agentFolder: this.folder, hour, retain },
      'Backup poll started',
    );
  }

  private stopBackupTimer(): void {
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
  }

  /** Periodic sweep of stale outbound_pushes rows (no positive-ack terminal,
   *  TTL is the only cleanup mechanism). Per-agent, `.unref()`'d so it never
   *  holds the process open by itself. */
  private startPushSweepTimer(): void {
    const sweep = (): void => {
      try {
        // SQLite stores `created_at` via `DEFAULT (datetime('now'))` — format
        // is `YYYY-MM-DD HH:MM:SS` (space separator, no `T`/`Z`). A JS
        // `toISOString()` cutoff would string-compare incorrectly because
        // `' '` < `'T'`, so every row would match `created_at < cutoff` and
        // get wiped on the first sweep. Match SQLite's format.
        const cutoff = new Date(Date.now() - PUSH_ROW_TTL_MS)
          .toISOString().slice(0, 19).replace('T', ' ');
        const removed = this.agentDb.purgeExpiredOutboundPushes(cutoff);
        if (removed > 0) {
          logger.debug(
            { agentFolder: this.folder, removed },
            'Purged stale outbound_pushes rows',
          );
        }
      } catch (err) {
        logger.warn({ agentFolder: this.folder, err }, 'outbound_pushes sweep failed');
      }
    };
    this.pushSweepTimer = setInterval(sweep, PUSH_ROW_SWEEP_MS);
    this.pushSweepTimer.unref();
  }

  private stopPushSweepTimer(): void {
    if (this.pushSweepTimer) {
      clearInterval(this.pushSweepTimer);
      this.pushSweepTimer = null;
    }
  }

  /** Re-resolve the allowlist and reconcile every running container's egress
   *  pins. Shared by the periodic timer and the config hot-reload. A no-op when
   *  no containers are live or the resolved set is unchanged. */
  private async reconcileEgress(): Promise<void> {
    const containers = this.getActiveContainers();
    if (containers.length === 0) return;
    await this.egress.reconcileMany(containers, (folder) => {
      const cfg = readAgentConfig(folder);
      // Undefined containerNetwork means the entrypoint's default (sdk-only).
      return { allowedEndpoints: cfg.containerAllowedEndpoints, network: cfg.containerNetwork ?? 'sdk-only' };
    });
  }

  /** Start the periodic egress-pin refresh. Fires once immediately so a host
   *  restart realigns surviving containers (idempotent reconcile), then ticks
   *  on EGRESS_REFRESH_MS. `unref` so it never holds the process open. */
  private startEgressRefreshTimer(): void {
    const tick = (): void => {
      this.reconcileEgress().catch((err) =>
        logger.warn({ agentFolder: this.folder, err }, 'egress refresh tick failed'),
      );
    };
    tick();
    this.egressTimer = setInterval(tick, EGRESS_REFRESH_MS);
    this.egressTimer.unref();
  }

  private stopEgressRefreshTimer(): void {
    if (this.egressTimer) {
      clearInterval(this.egressTimer);
      this.egressTimer = null;
    }
  }

  /** Re-arm the backup poll if `config/agent.json::backup` changed since last
   *  arm. No-op when the config is stable, so it's safe to call from every
   *  debounced config-reload tick. */
  private maybeRestartBackupTimer(): void {
    const current = JSON.stringify(this.backupConfig ?? null);
    if (current === this.lastBackupConfigJson) return;
    this.stopBackupTimer();
    this.startBackupTimer();
  }

  /** Heavy reload handler invoked by `configReloadDebounce` after the quiet
   *  window. Drains pending extension paths (capabilities.json or per-ext
   *  config) so each path's branch in `extensions.onConfigChanged` runs once,
   *  re-arms the backup timer if its config changed, applies the MCP proxy
   *  delta if mcp_servers changed, and invalidates all runners so the next
   *  spawn picks up the fresh disk state. */
  private async runConfigReload(): Promise<void> {
    const paths = [...this.pendingExtConfigPaths];
    this.pendingExtConfigPaths.clear();
    // Service secrets + settings are not an extension — route before the
    // extension dispatch so the registry doesn't log a spurious reload for
    // the unregistered name `service`. Both files share the restart-as-reload
    // semantic (svc.secrets / svc.settings are startup snapshots).
    const serviceFiles = new Set([
      agentPath(this.folder, 'config', 'ext', 'service', 'secrets.json'),
      agentPath(this.folder, 'config', 'ext', 'service', 'config.json'),
    ]);
    const changedServiceFiles: string[] = [];
    for (const p of paths) {
      if (serviceFiles.has(p)) {
        changedServiceFiles.push(p);
        continue;
      }
      this.extensions.onConfigChanged(p);
    }
    if (changedServiceFiles.length > 0) this.restartServiceForConfigChange(changedServiceFiles);
    this.maybeRestartBackupTimer();
    await this.applyMcpDelta();
    conversations.invalidateScope(this.agentScope);
    // Live-update running containers' egress pins (invalidateScope only affects
    // the *next* spawn; an allowlist edit should reach in-flight containers too).
    await this.reconcileEgress();
  }

  /** Restart the service process so its startup snapshots re-read
   *  config/ext/service/{secrets.json, config.json}. Mirrors extension
   *  re-activation — secrets/settings feed derived state (sessions,
   *  connections), so re-running startup IS the reload semantic;
   *  agent-service-base deliberately has no hot path. One mechanism covers
   *  every writer: the admin router and hand edits both land here through
   *  the watcher. Parse-guarded like the registry's capabilities.json guard:
   *  if ANY changed file is invalid JSON, the restart is skipped so a
   *  mid-edit save doesn't bounce the service into an empty snapshot; a
   *  *missing* file is a legitimate wipe and restarts. restart() also resets
   *  the RestartBreaker, so fixing bad credentials recovers a service that
   *  crash-looped into `failed` without a manual kick. */
  private restartServiceForConfigChange(changedFiles: string[]): void {
    for (const filePath of changedFiles) {
      const raw = readText(filePath);
      if (raw !== null && raw.trim().length > 0) {
        try {
          JSON.parse(raw);
        } catch {
          logger.warn(
            { agentFolder: this.folder, filePath },
            'Service config/secrets file changed but failed to parse — skipping service restart',
          );
          return;
        }
      }
    }
    this.agentDb.logEvent('info', 'service', 'restarted', 'Service secrets/settings changed — restarting service');
    this.service.restart().catch((err) => {
      logger.error({ agentFolder: this.folder, err }, 'Service restart after config change failed');
      this.agentDb.logEvent('error', 'service', 'restart_failed', `Service restart after config change failed: ${String(err)}`);
    });
  }

  /** Resolve the current MCP server list and reconcile the host proxy fleet.
   *  Lazy-creates `mcpProxies` only when transitioning from empty → non-empty,
   *  so agents that never use MCP don't pay any startup cost. The applyDelta
   *  return value gates an admin UI lifecycle event so silent-success cases
   *  don't surface as a banner. */
  private async applyMcpDelta(): Promise<void> {
    const servers = resolveMcpServers(this.folder);
    if (!this.mcpProxies && servers.length === 0) return;
    if (!this.mcpProxies) {
      this.mcpProxies = new McpProxyManager(this.folder);
    }
    const result = await this.mcpProxies.applyDelta(servers);
    if (result.type === 'changed') {
      this.bus.update(this.agentId, 'mcp-changed');
    }
  }

  // =========================================================================
  // Private helpers (runner lifecycle)
  // =========================================================================

  /** Shared builder for ConversationRunnerOpts — used by both route() and cleanup runner creation. */
  private consoleBuilderDeps(): ConsoleBuilderDeps {
    return {
      folder: this.folder,
      agentId: this.agentId,
      bus: this.bus,
      agentDb: this.agentDb,
      service: this.service,
      agentScope: this.agentScope,
      mcpDeps: this.mcpDeps,
      getTimezone: () => this.effectiveTimezone,
    };
  }

  private buildConsoleMcpDeps(): ConsoleMcpDeps {
    return externalBuildConsoleMcpDeps(this.consoleBuilderDeps(), () => readAgentConfig(this.folder));
  }

  private buildConsoleContext(agentConfig: AgentConfig, consoleName?: ConsoleName): ConsoleContext {
    return externalBuildConsoleContext(this.consoleBuilderDeps(), agentConfig, consoleName);
  }

  private buildRunnerOpts(params: {
    address: string;
    conversationKey: string;
    channel: AgentChannel;
    channelName: string;
    participant?: IdentityId;
    replyTo?: IdentityId;
    qualifier?: string;
    sessionIdOverride?: string;
    isNewConversation?: boolean;
    previousSessions?: { lastActive: string; summary: string | null }[];
    otherChannelParticipants?: { name: string; lastActive: string }[];
    moreChannelParticipants?: boolean;
    declaredName?: string;
  }): Omit<ConversationRunnerOpts, 'onIdle' | 'isExpired' | 'requestCleanup'> {
    const agentConfig = readAgentConfig(this.host.folder);

    const resolved = resolveCapabilities(this.host.folder);
    const disabledTools = resolved.disabledTools;
    const promptParticipant = params.replyTo || params.participant || '';
    const resourceEntries = Object.entries(resolved.resources);
    // Pre-compute the channel contract for the addressee so prompt-assembly
    // can render the wire-contract layer without itself depending on `bus` or
    // `checkAcl`. Hot-reload of acl.json takes effect on the next spawn —
    // assembly happens once per spawn so no extra cache plumbing is needed.
    const addresseeBits = promptParticipant
      ? checkAcl(this.bus, this.host.folder, promptParticipant, params.channelName).bits
      : '';
    const channelContract = promptParticipant
      ? deriveChannelContract(addresseeBits)
      : undefined;
    // Layer-6 self-knowledge: the agent's GRANTED first-degree reach,
    // computed from the live sibling roster filtered to granted channels. Askable
    // peers stay in `agent__list_peers`; this granted-only block lets the agent know
    // its reach without a tool call. Recomputed per spawn — picks up acl.json edits.
    const grantedPeers = (this.listSiblingAgents?.() ?? [])
      .map((s) => ({
        alias: s.alias,
        canonical: s.canonical,
        description: s.description,
        channels: s.channels
          .filter((ch) => ch.reach === 'granted')
          .map((ch) => ({ name: ch.name, bits: ch.bits, sharded: ch.sharded })),
      }))
      .filter((s) => s.channels.length > 0);
    const systemPrompt = assembleSystemPrompt({
      agentFolder: this.host.folder,
      agentName: this.host.name,
      participant: promptParticipant,
      channel: params.channel,
      channelName: params.channelName,
      containerNetwork: agentConfig.containerNetwork,
      profileName: this.profileName,
      previousSessions: params.previousSessions ?? [],
      otherChannelParticipants: params.otherChannelParticipants,
      moreChannelParticipants: params.moreChannelParticipants,
      declaredName: params.declaredName,
      extensionPromptSections: this.extensions.instances
        .map((e) => e.promptSection)
        .filter((s): s is string => !!s),
      timezone: this.effectiveTimezone,
      resources: resourceEntries.length > 0
        ? resourceEntries
            .filter(([, r]) => r.path) // only show provisioned resources
            .map(([name, r]) => ({ name, access: r.access, description: r.description }))
        : undefined,
      hasPip: !!resolved.pip,
      channelContract,
      grantedPeers: grantedPeers.length > 0 ? grantedPeers : undefined,
    });

    // Pre-compose the cleanup body so the runner's single-shot self-expire
    // branch (`conversation-runner.ts: deliverValidatedOutput` → requestCleanup)
    // sees the same profile+channel composition that TTL fire passes through
    // `IdleTimeoutMeta.cleanup`. Without this shadow, single-shot would
    // request cleanup with only the channel body — diverging from TTL.
    const composedCleanup = this.composeCleanupMessage(params.channel.cleanup, params.channel.cleanupEnabled);
    return {
      host: this.host,
      agentFolder: this.host.folder,
      address: params.address,
      conversationKey: params.conversationKey,
      channel: { ...params.channel, cleanup: composedCleanup },
      channelName: params.channelName,
      participant: params.participant,
      replyTo: params.replyTo,
      qualifier: params.qualifier,
      sessionIdOverride: params.sessionIdOverride,
      systemPrompt,
      isNewConversation: params.isNewConversation,
      store: this.store,
      // log_messages: false opts the channel out of all DB-backed logging and
      // logging-adjacent MCP surfaces. Faithful to the pre-bundle-extraction
      // behavior where a single `messageLog: agentDb | undefined` slot
      // controlled message log writes, event log writes, and request/approval
      // tool availability (the conflation was real because those all hung off
      // AgentDb). Splitting the slot didn't change the semantic — three slots
      // gated by one flag.
      agentDb: params.channel.log_messages ? this.agentDb : undefined,
      messageLog: params.channel.log_messages ? this.agentDb.messages : undefined,
      logEvent: params.channel.log_messages ? this.agentDb.logEvent.bind(this.agentDb) : undefined,
      disabledTools: [...disabledTools, ...params.channel.disabled_tools],
      activeExtensions: this.extensions.instances,
      mcpDeps: this.mcpDeps,
      showSteps: agentConfig.showSteps,
      maxOutputBytes: agentConfig.maxOutputBytes,
      timezone: this.effectiveTimezone,
      pipConfig: resolved.pip,
      agentMcpPorts: this.mcpProxies?.getPortMappings(),
    };
  }

}
