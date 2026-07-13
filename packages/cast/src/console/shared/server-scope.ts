/**
 * ServerScopeConsole — shared base for code-declared virtual consoles at
 * `console:<name>` addresses. DM, CM, and SM subclass this.
 *
 * Structural concerns that live here (vs. per-console subclass):
 *   - BusHandler wiring (register, ingress gate, payload parse, conversationKey)
 *   - `serverscope:${folder}` scope ownership on the Conversations façade
 *   - agent-registry invalidation subscription
 *   - Default `onDelegate` (intra-surface routing back through bus)
 *   - Default `emitUiDirective` (routes admin__navigate through bus)
 *
 * What subclasses supply via `spec`:
 *   - Descriptor (`console:<name>`), Host (`.<name>/`), consoleName
 *   - Strategy (channel, network, mounts, tool registration)
 *   - `buildContext` / `assemblePrompt` (subclass owns its prompt module)
 *
 * What subclasses may override:
 *   - `buildConsoleMcpDeps` — to add console-specific deps like DM's
 *     `createAgent`. Default covers the shape every server-scope console
 *     needs (`onDelegate`, `resolveAgentByLabel`, `emitUiDirective`).
 */
import type { McpServerDeps } from '../../agent/mcp-server.js';
import { conversations } from '../../lib/gates.js';
import { ConversationRunner, type ConversationRunnerOpts, type SpawnHooks } from '../../agent/conversation-runner.js';
import { AgentStateStore } from '../../agent/state-store.js';
import type { Bus, BusHandler, BusLifecycleEvent } from '../../gateway/bus.js';
import path from 'path';
import { resolveConversationKey, serializeConversationKey } from '../../conversations/resolve-key.js';
import type { AgentChannel, IdleTimeoutMeta } from '../../conversations/types.js';
import {
  type ConversationView,
  type RunnerFactory,
} from '../../conversations/index.js';
import type { Evt, Host } from '../../types.js';
import { logger } from '../../logger.js';
import { agentPath, AGENTS_DIR, listSubdirectories, TIMEZONE } from '../../config.js';
import type { FileWatcher } from '../../lib/file-watcher.js';
import { formatMessages } from '../../lib/format.js';
import { generateId } from '../../lib/utils.js';
import { AttachmentSchema } from '../../types.js';
import { buildLifecycleEvtData } from '../../conversations/lifecycle-render.js';
import { z } from 'zod';

import { buildConsoleMounts } from '../mounts.js';
import type { ConsoleDb } from '../console-db.js';
import type { ConsoleMcpDeps, ConsoleStrategy } from '../strategy.js';
import type { ConsoleName } from '../index.js';
import { requestConsoleConversationEnd } from '../tools.js';

import type { AdminManual } from '@getcast/admin-schema/v1';

import { checkAcl, gateInbound } from '../../auth/acl.js';
import { isOperatorTier, isParticipantAddress } from '../../auth/address.js';
import type { IdentityId } from '../../auth/address.js';
import { hasOutboundBit } from './console-auth.js';
import { isManagerConsole } from './manager-consoles.js';
import { OutboundQueryTracker } from './query-round-trip.js';
import { initializeViewDir, maintainViewDir, refreshViewDirFolder } from './view-dir-maintenance.js';

const RoutingSchema = z.object({
  channel: z.string().optional(),
  qualifier: z.string().optional(),
  targetParticipant: z.string().optional(),
});

// Union schema — server-scope consoles accept (a) inbound operator messages
// (transport-ingested as `type: 'ingested'`), (b) cross-agent pushes
// (`type: 'push'`), and (c) the reply side of outbound `<cast:query>`
// round-trips (`response` / `rejection`). Request-type packets are
// sender-side-only for managers.
const BusPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    text: z.string(),
    routing: RoutingSchema.optional(),
  }),
  z.object({
    type: z.literal('ingested'),
    text: z.string(),
    declaredName: z.string().optional(),
    attachments: z.array(AttachmentSchema).optional(),
    routing: RoutingSchema.optional(),
  }),
  z.object({
    type: z.literal('push'),
    text: z.string(),
    requestId: z.string(),
    returnToParticipant: z.string(),
    returnToChannel: z.string(),
    returnToQualifier: z.string().optional(),
    routing: RoutingSchema.optional(),
  }),
  z.object({
    type: z.literal('response'),
    text: z.string(),
    requestId: z.string(),
    originChannel: z.string(),
    originParticipant: z.string(),
    originQualifier: z.string().optional(),
  }),
  z.object({
    type: z.literal('rejection'),
    requestId: z.string(),
    reason: z.string(),
    originChannel: z.string(),
    originParticipant: z.string(),
    originQualifier: z.string().optional(),
  }),
]);

