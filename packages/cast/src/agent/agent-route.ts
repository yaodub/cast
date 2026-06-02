/**
 * Per-agent message routing — entry point for inbound messages destined for
 * normal (non-console) channels.
 *
 * Owns: channel/participant resolution, TTL kick, attachment persistence,
 * route-context capture for the conversations factory closure. Does NOT own:
 * console channels (ConsoleManager.route), bus dispatch (BusHandler), or
 * runner lifecycle internals (Conversations façade). Lives in its own file
 * so AgentManager stays focused on state ownership.
 *
 * The route hands off to the `Conversations` façade: per-conv routing
 * context is captured before `conversations.deliver`, and the factory closure
 * registered on the agent's scope reads it when constructing a fresh runner.
 */
import type { ConsoleManager } from '../console/console-manager.js';
import { isConsoleChannel } from '../console/index.js';
import { parseConsoleName } from '../console/registry.js';
import { extractIdentity, isAgent, isExtAddress, isSystemSender } from '../auth/address.js';
import type { Bus } from '../gateway/bus.js';
import { getChannel, loadChannelsConfig } from '../conversations/channel-config.js';
import { resolveConversationKey, serializeConversationKey } from '../conversations/resolve-key.js';
import {
  DEFAULT_CHANNEL,
  DEFAULT_CHANNEL_NAME,
  type AgentChannel,
} from '../conversations/types.js';
import type { Conversations } from '../conversations/index.js';
import { panicRegistry } from '../lib/panic-registry.js';
import { generateId } from '../lib/utils.js';
import { logger } from '../logger.js';
import { getProfile } from '../profiles/index.js';
import type { Attachment, Host, RouteResult } from '../types.js';

import type { AgentDb } from './agent-db.js';
import type { Routing } from './agent-bus-payload.js';
import type { AgentStateStore } from './state-store.js';
import { type DeliverKind } from './conversation-runner.js';

/** Per-conversation spawn context carried through `Conversations.deliver`
 *  and `Conversations.scheduleTtl`. AgentManager's factory closure receives
 *  this as a typed parameter — replaces the side-channel `routeContexts`
 *  map Phase C maintained. */
export interface RouteContext {
  address: string;
  channel: AgentChannel;
  channelName: string;
  participant: string | undefined;
  replyTo: string | undefined;
  qualifier: string | undefined;
  declaredName: string | undefined;
  isSingleShot: boolean;
}

export interface AgentRouteDeps {
  agentId: string;
  folder: string;
  host: Host;
  bus: Bus;
  profileName: string;
  agentDb: AgentDb;
  store: AgentStateStore;
  consoleManager: ConsoleManager;
  isShuttingDown: () => boolean;
  conversations: Conversations;
  agentScope: string;
  setIdleTimer: (
    conversationKey: string,
    ctx: RouteContext,
    remainingMs?: number,
  ) => void;
}

interface ResolvedRoute {
  channel: AgentChannel;
  channelName: string;
  participant: string;
  conversationKey: string;
  isSingleShot: boolean;
}

/**
 * Compute the tier attrs for a `<cast:push>` delivery from raw origin inputs.
 * Single source of truth for the push trust-tier policy:
 *
 * - `fromAgent` — set when the push originated on a different agent than the
 *   receiver (cross-agent / "colleague" tier). Always omitted for intra.
 * - `fromParticipant` — the originator's participant address, when known.
 *   For intra-agent push this is the caller's participant; for cross-agent
 *   push the bus handler unpacks `returnToParticipant` (the originating
 *   user carried on the `type: 'push'` payload) into `callerParticipant` here.
 * - `fromChannel` — only set when the caller's channel differs from the
 *   target channel (cross-channel within an agent — "self" tier). Same-channel
 *   doesn't surface fromChannel because it's redundant with the receiver's
 *   own channel context.
 *
 * Both intra-agent (`agent-mcp-deps.ts::deliverToChannel`) and cross-agent
 * (`agent-bus-handler.ts::handleBusMessage`) pushes call this — the agent's
 * prompt sees a consistent `<cast:push fromAgent fromParticipant fromChannel>`
 * shape and can map to the right trust posture without caring which path
 * delivered it.
 */
