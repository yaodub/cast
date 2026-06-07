/**
 * ConsoleManager — per-agent console-session orchestrator.
 *
 * Owns the `console:${folder}` scope binding on the `Conversations` façade and
 * dispatches each incoming console channel through the `ConsoleStrategy`
 * registry (`./registry.ts`) — no hardcoded per-console branches here. Shares
 * the process-wide `slotPool` with agent traffic; per-runner pressure is
 * resolved by swap-eviction in the catalog.
 *
 * Composed by `AgentManager`. Shares the agent-level services (bus, store,
 * AgentDb, spawn hooks) via its constructor opts.
 */
import { isParticipantAddress, isSystemSender } from '../auth/address.js';
import type { IdentityId } from '../auth/address.js';
import { logger } from '../logger.js';
import { readAgentConfig } from '../container/container-runner.js';
import { resolveConversationKey, serializeConversationKey } from '../conversations/resolve-key.js';
import type { Bus } from '../gateway/bus.js';
import { conversations } from '../lib/gates.js';
import type { Routing } from '../agent/agent-bus-payload.js';
import { ConversationRunner, type ConversationRunnerOpts, type DeliverKind } from '../agent/conversation-runner.js';
import type { AgentStateStore } from '../agent/state-store.js';
import type { AgentDb } from '../agent/agent-db.js';
import { buildSpawnHooks as externalBuildSpawnHooks } from '../agent/agent-spawn-hooks.js';
import type { Attachment, Host, RouteResult } from '../types.js';
import type { AgentChannel, IdleTimeoutMeta } from '../conversations/types.js';
import {
  type BuildSpawnHooks,
  type ConversationView,
  type RunnerFactory,
} from '../conversations/index.js';

import { buildConsoleMounts } from './mounts.js';
import type { ConsoleDb } from './console-db.js';
import { assembleConsolePrompt, type ConsoleContext } from './prompt.js';
import { getConsoleStrategy, listConsoleStrategies, parseConsoleName } from './registry.js';
import type { ConsoleName } from './index.js';
import type { ConsoleMcpDeps } from './strategy.js';
import { requestConsoleConversationEnd } from './tools.js';

/** Per-conversation spawn context carried through `Conversations.deliver` and
 *  `Conversations.scheduleTtl`. ConsoleManager's factory closure receives this
 *  as a typed parameter — symmetric with AgentManager's AgentSpawnContext. */
export interface ConsoleSpawnContext {
  consoleName: ConsoleName;
  address: string;
  channelName: string;
  channel: AgentChannel;
  participant: IdentityId;
  replyTo: IdentityId | undefined;
  qualifier: string | undefined;
}

export interface ConsoleManagerOpts {
  readonly host: Host;
  readonly agentId: string;
  readonly bus: Bus;
  readonly store: AgentStateStore;
  /** Per-agent agent.db — spawn hooks use it to write inbound/outbound rows
   *  and (in the agent path) participant upserts. Console runners share the
   *  same hook plumbing for symmetry — the same channel/participant context
   *  flows through. */
  readonly agentDb: AgentDb;
  /** Per-agent console database — holds Design + Configure session history,
   *  isolated from the agent's user-channel `agent.db`. AgentManager owns the
   *  handle lifecycle; ConsoleManager threads `consoleDb.messages` into each
   *  console runner's `messageLog` slot. */
  readonly consoleDb: ConsoleDb;
  /** Read-through timezone getter — re-evaluated per `buildRunnerOpts` so a
   *  config edit lands in the next runner spawn without rebuilding the
   *  ConsoleManager. AgentManager owns the underlying read. */
  readonly getTimezone: () => string;
  /** Builds the dynamic snapshot — AgentManager owns the agent-state reads.
   *  `consoleName` lets the builder branch on agent-scope vs server-scope
   *  consoles (e.g. recent-activity block only for design/configure). */
  readonly buildConsoleContext: (consoleName: ConsoleName) => ConsoleContext;
  /**
   * Builds the MCP dep pack — AgentManager owns the delegation + status
   * plumbing. Called once per runner, but individual tool handlers inside
   * the returned `ConsoleMcpDeps` must read state live (don't close over a
   * frozen snapshot — the runner TTL is 30 minutes and tools advertise
   * "live" data).
   */
  readonly buildConsoleMcpDeps: () => ConsoleMcpDeps;
  /**
   * Register the console session's participant in agent.db. Mirrors the
   * upsert AgentManager.route performs for user-channel messages — without
   * this, `onDelegate`'s `participantExists` security gate rejects every
   * console-originated delegation with "Unknown participant". Console
   * operators are admin-session-authenticated (localhost-only chat routes),
   * so registering them is a formality, not an ACL expansion.
   */
  readonly upsertParticipant: (participant: string) => void;
}