export interface ServerScopeDescriptor {
  readonly address: string;
  readonly label: string;
  readonly access: 'local-only';
}

/** Per-conversation spawn context carried through `Conversations.deliver` and
 *  `Conversations.scheduleTtl`. ServerScopeConsole's factory closure receives
 *  this as a typed parameter. */
export interface ServerScopeSpawnContext {
  channelName: string;
  channel: AgentChannel;
  participant: IdentityId;
  replyTo: IdentityId | undefined;
  qualifier: string | undefined;
}

/**
 * Declarative bundle of what makes one server-scope console distinct.
 * Mechanical bits (Conversations wiring, handleMessage flow, invalidation)
 * live in the base class.
 */
export interface ServerScopeConsoleSpec {
  readonly descriptor: ServerScopeDescriptor;
  readonly host: Host;
  readonly strategy: ConsoleStrategy;
  readonly consoleName: ConsoleName;
  /** Passed to `bus.register` for peer metadata. */
  readonly description: string;
  /** Prompt context — each console shapes this differently. Must include `timezone`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly buildContext: (adminManual?: AdminManual) => any;
  /** Assemble the full system prompt from a built context. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly assemblePrompt: (ctx: any) => string;
}

export interface ServerScopeConsoleOpts {
  readonly bus: Bus;
  readonly mcpDeps: McpServerDeps;
  /** Shared server-scope console database. DM, CM, SM all write to this one
   *  file (discriminated by `channel` on the row). Owned by `index.ts`,
   *  opened at startup, closed at shutdown. */
  readonly consoleDb: ConsoleDb;
  readonly getAdminManual?: () => AdminManual | undefined;
  /**
   * Server-level fallback for whether intermediate messages (tool calls,
   * intermediate reasoning) surface in this console's chat. Read from
   * `<CAST_CONFIG_DIR>/server.json:showManagerSteps`. Strategy-level `showSteps`
   * (when set) still wins; this kicks in when the strategy leaves it
   * `undefined`.
   */
  readonly getShowManagerSteps?: () => boolean | undefined;
  /**
   * Shared FileWatcher singleton. When provided, manager consoles (DM/CM/SM)
   * subscribe to `blueprint/{props,channels,identity}` changes per agent and
   * refresh their per-folder view summaries in response — so DM reading the
   * summary after per-agent Design finishes authoring sees fresh content
   * instead of the empty-at-create snapshot. Non-manager consoles ignore it.
   */
  readonly fileWatcher?: FileWatcher;
}

/** Directories under `blueprint/` that the view summary covers. */
const BLUEPRINT_WATCH_SUBDIRS = ['props', 'channels', 'identity'] as const;

/** Trailing-edge debounce window for coalescing N-file writes into one refresh. */
const REFRESH_DEBOUNCE_MS = 150;

export class ServerScopeConsole implements BusHandler {
  protected readonly bus: Bus;
  protected readonly mcpDeps: McpServerDeps;
  protected readonly consoleDb: ConsoleDb;
  protected readonly getAdminManual: (() => AdminManual | undefined) | undefined;
  protected readonly getShowManagerSteps: (() => boolean | undefined) | undefined;
  protected readonly store: AgentStateStore;
  protected readonly spec: ServerScopeConsoleSpec;
  /** Scope key for this console on the `conversations` façade. */
  readonly scope: string;
  private readonly fileWatcher: FileWatcher | undefined;
  /** Per-folder trailing-edge debounce for view-dir refreshes. */
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
  /** Outbound `<cast:query>` round-trip subsystem; see `query-round-trip.ts`. */
  private readonly queryTracker: OutboundQueryTracker;
  /** Disposer for this console's `ConversationEventBus` subscription. Set
   *  in the constructor right after `conversations.registerScope`, called
   *  on shutdown. */
  private conversationEventDispose: (() => void) | null = null;