export function pushTierAttrs(args: {
  receiverAgent: string;
  senderAgent: string;
  callerParticipant?: string;
  callerChannel?: string;
  targetChannel?: string;
}): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (args.senderAgent !== args.receiverAgent) attrs.fromAgent = args.senderAgent;
  if (args.callerParticipant) attrs.fromParticipant = args.callerParticipant;
  if (args.callerChannel && args.callerChannel !== args.targetChannel) {
    attrs.fromChannel = args.callerChannel;
  }
  return attrs;
}

/**
 * Resolve channel config, participant, and conversation key for a routed
 * normal-channel message. Console channels short-circuit before this is called.
 */
function resolveConversation(
  deps: AgentRouteDeps,
  senderId: string,
  routing?: Routing,
): ResolvedRoute {
  const channelName = routing?.channel || DEFAULT_CHANNEL_NAME;

  const config = loadChannelsConfig(deps.host.folder);
  let channel = getChannel(config, channelName);
  if (!channel) {
    if (routing?.channel) {
      logger.warn(
        { agentFolder: deps.folder, channel: routing.channel },
        'Channel not found, falling back to default',
      );
    }
    channel = DEFAULT_CHANNEL;
  }

  // Merge profile bootstrap into channel definition
  const profile = getProfile(deps.profileName);
  if (channel.bootstrapEnabled && profile.bootstrap) {
    channel = {
      ...channel,
      bootstrap:
        [profile.bootstrap, channel.bootstrap].filter(Boolean).join('\n\n') ||
        undefined,
    };
  }

  const participant = routing?.targetParticipant || senderId;

  // ext:* is agent-internal — like 192.168.*.* for a LAN. It may appear as a
  // sender (extension-synthesized inbound) but never as a routing target. If
  // resolution lands ext:* in the participant slot, an upstream caller forgot
  // to set targetParticipant. Throw rather than silently route to a dead address.
  if (isExtAddress(participant)) {
    throw new Error(
      `ext:* address "${participant}" cannot be a routing target — sender-only namespace. ` +
      `Caller must set 'targetParticipant' to a non-ext address.`,
    );
  }

  const baseKey = serializeConversationKey(
    resolveConversationKey(channelName, channel, participant, routing?.qualifier),
  );
  const isSingleShot = channel.idle_timeout === null;
  const conversationKey = isSingleShot
    ? `${baseKey}|${generateId('ss')}`
    : baseKey;

  return { channel, channelName, participant, conversationKey, isSingleShot };
}

