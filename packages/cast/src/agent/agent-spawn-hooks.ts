/**
 * SpawnHooks construction for AgentManager-owned ConversationRunners.
 *
 * The hooks are how a runner reports back to its owning agent: session id,
 * outbound output/request/response packets, typing events, lifecycle phases.
 * Lives in its own file so AgentManager stays focused on state ownership and
 * orchestration; the per-event branching belongs here.
 */
import { z } from 'zod';

import { checkAcl, getPeerChannels, hasBit } from '../auth/acl.js';
import {
  deriveChannelContract,
  renderContractForRejection,
} from '../auth/channel-contract.js';
import type { Bus } from '../gateway/bus.js';
import type { ConversationPkt, PreviewPkt } from '../gateway/packets.js';
import { escapeXml, formatMessages } from '../lib/format.js';
import { generateId } from '../lib/utils.js';
import { logger } from '../logger.js';
import { buildLifecycleEvtData } from '../conversations/lifecycle-render.js';

import type { AgentDb } from './agent-db.js';
import type { SpawnHooks } from './conversation-runner.js';
import type { AgentChannel } from '../conversations/types.js';
import type { AgentStateStore } from './state-store.js';
import type { ConversationView } from '../conversations/conversation.js';

const StringArraySchema = z.array(z.string()).catch([]);

function parseStringArray(json: string): string[] {
  try { return StringArraySchema.parse(JSON.parse(json)); } catch { return []; }
}

/**
 * Compute the upstream set for a (channel, participant) context.
 * Union of: self + from_agent from each open inbound request + their upstream_sets.
 */
export function computeUpstreamSet(
  agentDb: AgentDb,
  selfId: string,
  channel: string,
  participant: string,
): Set<string> {
  const set = new Set<string>([selfId]);
  for (const req of agentDb.getOpenInboundRequests(channel, participant)) {
    set.add(req.from_agent);
    for (const id of parseStringArray(req.upstream_set)) {
      set.add(id);
    }
  }
  return set;
}

/** Format a system feedback message for undelivered output. Wrapped in <messages> for SDK compatibility. */
export function systemUndelivered(reason: string, droppedText: string, timezone?: string): string {
  const body = `<system>\n${reason}\n<message>${escapeXml(droppedText)}</message>\n</system>`;
  return formatMessages(
    [
      {
        id: '',
        address: '',
        sender: 'system',
        sender_name: 'system',
        content: body,
        timestamp: new Date().toISOString(),
      },
    ],
    timezone,
  );
}

/**
 * Format a system feedback message for output that failed validation (malformed
 * cast tags or size violation). Pushed to the agent via `runner.deliver()` so
 * the next turn sees the rejection and can self-correct.
 *
 * Truncates the dropped raw payload (first 500 + last 500 bytes when >1KB) so
 * a 50KB malformed dump doesn't burn the agent's context window when echoed back.
 */
export function systemFormatError(reasons: string[], droppedRaw: string, timezone?: string): string {
  const reasonList = reasons.map((r) => `- ${r}`).join('\n');
  let shownPayload: string;
  if (droppedRaw.length > 1000) {
    const truncated = droppedRaw.length - 1000;
    shownPayload = `${droppedRaw.slice(0, 500)}…[${truncated} bytes truncated]…${droppedRaw.slice(-500)}`;
  } else {
    shownPayload = droppedRaw;
  }
  const body = `<system>\nOutput rejected. Errors:\n${reasonList}\n\nYour output (${droppedRaw.length > 1000 ? 'first 500 + last 500 bytes shown' : 'shown in full'}):\n<message>${escapeXml(shownPayload)}</message>\n\nResend with valid format. For long content, write to /staging/out/ and reference the file in a short message.\n</system>`;
  return formatMessages(
    [
      {
        id: '',
        address: '',
        sender: 'system',
        sender_name: 'system',
        content: body,
        timestamp: new Date().toISOString(),
      },
    ],
    timezone,
  );
}

export interface SpawnHookDeps {
  agentId: string;
  folder: string;
  bus: Bus;
  agentDb: AgentDb;
  store: AgentStateStore;
  /** Returns the timezone effective at hook-firing time (mutable on AgentManager). */
  getTimezone: () => string;
}