  /**
   * Agent-set changes are handled by view-dir maintenance: the mount is a
   * single `view/` dir, stable across the container's lifetime. On add/remove
   * we just write/delete the per-agent summary files. No respawn, no
   * sdk-session resume dance, no mid-conversation latency.
   */
  private readonly onLifecycleChange = (event: BusLifecycleEvent): void => {
    if (!isManagerConsole(this.spec.consoleName)) return;
    // Only care about agent register/deregister. Skip 'updated' (handler
    // refreshes don't change the agent set) and non-agent entities.
    let folder: string;
    let kind: 'added' | 'removed';
    if (event.type === 'registered') {
      const meta = this.bus.getMetadata(event.address);
      if (meta?.type !== 'agent') return;
      folder = path.basename(meta.folderPath);
      kind = 'added';
    } else if (event.type === 'deregistered') {
      // metadata is captured by Bus before delete (see bus.ts unregister).
      if (event.metadata?.type !== 'agent') return;
      folder = path.basename(event.metadata.folderPath);
      kind = 'removed';
    } else {
      return;
    }

    maintainViewDir(this.spec.consoleName, { kind, folder });
    if (kind === 'added') {
      this.subscribeToBlueprintChanges(folder);
    } else {
      const timer = this.refreshTimers.get(folder);
      if (timer) {
        clearTimeout(timer);
        this.refreshTimers.delete(folder);
      }
    }
  };

  /**
   * Subscribe to `blueprint/{props,channels,identity}` changes for one agent
   * folder and refresh that agent's view summary (debounced) when anything
   * under those paths changes. Reuses the shared `FileWatcher`. Idempotent
   * per (dir, callback): a re-subscribe (e.g. archive-then-recreate) would
   * dupe callbacks, but `writeSurfaceIfChanged` hash-compares and bails on
   * no-op, so the cost is a wasted `walkSurface` call per dupe.
   */
  private subscribeToBlueprintChanges(folder: string): void {
    if (!this.fileWatcher) return;
    const consoleName = this.spec.consoleName;
    if (!isManagerConsole(consoleName)) return;
    const onChange = () => {
      const existing = this.refreshTimers.get(folder);
      if (existing) clearTimeout(existing);
      this.refreshTimers.set(folder, setTimeout(() => {
        this.refreshTimers.delete(folder);
        refreshViewDirFolder(consoleName, folder);
      }, REFRESH_DEBOUNCE_MS));
    };
    for (const sub of BLUEPRINT_WATCH_SUBDIRS) {
      this.fileWatcher.onChange(agentPath(folder, 'blueprint', sub), onChange);
    }
  }

  /**
   * Default same-agent delivery — server-scope consoles have no user channels
   * of their own, so this is rejected. Subclasses can override if a server-
   * scope console ever gains its own channels. The `actor` parameter is part
   * of the shared `DeliverToChannel` signature but unused here.
   */
  protected readonly deliverToChannel: NonNullable<ConsoleMcpDeps['deliverToChannel']> = async () => {
    return { ok: false, reason: `${this.spec.descriptor.label} cannot push to itself (no user channels).` };
  };