/**
 * Console channels have `cleanupEnabled: false` and their message log writes
 * land in the per-agent `console.db` (separate file from `agent.db`) — so
 * expiry is a simple drop. AgentManager's `onExpiryComplete` wipes agent.db /
 * state; console sessions don't need either.
 *
 * The process-wide `slotPool` (via the `Conversations` façade) bounds
 * simultaneous container spawns across agent + console traffic. Per-runner
 * pressure is resolved by paging idle runners (catalog swap-eviction), not by
 * per-host caps.
 */
export class ConsoleManager {
  private readonly opts: ConsoleManagerOpts;
  readonly scope: string;
  /** Disposer for this manager's `ConversationEventBus` subscription. Set
   *  in the constructor right after `conversations.registerScope`, called
   *  on shutdown. */
  private conversationEventDispose: (() => void) | null = null;

  constructor(opts: ConsoleManagerOpts) {
    this.opts = opts;
    this.scope = `console:${opts.host.folder}`;
    conversations.registerScope<ConsoleSpawnContext>(this.scope, {
      factory: this.buildFactory(),
      buildSpawnHooks: this.buildSpawnHooks,
      store: opts.store,
    });

    // One bus subscription per scope. The snapshot cleanup
    // is the load-bearing reaction (strategies stash blueprint snapshots
    // per-runner; without prompt cleanup on runner removal they leak across
    // sessions). Routing it through the bus instead of inline callbacks
    // keeps the fire site tied to the state transition by construction.
    //
    // `subscribeScope` is the typed chokepoint — `expiry-complete`
    // is a no-op for console traffic (transient authoring surfaces with no
    // agent.db / state to wipe), so it's omitted and the bus skips dispatch.
    this.conversationEventDispose = conversations.subscribeScope<ConsoleSpawnContext>(
      this.scope,
      {
        onQueued: (view, active) => this.routeQueuedEvent(view, active),
        onRunnerRemoved: (view) => this.handleRunnerRemoved(view),
      },
    );

    // Startup sweep — each strategy cleans orphan artifacts (snapshots, etc.)
    // left behind by prior-process crashes (SIGKILL, panic) that bypassed
    // the bus-driven runner-removed reaction. At constructor time the scope
    // has no conversations yet, so every on-disk artifact is an orphan.
    for (const strategy of listConsoleStrategies()) {
      strategy.sweepOrphanArtifacts?.(opts.host.folder, new Set());
    }
  }