export async function routeMessage(
  deps: AgentRouteDeps,
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
  if (deps.isShuttingDown())
    return { ok: false, error: 'Shutting down' };

  // Panic-halt gate. Mirror of the shutdown check — refused if this
  // agent's conversation scope has been placed under a rate-shaped
  // halt by `PanicRegistry`. Halts are scoped to `deps.agentScope`
  // (e.g. `agent:site-manager`), so a halt on user channels doesn't
  // block the operator's design/configure consoles for the same
  // agent — the operator keeps a path to investigate.
  const halt = panicRegistry.getHaltState(deps.agentScope);
  if (halt) {
    logger.info(
      { agentScope: deps.agentScope, button: halt.button, until: halt.until },
      'route: refused (panic halt)',
    );
    return {
      ok: false,
      error: `agent halted (panic: ${halt.button}): ${halt.reason}`,
    };
  }

  // Console channels (`__design`, etc.) go through ConsoleManager — separate
  // Conversations scope (`console:${folder}`), scoped mounts, no agent.db
  // writes. ACL gating lives in `ConsoleManager.route`, not here, so the gate
  // travels with the receiver (any future caller of `consoleManager.route`
  // is gated automatically).
  const consoleName = routing?.channel && isConsoleChannel(routing.channel)
    ? parseConsoleName(routing.channel)
    : null;
  if (consoleName) {
    return deps.consoleManager.route(consoleName, address, senderId, text, routing, attachments, kind);
  }

  // Agent-to-agent ack: emit a parallel message_received event so the
  // sending agent's transport sees the same "we got it" signal that
  // operators get via ingestInbound. Operator path (cli:*, admin:*,
  // tg:*, etc.) already emitted in MessageGateway.ingestInbound —
  // gating on isAgent prevents double-emit. Skip self-routed traffic
  // (scheduler / watch / service fires use senderId === address) — those
  // aren't peer messages and shouldn't generate ack noise.
  if (senderId !== address && isAgent(extractIdentity(senderId))) {
    void deps.bus.routeEvent({
      from: address,
      to: senderId,
      type: 'message_received',
      data: {
        id: generateId('mr'),
        channel: routing?.channel ?? 'default',
        timestamp: new Date().toISOString(),
      },
    });
  }

  const {
    channel: channelDef,
    channelName: effectiveChannelName,
    participant: conversationParticipant,
    conversationKey,
    isSingleShot,
  } = resolveConversation(deps, senderId, routing);

  const isSystemInitiated = isSystemSender(senderId);

  // Track participant in agent database (security gate for delegation)
  if (conversationParticipant && !isSystemSender(conversationParticipant)) {
    deps.agentDb.upsertParticipant(conversationParticipant);
  }

  // Touch the state-store row so `lastActive` reflects this message even if
  // the runner is already alive (pipe-IPC path doesn't otherwise update it).
  if (!isSingleShot) {
    const existing = deps.store.getActiveConversation(conversationKey);
    if (existing) {
      deps.store.touchConversation(conversationKey);
    }
  }

  // Build the per-delivery spawn context. Carried into both `setIdleTimer`
  // (TTL cleanup may need it) and `conversations.deliver` (factory consumes
  // it on cold spawn). Overwrite is intentional — replyTo/declaredName on a
  // fresh delivery refresh the conversation's stored ctx for any future
  // re-construction.
  const ctx: RouteContext = {
    address,
    channel: channelDef,
    channelName: effectiveChannelName,
    participant: conversationParticipant,
    replyTo: routing?.targetParticipant,
    qualifier: routing?.qualifier,
    declaredName,
    isSingleShot,
  };

  // Idle-timeout reset on user-initiated messages. Pre-deliver so the timer
  // arms before the agent starts processing.
  if (channelDef.idle_timeout !== null && !isSystemInitiated) {
    // If the previous timer was a manual-end (agent-requested cooldown),
    // notify the agent that user activity cancelled it. Sent BEFORE the
    // main user message so the agent sees the cancel context first.
    const prevMeta = deps.conversations.peekTtl(deps.agentScope, conversationKey);
    if (prevMeta?.manualEnd) {
      const view = deps.conversations.get(deps.agentScope, conversationKey);
      if (view?.canAcceptUserMessage()) {
        void deps.conversations.deliver<RouteContext>(
          deps.agentScope,
          conversationKey,
          'The participant sent a new message. The scheduled conversation end has been cancelled.',
          ctx,
          { kind: 'lifecycle' },
        );
      }
    }
    deps.setIdleTimer(conversationKey, ctx);
  }

  // Inbound attachments are already persisted at the gateway boundary
  // (`MessageGateway.persistInboundAttachments`). By the time they cross the
  // bus and reach here, `data:Buffer` has been stripped by the schema and
  // `hostPath` + `hash` are guaranteed to be set.
  const diskAttachments: Attachment[] | undefined = attachments?.length
    ? attachments.map((att) => ({
        filename: att.filename,
        mimeType: att.mimeType,
        hostPath: att.hostPath!,
        filesize: att.filesize ?? 0,
        hash: att.hash!,
      }))
    : undefined;
  if (diskAttachments?.length) {
    logger.info(
      { agentFolder: deps.folder, count: diskAttachments.length, conversationKey },
      'Inbound attachments received',
    );
  }

  return deps.conversations.deliver<RouteContext>(
    deps.agentScope,
    conversationKey,
    text,
    ctx,
    { kind, attrs, rawText, attachments: diskAttachments },
  );
}

export function closeConversationByAddress(
  deps: AgentRouteDeps,
  address: string,
  routing?: Routing,
): void {
  const effectiveChannel = routing?.channel || DEFAULT_CHANNEL_NAME;
  for (const view of deps.conversations.inScope(deps.agentScope)) {
    // The conversation key encodes channelName as a prefix
    // (`${channelName}|${participant}|${qualifier}`) — match on prefix.
    // Address is the agent's own address (constant per scope) so we don't
    // need to match it explicitly.
    if (view.key.startsWith(`${effectiveChannel}|`)) {
      void deps.conversations.expire(deps.agentScope, view.key, null);
      return;
    }
  }
  // Silently no-op if not found — `markInvalidated` may race with TTL
  // expiry or shutdown, both of which legitimately drop the Conversation.
  void address;
}