  /**
   * Default cross-agent delivery — admin-session-trusted path. Goes through
   * `bus.routeMessage`, which re-enters the target's own ACL check (code-
   * declared grant from `CONSOLE_OUTBOUND_ACLS`). Fire-and-forget: returns
   * after the bus dispatch is queued, not after the target finishes.
   */
  protected readonly deliverToAgent: NonNullable<ConsoleMcpDeps['deliverToAgent']> = async (_actor, targetAgent, channel, text, participant) => {
    // Source-side authorization — defense-in-depth. Receiver still gates inbound
    // (target's handleMessage runs its own checkAcl with `i` — post-fold, push
    // is gated as a message). The `OutboundQueryTracker` uses the same helper
    // with `'q'` for the query path.
    if (!hasOutboundBit(this.spec.descriptor.address, targetAgent, channel, 'o')) {
      return { ok: false, reason: `${this.spec.descriptor.label} not authorized to push to ${targetAgent} on channel "${channel}"` };
    }
    // Mint a correlation `requestId` — same shape as agent push so the
    // receiver-side rejection routing back to the console carries an ID
    // matching the dispatched push.
    const requestId = generateId('req');
    // Fire-and-forget — at-most-once: log dispatch failure so silent drops are visible in dogfood.
    void this.bus.routeMessage(this.spec.descriptor.address, targetAgent, {
      type: 'push' as const,
      text,
      requestId,
      returnToParticipant: participant,
      returnToChannel: this.spec.strategy.channelName,
      routing: { channel },
    }).catch((err) => {
      logger.error({ err, source: this.spec.descriptor.address, target: targetAgent, channel, participant, requestId }, 'server-scope deliverToAgent dispatch failed');
    });
    return { ok: true, requestId };
  };

  constructor(opts: ServerScopeConsoleOpts & { spec: ServerScopeConsoleSpec }) {
    this.bus = opts.bus;
    this.mcpDeps = opts.mcpDeps;
    this.consoleDb = opts.consoleDb;
    this.getAdminManual = opts.getAdminManual;
    this.getShowManagerSteps = opts.getShowManagerSteps;
    this.fileWatcher = opts.fileWatcher;
    this.spec = opts.spec;
    this.scope = `serverscope:${this.spec.host.folder}`;
    this.store = new AgentStateStore(agentPath(this.spec.host.folder, 'state'));
    conversations.registerScope<ServerScopeSpawnContext>(this.scope, {
      factory: this.buildFactory(),
      buildSpawnHooks: (view) => this.buildSpawnHooks(view),
      store: this.store,
    });

    // One bus subscription per scope. Server-scope consoles
    // (DM / CM / SM) only react to queued transitions; the manager has no
    // per-runner snapshot or agent.db state to clean on `runner-removed` /
    // `expiry-complete`. `subscribeScope` narrows the view to
    // `<ServerScopeSpawnContext>` once at the façade boundary.
    this.conversationEventDispose = conversations.subscribeScope<ServerScopeSpawnContext>(
      this.scope,
      {
        onQueued: (view, active) => this.routeQueuedEvent(view, active),
      },
    );

    this.queryTracker = new OutboundQueryTracker(this.bus, this.spec);
  }

  /** Register on the bus as an exact address. Call once at startup. */
  register(): void {
    this.bus.register(this.spec.descriptor.address, this, 'exact', {
      label: this.spec.descriptor.label,
      type: 'service',
      description: this.spec.description,
      folderPath: this.spec.host.folder,
    });
    // Populate the view dir so the first session has summaries to mount.
    // Safe to re-run — write-if-changed semantics keep it idempotent.
    if (isManagerConsole(this.spec.consoleName)) {
      const result = initializeViewDir(this.spec.consoleName);
      logger.info(
        { consoleName: this.spec.consoleName, ...result },
        'view dir initialized',
      );
      // Subscribe to blueprint-edit events for every existing agent so the
      // summaries stay fresh as per-agent Design sessions author content.
      // New folders are picked up in `onLifecycleChange` on `registered`.
      if (this.fileWatcher) {
        const folders = listSubdirectories(AGENTS_DIR).filter((f) => !f.startsWith('.'));
        for (const folder of folders) {
          this.subscribeToBlueprintChanges(folder);
        }
      }
    }
    // Subscribe to Bus lifecycle. Because this register() runs AFTER the
    // orchestrator's boot-time agent registration sweep (see index.ts
    // ordering), the listener naturally never sees initial-set events.
    // This preserves the "suppress initial set" semantics.
    this.bus.onLifecycle(this.onLifecycleChange);
    logger.info({ address: this.spec.descriptor.address }, `${this.constructor.name} registered on bus`);
  }

  async shutdown(): Promise<void> {
    this.bus.offLifecycle(this.onLifecycleChange);
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    this.conversationEventDispose?.();
    this.conversationEventDispose = null;
    await conversations.unregisterScope(this.scope);
  }

  // =========================================================================
  // BusHandler — inbound from admin chat
  // =========================================================================