/**
 * Per-spawn ctx shape that `buildSpawnHooks` reads from the host's typed
 * spawn-context. Both `AgentSpawnContext` and `ConsoleSpawnContext` extend
 * this — the helper requires `TCtx extends SpawnHookCtxFields` so the view's
 * ctx narrows correctly. J.6e dropped the structural `SpawnHookCtx` shim;
 * the helper now reads from a `ConversationView<TCtx>` directly.
 */
export interface SpawnHookCtxFields {
  readonly channelName: string;
  readonly participant?: string;
  readonly qualifier?: string;
  readonly channel: AgentChannel;
}

/**
 * Resolve a `<cast:query target="...">` value to a canonical bus address.
 * Accepts three documented forms:
 *   - "agent:alias"  — explicit prefix; resolved via label lookup
 *   - "alias"        — bare alias; resolved via boundary resolver
 *   - "a:guid@idp"   — already canonical; passes through
 * Returns the original input if no entity is registered (downstream lookup
 * then misses loudly — same as the alias-not-registered ACL case).
 */
function resolveAgentAddress(bus: Bus, addr: string): string {
  if (addr.startsWith('agent:')) {
    return bus.resolveByLabel(addr.slice('agent:'.length)) ?? addr;
  }
  return bus.resolveAddress(addr) ?? addr;
}

function handleSessionId(
  deps: SpawnHookDeps,
  conv: ConversationView<SpawnHookCtxFields>,
  sessionId: string,
): void {
  const ctx = expectCtx(conv);
  const existing = deps.store.getActiveConversation(conv.key);
  if (existing) {
    deps.store.updateCcSessionId(conv.key, sessionId);
  } else {
    deps.store.upsertConversation(conv.key, {
      channelName: ctx.channelName,
      participant: ctx.participant ?? null,
      qualifier: ctx.qualifier ?? null,
      ccSessionId: sessionId,
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      ttl: ctx.channel.idle_timeout,
      status: 'active',
      summary: null,
    });
  }
}

/** Push framework-injected feedback (ACL rejection, validation hint,
 *  lifecycle notice) back into the conversation. `kind: 'system'` keeps the
 *  streamer on its current streamId so retry seals update the same bubble. */
function deliverSystem(conv: ConversationView<SpawnHookCtxFields>, text: string): void {
  void conv.deliver(text, { kind: 'system' });
}

function expectCtx(conv: ConversationView<SpawnHookCtxFields>): SpawnHookCtxFields {
  const ctx = conv.ctx;
  if (ctx === undefined) {
    throw new Error(
      `agent-spawn-hooks: missing ctx on conversation ${conv.scope}/${conv.key}`,
    );
  }
  return ctx;
}

/** Silent-deny ACL gate for preview frames — same `o`-bit check as
 *  `handleOutboundOutput` but skips the `systemUndelivered` notice on deny.
 *  The eventual seal fires the notice once if still denied. */
function handleOutboundPreview(
  deps: SpawnHookDeps,
  pkt: PreviewPkt,
  channel: string,
  conversationKey: string,
): void {
  if (pkt.to === deps.agentId) return;
  const { bits } = checkAcl(deps.bus, deps.folder, pkt.to, channel);
  if (!hasBit(bits, 'o')) return;
  void deps.bus.routeMessage(pkt.from, pkt.to, { pkt, channel, conversationKey });
}