  /**
   * Route a message onto a console channel. Mirrors AgentManager.route() for
   * the console path but uses the `console:${folder}` Conversations scope and
   * skips agent.db participant tracking / attachment persistence.
   */
  route(
    consoleName: ConsoleName,
    address: string,
    senderId: string,
    text: string,
    routing?: Routing,
    attachments?: Attachment[],
    kind: DeliverKind = 'participant',
  ): Promise<RouteResult> {
    const strategy = getConsoleStrategy(consoleName);
    const channel = strategy.channel;
    const channelName = strategy.channelName;

    // No receiver-side ACL gate here by design. Two paths land at this
    // method, each gated upstream by the right thing:
    //   - Bus arrivals: agent-bus-handler.ts runs the trust-boundary ACL
    //     for `message`/`ingested`/`push`/`request` at the bus → agent
    //     boundary. External authority is checked there.
    //   - Local intra-agent dispatch (per-agent console push via
    //     dispatchLocalPush → ctx.route): sender-side guards in
    //     handlePushToChannel enforce policy. No trust boundary is
    //     crossed; nothing for a receiver gate to assert.

    // Console channels are transient authoring surfaces — they do not log to
    // agent.db and do not persist attachments. If a user pastes a file, it
    // gets dropped. Log a warning so the drop is visible in server logs.
    if (attachments?.length) {
      logger.warn(
        { agentFolder: this.opts.host.folder, console: consoleName, count: attachments.length },
        'Attachments on console channel are dropped (console sessions do not persist attachments)',
      );
    }
    const rawParticipant = routing?.targetParticipant || senderId;
    // Validate-then-brand: console route entry is a boundary (operator
    // surfaces, delegating consoles). Downstream spawn context trusts the brand.
    if (!isParticipantAddress(rawParticipant)) {
      throw new Error(
        `Invalid participant address: "${rawParticipant}" — expected a bare identity (u:…@issuer), an agent (a:…@issuer), or an operator/console surface`,
      );
    }
    const participant = rawParticipant;
    // Register the participant so onDelegate's security gate recognises
    // this session. See ConsoleManagerOpts.upsertParticipant for rationale.
    this.opts.upsertParticipant(participant);
    const conversationKey = serializeConversationKey(
      resolveConversationKey(channelName, channel, participant, routing?.qualifier),
    );

    const ctx: ConsoleSpawnContext = {
      consoleName,
      address,
      channelName,
      channel,
      participant,
      // When targetParticipant was set it equals the validated participant.
      replyTo: routing?.targetParticipant ? participant : undefined,
      qualifier: routing?.qualifier,
    };

    // TTL timer — every console channel has a 30-min idle timeout. Mirror the
    // agent-side guard (`!isSystemSender`) so a system-flavored sender wouldn't
    // reset an operator's idle clock. `scheduleTtl` auto-materializes the
    // conversation if absent.
    if (channel.idle_timeout !== null && !isSystemSender(senderId)) {
      const meta: IdleTimeoutMeta = {
        conversationKey,
        channelName,
        cleanup: channel.cleanup,
        cleanupEnabled: channel.cleanupEnabled,
        participant,
        idle_timeout: channel.idle_timeout,
        manualEnd: false,
      };
      conversations.scheduleTtl<ConsoleSpawnContext>(
        this.scope,
        conversationKey,
        meta,
        channel.idle_timeout,
        ctx,
      );
    }

    return conversations.deliver<ConsoleSpawnContext>(
      this.scope,
      conversationKey,
      text,
      ctx,
      { kind },
    );
  }