  async handleMessage(from: string, _to: string, payload: unknown): Promise<void> {
    // Skip packet-shaped payloads (rejection replies from agent-manager).
    // Arrives when a cross-agent delegation's target replies — responses route
    // back to the delegator. We don't process agent replies; silently drop.
    if (payload && typeof payload === 'object' && 'pkt' in payload) return;
    const parsed = BusPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ from, err: parsed.error.message, console: this.spec.consoleName }, 'ServerScopeConsole: invalid bus payload');
      return;
    }
    const msg = parsed.data;

    // `response` / `rejection` packets are the reply side of a `<cast:query>`
    // round-trip — they originate from per-agent Design/Configure sessions,
    // not from the operator. Ingress gate applies only to operator messages.
    if (msg.type === 'response' || msg.type === 'rejection') {
      this.queryTracker.handleInboundReply(from, msg);
      return;
    }

    // Ingress gate. The operator tier always passes — admin-route localhost
    // binding + session-token gating is the primary check, this is the
    // defense-in-depth for anything that slipped through.
    const channelName = msg.routing?.channel ?? this.spec.strategy.channelName;
    if (!isOperatorTier(from)) {
      const { bits } = checkAcl(this.bus, this.spec.host.folder, from, channelName);
      // A push is gated as a message (post-fold) — both check `i`.
      const { allowed, verb } = gateInbound(bits, 'message');
      if (!allowed) {
        logger.warn(
          { from, console: this.spec.consoleName, channel: channelName, bits, requiredVerb: verb },
          'ServerScopeConsole: inbound rejected — no grant',
        );
        return;
      }
    }
    // For push, the originating-user (returnToParticipant) is the cell
    // contributor; for ingested/message, the sender is the participant.
    const rawParticipant = msg.type === 'push' ? msg.returnToParticipant : from;
    const qualifier = msg.type === 'push' ? msg.returnToQualifier : msg.routing?.qualifier;
    // Validate-then-brand at the bus boundary: payload shape is zod-checked
    // upstream, but the participant CONTENT is sender-supplied. Drop with a
    // log on violation, mirroring the invalid-payload handling above.
    if (!isParticipantAddress(rawParticipant)) {
      logger.warn(
        { from, console: this.spec.consoleName, participant: rawParticipant },
        'ServerScopeConsole: invalid participant address on bus message, dropping',
      );
      return;
    }
    const participant = rawParticipant;

    const conversationKey = serializeConversationKey(
      resolveConversationKey(channelName, this.spec.strategy.channel, participant, qualifier),
    );

    const ctx: ServerScopeSpawnContext = {
      channelName,
      channel: this.spec.strategy.channel,
      participant,
      // push: returnToParticipant IS the validated participant; message/ingested:
      // targetParticipant, when set, must itself be structurally valid.
      replyTo: msg.type === 'push'
        ? participant
        : (msg.routing?.targetParticipant && isParticipantAddress(msg.routing.targetParticipant) ? msg.routing.targetParticipant : undefined),
      qualifier,
    };

    if (this.spec.strategy.channel.idle_timeout !== null) {
      const meta: IdleTimeoutMeta = {
        conversationKey,
        channelName,
        cleanup: this.spec.strategy.channel.cleanup,
        cleanupEnabled: this.spec.strategy.channel.cleanupEnabled,
        participant,
        idle_timeout: this.spec.strategy.channel.idle_timeout,
        manualEnd: false,
      };
      conversations.scheduleTtl<ServerScopeSpawnContext>(
        this.scope,
        conversationKey,
        meta,
        this.spec.strategy.channel.idle_timeout,
        ctx,
      );
    }

    // Build the text the runner sees: ingested operator messages need the
    // `<messages>` envelope (the runner is the single envelope authority
    // now); push and plain message variants land as-is. Note: this is
    // pre-format-pass-migration; in the current codebase the gateway still
    // wraps ingested envelopes, so consoles receive ingested with text
    // already enveloped.
    const deliverText = msg.type === 'ingested'
      ? formatMessages(
          [
            {
              id: generateId('pkt'),
              address: this.spec.descriptor.address,
              sender: from,
              sender_name: msg.declaredName ?? from,
              content: msg.text,
              timestamp: new Date().toISOString(),
            },
          ],
          TIMEZONE,
        )
      : msg.text;

    void conversations.deliver<ServerScopeSpawnContext>(
      this.scope,
      conversationKey,
      deliverText,
      ctx,
    );
  }

  async handleEvent(_evt: Evt): Promise<void> {
    // Server-scope consoles don't handle peer events. The admin chat SSE picks
    // up outbound events via ConsoleTransport.
  }

  // =========================================================================
  // Runner wiring
  // =========================================================================

  /** Build the RunnerFactory for this scope. */
  private buildFactory(): RunnerFactory<ServerScopeSpawnContext> {
    return (rcOpts, ctx) => {
      const innerOpts = this.buildRunnerOpts({
        conversationKey: rcOpts.conversationKey,
        channelName: ctx.channelName,
        participant: ctx.participant,
        replyTo: ctx.replyTo,
        qualifier: ctx.qualifier,
        sessionIdOverride: rcOpts.ccSessionId,
        isNewConversation: rcOpts.isNewConversation,
      });
      return new ConversationRunner({
        ...innerOpts,
        onIdle: rcOpts.onIdle,
        isExpired: rcOpts.isExpired,
        requestCleanup: rcOpts.requestCleanup,
      });
    };
  }

  /** Bus-driven reaction: a server-scope conversation queued or unqueued on
   *  the slot pool. Forward as a lifecycle event so the operator's admin
   *  chat renders queue UX. */
  private routeQueuedEvent(
    view: ConversationView<ServerScopeSpawnContext>,
    active: boolean,
  ): void {
    const participant = view.ctx?.participant;
    const channelName = view.ctx?.channelName;
    if (!participant || !channelName) return;
    this.bus.routeEvent({
      from: this.spec.descriptor.address,
      to: participant,
      type: 'lifecycle',
      data: { phase: 'queued', active, channel: channelName },
    });
  }

  protected buildRunnerOpts(params: {
    conversationKey: string;
    channelName: string;
    participant: IdentityId;
    replyTo?: IdentityId;
    qualifier?: string;
    sessionIdOverride?: string;
    isNewConversation: boolean;
  }): Omit<ConversationRunnerOpts, 'onIdle' | 'isExpired' | 'requestCleanup'> {
    const ctx = this.spec.buildContext(this.getAdminManual?.());
    ctx.timezone = TIMEZONE;
    return {
      host: this.spec.host,
      agentFolder: this.spec.host.folder,
      address: this.spec.descriptor.address,
      conversationKey: params.conversationKey,
      channel: this.spec.strategy.channel,
      channelName: params.channelName,
      participant: params.participant,
      replyTo: params.replyTo,
      qualifier: params.qualifier,
      sessionIdOverride: params.sessionIdOverride,
      systemPrompt: this.spec.assemblePrompt(ctx),
      isNewConversation: params.isNewConversation,
      store: this.store,
      // Gate console-DB injection on log_messages. Server-scope strategies
      // default to `true` (DM/CM/SM all write to the shared server-console.db
      // discriminated by channel). Setting `false` in the strategy opts the
      // console out of history persistence without disabling the runner.
      messageLog: this.spec.strategy.channel.log_messages ? this.consoleDb.messages : undefined,
      disabledTools: this.spec.strategy.channel.disabled_tools,
      activeExtensions: [],
      mcpDeps: undefined,
      // Server-scope counterpart to per-agent `agentConfig.showConsoleSteps`.
      // Operator's server-level toggle wins when set (explicit true OR false);
      // strategy default applies only when the operator hasn't configured it.
      showSteps:
        this.getShowManagerSteps?.()
        ?? this.spec.strategy.showSteps
        ?? false,
      timezone: TIMEZONE,
      overrideMounts: buildConsoleMounts(this.spec.host, this.spec.consoleName, params.conversationKey),
      workdir: this.spec.strategy.workdir,
      containerNetwork: this.spec.strategy.containerNetwork,
      consoleName: this.spec.consoleName,
      consoleDeps: this.buildConsoleMcpDeps(),
    };
  }

  /**
   * Build the ConsoleMcpDeps bag. Subclasses override to add console-specific
   * deps (e.g. DM's `createAgent`). Use `{ ...super.buildConsoleMcpDeps(), ... }`
   * to extend rather than replace.
   *
   * `emitUiDirective` is gated on `strategy.omitAdminNavigate` — DM/SM omit
   * it (they propose / audit, not navigate concierge), CM keeps it.
   */
  protected buildConsoleMcpDeps(): ConsoleMcpDeps {
    const deps: ConsoleMcpDeps = {
      deliverToChannel: this.deliverToChannel,
      deliverToAgent: this.deliverToAgent,
      resolveAgentByLabel: this.mcpDeps.resolveAgentByLabel,
      onEndConversation: (key, cooldownMs) =>
        requestConsoleConversationEnd(this.scope, key, cooldownMs),
    };
    if (!this.spec.strategy.omitAdminNavigate) {
      deps.emitUiDirective = (from, to, channel, directive) => {
        // Fire-and-forget — at-most-once: log dispatch failure for dogfood visibility.
        void this.bus.routeEvent({
          from,
          to,
          type: 'ui_directive',
          data: { channel, directive },
        }).catch((err) => {
          logger.error({ err, from, to, channel }, 'server-scope emitUiDirective dispatch failed');
        });
      };
    }
    return deps;
  }

  protected buildSpawnHooks(view: ConversationView<ServerScopeSpawnContext>): SpawnHooks {
    const ctx = view.ctx;
    if (ctx === undefined) {
      throw new Error(
        `ServerScopeConsole.buildSpawnHooks: no ctx on conversation ${view.key}`,
      );
    }
    return {
      onSessionId: () => {
        // SDK manages the .claude dir; no explicit state-store write.
      },
      onOutput: async (pkt, channel, _conversationKey) => {
        await this.bus.routeMessage(pkt.from, pkt.to, { pkt, channel });
      },
      onPreview: (pkt, channel, _conversationKey) => {
        // Fire-and-forget — at-most-once. Preview frames are transient,
        // coalesced by streamId at the consumer; a dropped frame just
        // means the live bubble stutters before the next one or the seal
        // arrives. The console transport fans them out as `preview` events.
        void this.bus.routeMessage(pkt.from, pkt.to, { pkt, channel }).catch((err) => {
          logger.error({ err, streamId: pkt.streamId, from: pkt.from, to: pkt.to }, 'server-scope onPreview dispatch failed');
        });
      },
      onTyping: (evt) => {
        // Fire-and-forget — at-most-once: log dispatch failure for dogfood visibility.
        void this.bus.routeEvent(evt).catch((err) => {
          logger.error({ err, evt: { from: evt.from, to: evt.to, type: evt.type } }, 'server-scope onTyping dispatch failed');
        });
      },
      onLifecycle: (phase, active, extras) => {
        if (!ctx.participant) return;
        // Fire-and-forget — at-most-once: log dispatch failure for dogfood visibility.
        void this.bus.routeEvent({
          from: this.spec.descriptor.address,
          to: ctx.participant,
          type: 'lifecycle',
          data: buildLifecycleEvtData(phase, active, ctx.channelName, extras),
        }).catch((err) => {
          logger.error({ err, from: this.spec.descriptor.address, to: ctx.participant, phase }, 'server-scope onLifecycle dispatch failed');
        });
      },
      // `<cast:query target="..." channel="__design">...</cast:query>` (and the
      // fire-and-forget `<cast:request>` variant) tags emitted in the manager's
      // output. See `query-round-trip.ts` for the full flow — `kind` chooses
      // the matching ACL bit (`q` vs `r`) and whether to track for reply.
      onRequest: (kind, target, channel, text, qualifier) =>
        this.queryTracker.handleOutboundRequest(view, kind, target, channel, text, qualifier),
      // Managers are queriers, not answerers in the current model — but the
      // hook is wired for symmetry so a future pattern where a manager
      // receives `<cast:query>` from, say, another server-scope console can emit
      // `<cast:answer>` back. Today this is unreachable.
      onResponse: (requestId, text) =>
        this.queryTracker.handleOutboundResponse(view, requestId, text),
    };
  }

}