async function handleOutboundOutput(
  deps: SpawnHookDeps,
  conv: ConversationView<SpawnHookCtxFields>,
  pkt: ConversationPkt,
  channel: string,
  conversationKey: string,
): Promise<void> {
  // Self-addressed: output has no external recipient (e.g. service-initiated work).
  if (pkt.to === deps.agentId) return;

  const { bits } = checkAcl(deps.bus, deps.folder, pkt.to, channel);
  if (!hasBit(bits, 'o')) {
    logger.info(
      { agentFolder: deps.folder, to: pkt.to },
      'Outbound message blocked (ACL — no o bit)',
    );
    // Three rejection shapes, in priority order:
    //   1. Peer-channel contract is structured-only (a/q/r) — render it via
    //      channel-contract so the agent sees the exact envelopes that *are*
    //      deliverable here. This is the case that produces the loop bug
    //      when the agent emits prose alongside a valid envelope; the
    //      contract block in the prompt teaches the contract up-front and
    //      this rejection echoes the same vocabulary.
    //   2. Peer not in ACL — "stop addressing this peer."
    //   3. Peer in ACL but no `o` anywhere — read-only contact.
    //   4. Peer in ACL with `o` on other channels — redirect.
    // Keep aligned with `renderContractForPrompt` in `auth/channel-contract.ts`.
    const contract = deriveChannelContract(bits);
    const hasAnyStructured =
      contract.send.query || contract.send.request || contract.receive.structuredInbound;
    let detail: string;
    if (hasAnyStructured) {
      detail = renderContractForRejection(contract);
    } else {
      const peerChannels = getPeerChannels(deps.bus, deps.folder, pkt.to);
      const sendChannels = peerChannels
        ?.filter((c) => c.bits.includes('o'))
        .map((c) => c.name) ?? [];
      detail = peerChannels === undefined
        ? `${pkt.to} is not in your ACL — do not retry, this contact is not authorized for outbound from this agent`
        : sendChannels.length === 0
          ? `no outbound conversation is permitted to ${pkt.to} on any channel — this contact path is not authorized; do not retry`
          : `no outbound conversation on channel "${channel}" — you can send to ${pkt.to} on: ${sendChannels.join(', ')}`;
    }
    deliverSystem(
      conv,
      systemUndelivered(
        `Message to ${pkt.to} was not delivered. ${detail}`,
        pkt.text,
        deps.getTimezone(),
      ),
    );
    return;
  }
  await deps.bus.routeMessage(pkt.from, pkt.to, {
    pkt,
    channel,
    conversationKey,
  });
}

async function handleOutboundRequest(
  deps: SpawnHookDeps,
  conv: ConversationView<SpawnHookCtxFields>,
  kind: 'query' | 'request',
  rawTarget: string,
  channel: string,
  text: string,
  qualifier?: string,
): Promise<void> {
  const target = resolveAgentAddress(deps.bus, rawTarget);
  const ctx = expectCtx(conv);
  const participant = ctx.participant ?? deps.agentId;
  const verbCap = kind === 'query' ? 'Query' : 'Request';

  const rejectRequest = (reason: string) => {
    deps.agentDb.recordOutboundRequest({
      requestId: generateId('req'),
      targetAgent: target,
      targetChannel: channel,
      channel: ctx.channelName,
      participant,
      status: 'rejected',
    });
    deliverSystem(
      conv,
      systemUndelivered(
        `${verbCap} to ${rawTarget} was not delivered (${reason}).`,
        text,
        deps.getTimezone(),
      ),
    );
  };

  // Gate by exact wire-format kind: `<cast:query>` requires `q`,
  // `<cast:request>` requires `r`. The two are distinct sender-side rights
  // (see acl.ts: query expects an answer back, request is fire-and-forget).
  // A `q`-only agent that emits `<cast:request>` is asking for a permission
  // it doesn't hold — caught here so it bounces with a precise reason
  // rather than slipping through under a combined gate.
  const requiredBit: 'q' | 'r' = kind === 'query' ? 'q' : 'r';
  const { bits } = checkAcl(deps.bus, deps.folder, target, channel);
  if (!hasBit(bits, requiredBit)) {
    logger.info(
      { agentFolder: deps.folder, target, channel, kind, requiredBit },
      `Outbound ${kind} blocked (ACL — no ${requiredBit} bit)`,
    );
    const peerChannels = getPeerChannels(deps.bus, deps.folder, target);
    const reachableChannels = peerChannels
      ?.filter((c) => c.bits.includes(requiredBit))
      .map((c) => c.name) ?? [];
    const detail = peerChannels === undefined
      ? `${rawTarget} is not in your ACL`
      : reachableChannels.length === 0
        ? `no \`${requiredBit}\` bit for ${rawTarget} on any channel`
        : `no \`${requiredBit}\` bit on channel "${channel}" — you can ${kind} ${rawTarget} on: ${reachableChannels.join(', ')}`;
    rejectRequest(detail);
    return;
  }

  const handler = deps.bus.resolve(target);
  if (!handler) {
    logger.warn(
      { agentFolder: deps.folder, target: rawTarget },
      'Request target not found on bus',
    );
    rejectRequest('agent not found');
    return;
  }

  const upstreamSet = computeUpstreamSet(
    deps.agentDb,
    deps.agentId,
    ctx.channelName,
    participant,
  );
  if (upstreamSet.has(target)) {
    logger.info(
      {
        agentFolder: deps.folder,
        target: rawTarget,
        upstreamSet: [...upstreamSet],
      },
      'Outbound request blocked (cycle detected)',
    );
    rejectRequest('would create a cycle');
    return;
  }

  const requestId = generateId('req');
  deps.agentDb.recordOutboundRequest({
    requestId,
    targetAgent: target,
    targetChannel: channel,
    channel: ctx.channelName,
    participant,
  });

  // Fire-and-forget: awaiting would deadlock the sender's outputChain.
  deps.bus
    .routeMessage(deps.agentId, target, {
      type: 'request' as const,
      kind,
      text,
      requestId,
      channel,
      returnToAgent: deps.agentId,
      returnToChannel: ctx.channelName,
      returnToParticipant: participant,
      returnToQualifier: ctx.qualifier,
      upstreamSet: [...upstreamSet],
      routing: { channel, qualifier },
    })
    .catch((err) => {
      logger.error(
        { agentFolder: deps.folder, target, requestId, kind, err },
        `Outbound ${kind} routing failed`,
      );
    });
  logger.info(
    { agentFolder: deps.folder, target, requestId, channel, kind },
    `Outbound ${kind} sent`,
  );
}