  /**
   * Build the RunnerFactory for this scope. The factory's primary job is to
   * construct the runner; it also fires the strategy's `onSessionOpen` hook
   * since this is exactly the boundary where a fresh runner is about to spawn
   * (covers both first-time entry and post-invalidate replacement — the
   * Conversation tears down the invalidated runner before re-invoking the
   * factory).
   */
  private buildFactory(): RunnerFactory<ConsoleSpawnContext> {
    return (rcOpts, ctx) => {
      const strategy = getConsoleStrategy(ctx.consoleName);
      try {
        strategy.onSessionOpen?.(this.opts.host.folder, rcOpts.conversationKey);
      } catch (err) {
        logger.error(
          { agentFolder: this.opts.host.folder, console: ctx.consoleName, err },
          'Console onSessionOpen hook failed',
        );
      }
      const innerOpts = this.buildRunnerOpts({
        consoleName: ctx.consoleName,
        address: ctx.address,
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

  /** Per-spawn hooks for this manager's scope. Mirrors AgentManager: the
   *  spawn-hooks shim routes follow-up deliveries (retry-push, lifecycle,
   *  query-push) back through the View, so the hook plumbing never needs a
   *  raw ConversationRunner reference. This is the
   *  only host-supplied function — transition observation flows through
   *  the event-bus subscription wired in the constructor. A later change
   *  collapsed the prior single-field `ConversationCallbacks` interface to
   *  a direct `BuildSpawnHooks` function type. */
  private buildSpawnHooks: BuildSpawnHooks<ConsoleSpawnContext> = (conv) =>
    externalBuildSpawnHooks(
      {
        agentId: this.opts.agentId,
        folder: this.opts.host.folder,
        bus: this.opts.bus,
        agentDb: this.opts.agentDb,
        store: this.opts.store,
        getTimezone: this.opts.getTimezone,
      },
      conv,
    );

  /** Bus-driven reaction: a console conversation queued or unqueued on the
   *  slot pool. Forward as a lifecycle event so the operator's admin chat
   *  renders queue UX symmetric with user channels. */
  private routeQueuedEvent(
    view: ConversationView<ConsoleSpawnContext>,
    active: boolean,
  ): void {
    const participant = view.ctx?.participant;
    const channelName = view.ctx?.channelName;
    if (!participant || !channelName) return;
    this.opts.bus.routeEvent({
      from: this.opts.agentId,
      to: participant,
      type: 'lifecycle',
      data: { phase: 'queued', active, channel: channelName },
    });
  }

  /** Bus-driven reaction: console runner removed. Snapshot-based strategies
   *  (Design's blueprint snapshot) hook this to wipe per-runner artifacts
   *  before the next session starts. */
  private handleRunnerRemoved(view: ConversationView<ConsoleSpawnContext>): void {
    const channelName = view.ctx?.channelName;
    if (!channelName) return;
    const name = parseConsoleName(channelName);
    if (name) {
      getConsoleStrategy(name).onRunnerRemoved?.(this.opts.host.folder, view.key);
    }
  }

  private buildRunnerOpts(params: {
    consoleName: ConsoleName;
    address: string;
    conversationKey: string;
    channelName: string;
    participant?: IdentityId;
    replyTo?: IdentityId;
    qualifier?: string;
    sessionIdOverride?: string;
    isNewConversation: boolean;
  }): Omit<ConversationRunnerOpts, 'onIdle' | 'isExpired' | 'requestCleanup'> {
    const agentConfig = readAgentConfig(this.opts.host.folder);
    const strategy = getConsoleStrategy(params.consoleName);
    const consoleCtx = this.opts.buildConsoleContext(params.consoleName);
    // Strategies that opt out of admin__navigate (Design — author/narrate,
    // not navigate) get emitUiDirective stripped so registerAdminNavigateTool
    // short-circuits at registration. See ConsoleStrategy.omitAdminNavigate.
    const baseDeps = this.opts.buildConsoleMcpDeps();
    // `onEndConversation` flows through the Conversations façade scoped to
    // this manager — the cooldown lives on the right scope.
    const consoleDeps: ConsoleMcpDeps = {
      ...baseDeps,
      onEndConversation: (key, cooldownMs) =>
        requestConsoleConversationEnd(this.scope, key, cooldownMs),
      ...(strategy.omitAdminNavigate ? { emitUiDirective: undefined } : {}),
    };
    return {
      host: this.opts.host,
      agentFolder: this.opts.host.folder,
      address: params.address,
      conversationKey: params.conversationKey,
      channel: strategy.channel,
      channelName: params.channelName,
      participant: params.participant,
      replyTo: params.replyTo,
      qualifier: params.qualifier,
      sessionIdOverride: params.sessionIdOverride,
      systemPrompt: assembleConsolePrompt(params.consoleName, this.opts.host, consoleCtx),
      isNewConversation: params.isNewConversation,
      store: this.opts.store,
      // Console channels participate in the same log_messages opt-out as
      // user channels — `false` skips messageLog injection so logInbound/
      // logOutbound are no-ops for the runner. Console strategies default
      // to `true` (consoles have a console.db to write to); set `false` in
      // the strategy to opt out without removing the field.
      messageLog: strategy.channel.log_messages ? this.opts.consoleDb.messages : undefined,
      disabledTools: strategy.channel.disabled_tools,
      activeExtensions: [],
      mcpDeps: undefined,
      showSteps: agentConfig.showConsoleSteps,
      timezone: this.opts.getTimezone(),
      overrideMounts: buildConsoleMounts(this.opts.host, params.consoleName, params.conversationKey),
      workdir: strategy.workdir,
      containerNetwork: strategy.containerNetwork,
      consoleName: params.consoleName,
      consoleDeps,
    };
  }

  get currentActiveCount(): number {
    let count = 0;
    for (const view of conversations.inScope<ConsoleSpawnContext>(this.scope)) {
      if (view.activeProcess !== null) count++;
    }
    return count;
  }

  async shutdown(): Promise<void> {
    this.conversationEventDispose?.();
    this.conversationEventDispose = null;
    await conversations.unregisterScope(this.scope);
  }
}