async function handleOutboundResponse(
  deps: SpawnHookDeps,
  requestId: string,
  text: string,
): Promise<void> {
  const req = deps.agentDb.getInboundRequest(requestId);
  if (!req || req.status !== 'open') {
    logger.warn(
      { agentFolder: deps.folder, requestId },
      'Response for unknown or closed request — dropped',
    );
    return;
  }

  deps.agentDb.updateRequestStatus('inbound', requestId, 'fulfilled');

  // Fire-and-forget: awaiting would deadlock the sender's outputChain.
  deps.bus
    .routeMessage(deps.agentId, req.return_to_agent, {
      type: 'response' as const,
      text,
      requestId,
      originChannel: req.return_to_channel,
      originParticipant: req.return_to_participant,
      originQualifier: req.return_to_qualifier ?? undefined,
      routing: {
        channel: req.return_to_channel,
        qualifier: req.return_to_qualifier ?? undefined,
        replyTo: req.return_to_participant,
      },
    })
    .catch((err) => {
      logger.error(
        { agentFolder: deps.folder, requestId, err },
        'Response routing failed',
      );
    });
  logger.info(
    { agentFolder: deps.folder, requestId, target: req.return_to_agent },
    'Response routed',
  );
}

/** Build the SpawnHooks for a single Conversation spawn cycle, reading
 *  per-conversation context directly from the typed `ConversationView`.
 *  J.6e — replaces the duck-typed `SpawnHookCtx` shim with a typed view
 *  parameter; hosts pass `conv` straight through from
 *  `BuildSpawnHooks<TCtx>`. The `TCtx extends SpawnHookCtxFields`
 *  constraint type-checks at the call site. */
export function buildSpawnHooks<TCtx extends SpawnHookCtxFields>(
  deps: SpawnHookDeps,
  conv: ConversationView<TCtx>,
): SpawnHooks {
  // Internally the helpers consume the structural-fields view; widen the
  // typed view once at the boundary.
  const fc = conv as unknown as ConversationView<SpawnHookCtxFields>;
  return {
    onSessionId: (id) => handleSessionId(deps, fc, id),
    onOutput: (pkt, ch, key) =>
      handleOutboundOutput(deps, fc, pkt, ch, key),
    onPreview: (pkt, ch, key) =>
      handleOutboundPreview(deps, pkt, ch, key),
    onTyping: (evt) => deps.bus.routeEvent(evt),
    onLifecycle: (phase, active, extras) => {
      const ctx = fc.ctx;
      if (!ctx || !ctx.participant) return;
      deps.bus.routeEvent({
        from: deps.agentId,
        to: ctx.participant,
        type: 'lifecycle',
        data: buildLifecycleEvtData(phase, active, ctx.channelName, extras),
      });
    },
    onRequest: (kind, target, ch, text, qualifier) =>
      handleOutboundRequest(deps, fc, kind, target, ch, text, qualifier),
    onResponse: (id, text) => handleOutboundResponse(deps, id, text),
    logEvent: (level, component, eventName, message, opts) =>
      deps.agentDb.logEvent(level, component, eventName, message, opts),
  };
}
